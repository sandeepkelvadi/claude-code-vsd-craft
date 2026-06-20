/**
 * Claude Code Control — VSD Craft (StreamDock/MiraBox) plugin.
 *
 * Runs as a Node subprocess launched by VSD Craft (Contents/Helpers/node20).
 * Speaks the Elgato/StreamDock plugin WebSocket protocol and turns button /
 * dial events into keystrokes delivered to the focused Claude Code terminal
 * via macOS `osascript` + System Events.
 *
 * No native modules — keystroke injection is pure AppleScript, so it runs on
 * the app's bundled node with zero build step.
 */
'use strict';

const WebSocket = require('ws');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, '..', 'log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
const LOG_FILE = path.join(LOG_DIR, 'plugin.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x =>
    typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}
process.on('uncaughtException', e => log('uncaughtException', e.stack || String(e)));
process.on('unhandledRejection', e => log('unhandledRejection', String(e)));

// ---------------------------------------------------------------------------
// launch args (order-independent)
// ---------------------------------------------------------------------------
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const PORT = argOf('-port');
const PLUGIN_UUID = argOf('-pluginUUID');
const REGISTER_EVENT = argOf('-registerEvent') || 'registerPlugin';
let appInfo = {};
try { appInfo = JSON.parse(argOf('-info') || '{}'); } catch (_) {}

log('starting', { PORT, PLUGIN_UUID, REGISTER_EVENT, node: process.version });

if (!PORT) { log('no -port supplied, exiting'); process.exit(1); }

// ---------------------------------------------------------------------------
// macOS keystroke engine
// ---------------------------------------------------------------------------

// friendly target-app value  ->  AppleScript application name
const APP_NAMES = {
  frontmost: 'Frontmost',
  iterm: 'iTerm',
  terminal: 'Terminal',
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  warp: 'Warp',
  ghostty: 'Ghostty',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  windowsterminal: 'Frontmost', // (windows handled separately if ever ported)
};

const isMac = os.platform() === 'darwin';

let globalSettings = { targetApp: 'frontmost' };
function targetAppName() {
  return APP_NAMES[(globalSettings.targetApp || 'frontmost')] || 'Frontmost';
}

function execFileP(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) log('exec error', cmd, stderr || err.message);
      resolve({ err, stdout, stderr });
    });
  });
}

/**
 * Run a System Events action body against the configured target app.
 * `body` is trusted AppleScript (built from our own maps, never user text).
 * Dynamic user data is passed as positional args -> `item N of argv`.
 */
function sysEvents(body, args = []) {
  if (!isMac) { log('keystroke skipped: non-mac platform'); return Promise.resolve(); }
  if (process.env.CLAUDE_VSD_DRYRUN === '1') {
    log('DRYRUN sysEvents', { app: targetAppName(), body: body.trim(), args });
    return Promise.resolve({ dry: true });
  }
  const script =
`on run argv
  set _app to item 1 of argv
  if _app is not "Frontmost" then
    try
      tell application _app to activate
    end try
    delay 0.06
  end if
  tell application "System Events"
${body}
  end tell
end run`;
  return execFileP('osascript', ['-e', script, targetAppName(), ...args]);
}

// type a literal string (passed safely as argv item 2), with optional pre-clear
// and trailing Enter.
function typeText(text, { clearFirst = false, pressEnter = false } = {}) {
  let body = '';
  if (clearFirst) body += '    keystroke "u" using control down\n    delay 0.03\n';
  body += '    keystroke (item 2 of argv)\n';
  if (pressEnter) body += '    delay 0.03\n    key code 36\n';
  return sysEvents(body, [String(text == null ? '' : text)]);
}

// named single key / chord actions for the "Send Key" + dial press
const KEY_BODY = {
  submit:       '    key code 36',                          // Enter
  interrupt:    '    key code 53',                          // Esc
  escape:       '    key code 53',                          // Esc
  toggleMode:   '    key code 48 using shift down',         // Shift+Tab (cycle modes)
  approve:      '    key code 36',                          // Enter (accept default)
  option1:      '    keystroke "1"',
  option2:      '    keystroke "2"',
  option3:      '    keystroke "3"',
  reject:       '    key code 53',                          // Esc
  newline:      '    key code 36 using shift down',         // Shift+Enter (multiline)
  historyPrev:  '    key code 126',                         // Up
  historyNext:  '    key code 125',                         // Down
  clearLine:    '    keystroke "u" using control down',     // Ctrl+U
  quit:         '    keystroke "c" using control down',     // Ctrl+C
  bashMode:     '    keystroke "!"',                         // ! toggles bash mode
  memorize:     '    keystroke "#"',                         // # memory shortcut
  fileMention:  '    keystroke "@"',                         // @ file picker
  doubleEsc:    '    key code 53\n    delay 0.04\n    key code 53', // edit previous
};
function sendKey(name) {
  const body = KEY_BODY[name];
  if (!body) { log('unknown keyAction', name); return Promise.resolve(); }
  return sysEvents(body);
}

// tab switching
function switchTab(mode, n) {
  if (mode === 'next') return sysEvents('    key code 30 using {command down, shift down}'); // Cmd+Shift+]
  if (mode === 'prev') return sysEvents('    key code 33 using {command down, shift down}'); // Cmd+Shift+[
  const num = Math.max(1, Math.min(9, parseInt(n, 10) || 1));
  return sysEvents(`    keystroke "${num}" using command down`); // Cmd+N
}

// dial rotation -> repeated key, capped
function rotateKey(keyBody, ticks) {
  const n = Math.max(1, Math.min(6, Math.abs(parseInt(ticks, 10) || 1)));
  const body = `    repeat ${n} times\n${keyBody}\n      delay 0.01\n    end repeat`;
  return sysEvents(body);
}

// ---------------------------------------------------------------------------
// WebSocket protocol layer
// ---------------------------------------------------------------------------
let ws;
const settingsByCtx = {};   // context -> per-button settings
const actionByCtx = {};     // context -> action UUID

function send(obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { log('send failed', String(e)); }
}
const api = {
  setTitle: (context, title) =>
    send({ event: 'setTitle', context, payload: { target: 0, title: String(title) } }),
  setImage: (context, image) =>
    send({ event: 'setImage', context, payload: { target: 0, image } }),
  setState: (context, state) =>
    send({ event: 'setState', context, payload: { state } }),
  showOk: context => send({ event: 'showOk', context }),
  showAlert: context => send({ event: 'showAlert', context }),
  getGlobalSettings: () => send({ event: 'getGlobalSettings', context: PLUGIN_UUID }),
  setGlobalSettings: payload => send({ event: 'setGlobalSettings', context: PLUGIN_UUID, payload }),
};

// ---------------------------------------------------------------------------
// live key rendering (SVG -> setImage)
// ---------------------------------------------------------------------------
const ACCENT = {
  'com.sandeep.claudecode.command': '#d97757',
  'com.sandeep.claudecode.key': '#78aaff',
  'com.sandeep.claudecode.tab': '#82c88c',
  'com.sandeep.claudecode.dial': '#c896f0',
};
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function keyImage(action, glyph, caption) {
  const accent = ACCENT[action] || '#d97757';
  const cap = esc((caption || '').slice(0, 14));
  const svg =
`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
  <rect x="4" y="4" width="136" height="136" rx="22" fill="#18181b"/>
  <rect x="4" y="4" width="136" height="9" rx="4" fill="${accent}"/>
  <text x="72" y="78" font-family="Helvetica,Arial" font-size="48" font-weight="700"
        fill="#f4f4f5" text-anchor="middle">${esc(glyph)}</text>
  <text x="72" y="120" font-family="Helvetica,Arial" font-size="19" font-weight="600"
        fill="${accent}" text-anchor="middle">${cap}</text>
</svg>`;
  return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
}

// short human labels
const KEY_META = {
  submit: ['⏎', 'Submit'], interrupt: ['⎋', 'Interrupt'], escape: ['⎋', 'Escape'],
  toggleMode: ['⇧⇥', 'Mode'], approve: ['✓', 'Approve'],
  option1: ['1', 'Option 1'], option2: ['2', 'Option 2'], option3: ['3', 'Option 3'],
  reject: ['✕', 'Reject'], newline: ['↵', 'Newline'],
  historyPrev: ['↑', 'History'], historyNext: ['↓', 'History'],
  clearLine: ['⌫', 'Clear'], quit: ['⏻', 'Quit'],
  bashMode: ['!', 'Bash'], memorize: ['#', 'Memory'], fileMention: ['@', 'File'],
  doubleEsc: ['⎋⎋', 'Edit prev'],
};

function renderKey(context) {
  const action = actionByCtx[context];
  const s = settingsByCtx[context] || {};
  if (action === 'com.sandeep.claudecode.command') {
    const t = (s.text || '').trim() || '/clear';
    const cap = t.startsWith('/') ? t.split(' ')[0] : t;
    api.setImage(context, keyImage(action, '›_', cap));
  } else if (action === 'com.sandeep.claudecode.key') {
    const [g, c] = KEY_META[s.keyAction] || ['⎋', 'Interrupt'];
    api.setImage(context, keyImage(action, g, c));
  } else if (action === 'com.sandeep.claudecode.tab') {
    if (s.mode === 'next') api.setImage(context, keyImage(action, '»', 'Next'));
    else if (s.mode === 'prev') api.setImage(context, keyImage(action, '«', 'Prev'));
    else api.setImage(context, keyImage(action, String(s.tabNumber || 1), 'Session'));
  } else if (action === 'com.sandeep.claudecode.dial') {
    api.setImage(context, keyImage(action, '◉', 'Dial'));
  }
}

// ---------------------------------------------------------------------------
// event handlers, keyed by action segment then event name
// ---------------------------------------------------------------------------
function settle(context) {
  // brief success flash
  api.showOk(context);
}

// freshest settings: prefer the event's own payload (kept in sync by the app),
// fall back to the cache populated on willAppear / didReceiveSettings.
function freshSettings(data) {
  if (data.payload && data.payload.settings) {
    settingsByCtx[data.context] = data.payload.settings;
  }
  return settingsByCtx[data.context] || {};
}

const handlers = {
  command: {
    keyDown(data) {
      const s = freshSettings(data);
      typeText(s.text || '', {
        clearFirst: !!s.clearFirst,
        pressEnter: s.pressEnter !== false,
      }).then(() => settle(data.context));
    },
  },
  key: {
    keyDown(data) {
      const s = freshSettings(data);
      sendKey(s.keyAction || 'interrupt').then(() => settle(data.context));
    },
  },
  tab: {
    keyDown(data) {
      const s = freshSettings(data);
      switchTab(s.mode || 'number', s.tabNumber).then(() => settle(data.context));
    },
  },
  dial: {
    keyDown(data) { // also fires when a dial action is placed on a key
      const s = freshSettings(data);
      sendKey(s.pressAction || 'interrupt');
    },
    dialDown(data) {
      const s = freshSettings(data);
      sendKey(s.pressAction || 'interrupt');
    },
    dialRotate(data) {
      const { context, payload } = data;
      const s = freshSettings(data);
      const ticks = payload && (payload.ticks ?? payload.rotation ?? 1);
      const cw = ticks >= 0;
      const mode = s.rotateAction || 'history';
      if (mode === 'tabs') {
        switchTab(cw ? 'next' : 'prev');
      } else if (mode === 'scroll') {
        rotateKey(cw ? '      key code 125' : '      key code 126', ticks); // arrows
      } else { // history
        rotateKey(cw ? '      key code 125' : '      key code 126', ticks);
      }
    },
    touchTap(data) {
      const s = freshSettings(data);
      sendKey(s.pressAction || 'interrupt');
    },
  },
};

// shared lifecycle for every action (settings + rendering)
function onAppear(data) {
  actionByCtx[data.context] = data.action;
  settingsByCtx[data.context] = (data.payload && data.payload.settings) || {};
  renderKey(data.context);
}
function onSettings(data) {
  settingsByCtx[data.context] = (data.payload && data.payload.settings) || {};
  renderKey(data.context);
}
function onDisappear(data) {
  delete settingsByCtx[data.context];
  delete actionByCtx[data.context];
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------
function connect() {
  ws = new WebSocket('ws://127.0.0.1:' + PORT);

  ws.on('open', () => {
    send({ event: REGISTER_EVENT, uuid: PLUGIN_UUID });
    api.getGlobalSettings();
    log('registered');
  });

  ws.on('close', () => { log('ws closed, exiting'); process.exit(0); });
  ws.on('error', e => log('ws error', String(e)));

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }
    const ev = data.event;

    if (ev === 'didReceiveGlobalSettings') {
      globalSettings = Object.assign({ targetApp: 'frontmost' },
        (data.payload && data.payload.settings) || {});
      log('globalSettings', globalSettings);
      return;
    }

    // lifecycle (per-context settings + live rendering)
    if (ev === 'willAppear') onAppear(data);
    else if (ev === 'didReceiveSettings') onSettings(data);
    else if (ev === 'willDisappear') onDisappear(data);

    // dispatch to the action-specific handler
    const seg = data.action ? data.action.split('.').pop() : null;
    const h = seg && handlers[seg] && handlers[seg][ev];
    if (h) {
      try { h(data); } catch (e) { log('handler error', seg, ev, String(e)); }
    }
  });
}

connect();
