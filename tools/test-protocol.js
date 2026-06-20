#!/usr/bin/env node
/**
 * Mock VSD Craft host: stands up a WebSocket server, launches the plugin the
 * same way the app does (-port/-pluginUUID/-registerEvent/-info), then drives
 * willAppear / keyDown / dialRotate / didReceiveSettings and asserts the plugin
 * registers, renders key images, fires confirmations, and produces the right
 * AppleScript (captured via CLAUDE_VSD_DRYRUN). No real keystrokes are sent.
 */
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PLUGIN = path.join(__dirname, '..', 'com.sandeep.claudecode.sdPlugin', 'plugin', 'index.js');
const LOG = path.join(__dirname, '..', 'com.sandeep.claudecode.sdPlugin', 'log', 'plugin.log');
try { fs.unlinkSync(LOG); } catch (_) {}

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅', m); };
const no = (m) => { fail++; console.log('  ❌', m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PLUGIN_UUID = 'com.sandeep.claudecode';
const wss = new WebSocketServer({ port: 0 }, () => {
  const port = wss.address().port;
  console.log('mock host listening on', port);

  const info = JSON.stringify({ application: { language: 'en', platform: 'mac' } });
  const NODE = process.env.PLUGIN_NODE || process.execPath;
  const child = spawn(NODE, [
    PLUGIN, '-port', String(port), '-pluginUUID', PLUGIN_UUID,
    '-registerEvent', 'registerPlugin', '-info', info,
  ], { env: { ...process.env, CLAUDE_VSD_DRYRUN: '1' }, stdio: 'inherit' });

  child.on('exit', c => console.log('plugin exited', c));

  wss.on('connection', async (ws) => {
    const inbox = [];
    ws.on('message', d => inbox.push(JSON.parse(d.toString())));
    const waitFor = async (pred, label, ms = 1500) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await sleep(20);
      }
      no('timeout waiting for ' + label);
      return null;
    };
    const send = (o) => ws.send(JSON.stringify(o));
    const ctx = (n) => 'ctx-' + n;

    // 1. registration
    const reg = await waitFor(m => m.event === 'registerPlugin', 'registerPlugin');
    if (reg && reg.uuid === PLUGIN_UUID) ok('registers with correct uuid'); else no('registration');

    // global settings request on connect
    if (await waitFor(m => m.event === 'getGlobalSettings', 'getGlobalSettings')) ok('requests global settings');
    send({ event: 'didReceiveGlobalSettings', payload: { settings: { targetApp: 'iterm' } } });

    // 2. command button appears -> expect setImage
    inbox.length = 0;
    send({ event: 'willAppear', action: 'com.sandeep.claudecode.command', context: ctx('cmd'),
      payload: { settings: { text: '/compact', pressEnter: true, clearFirst: false } } });
    const img = await waitFor(m => m.event === 'setImage' && m.context === ctx('cmd'), 'command setImage');
    if (img && /svg/.test(decodeURIComponent(img.payload.image))) ok('renders SVG key image on appear'); else no('command image');

    // 3. command keyDown -> dry-run should type "/compact" + Enter, and showOk
    inbox.length = 0;
    const beforeLog = readLog();
    send({ event: 'keyDown', action: 'com.sandeep.claudecode.command', context: ctx('cmd'),
      payload: { settings: { text: '/compact', pressEnter: true } } });
    await sleep(250);
    const cmdLog = readLog().slice(beforeLog.length);
    if (/DRYRUN/.test(cmdLog) && /\/compact/.test(cmdLog) && /key code 36/.test(cmdLog))
      ok('command types text + Enter (key code 36)'); else no('command keystroke body');
    if (cmdLog.includes('"app":"iTerm"')) ok('honors global targetApp = iTerm'); else no('targetApp routing');
    if (await waitFor(m => m.event === 'showOk' && m.context === ctx('cmd'), 'command showOk')) ok('flashes OK after command');

    // 4. key action: interrupt -> Esc (key code 53)
    let b = readLog().length;
    send({ event: 'keyDown', action: 'com.sandeep.claudecode.key', context: ctx('key'),
      payload: { settings: { keyAction: 'interrupt' } } });
    await sleep(150);
    if (/key code 53/.test(readLog().slice(b))) ok('interrupt sends Esc (key code 53)'); else no('interrupt');

    // 5. toggle mode -> Shift+Tab (key code 48 using shift down)
    b = readLog().length;
    send({ event: 'keyDown', action: 'com.sandeep.claudecode.key', context: ctx('key2'),
      payload: { settings: { keyAction: 'toggleMode' } } });
    await sleep(150);
    if (/key code 48 using shift down/.test(readLog().slice(b))) ok('toggle mode sends Shift+Tab'); else no('toggleMode');

    // 6. tab jump number 3 -> Cmd+3
    b = readLog().length;
    send({ event: 'keyDown', action: 'com.sandeep.claudecode.tab', context: ctx('tab'),
      payload: { settings: { mode: 'number', tabNumber: 3 } } });
    await sleep(150);
    if (/keystroke \\"3\\" using command down|keystroke "3" using command down/.test(readLog().slice(b)))
      ok('tab jump sends Cmd+3'); else no('tab number');

    // 7. dial rotate clockwise in history mode -> Down (key code 125), capped repeat
    b = readLog().length;
    send({ event: 'dialRotate', action: 'com.sandeep.claudecode.dial', context: ctx('dial'),
      payload: { settings: { rotateAction: 'history' }, ticks: 2 } });
    await sleep(150);
    const rotLog = readLog().slice(b);
    if (/key code 125/.test(rotLog) && /repeat 2 times/.test(rotLog)) ok('dial CW = Down x2 (history)'); else no('dialRotate');

    // 8. dial press -> interrupt (Esc)
    b = readLog().length;
    send({ event: 'dialDown', action: 'com.sandeep.claudecode.dial', context: ctx('dial'),
      payload: { settings: { pressAction: 'interrupt' } } });
    await sleep(150);
    if (/key code 53/.test(readLog().slice(b))) ok('dial press = interrupt'); else no('dialDown');

    // 9. didReceiveSettings re-renders
    inbox.length = 0;
    send({ event: 'didReceiveSettings', action: 'com.sandeep.claudecode.command', context: ctx('cmd'),
      payload: { settings: { text: '/model opus' } } });
    if (await waitFor(m => m.event === 'setImage' && m.context === ctx('cmd'), 'rerender setImage'))
      ok('re-renders on settings change'); else no('didReceiveSettings render');

    console.log(`\n${pass} passed, ${fail} failed`);
    child.kill();
    wss.close();
    process.exit(fail ? 1 : 0);
  });
});

function readLog() { try { return fs.readFileSync(LOG, 'utf8'); } catch (_) { return ''; } }
