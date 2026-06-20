/* Minimal, robust StreamDock/Elgato Property Inspector bridge.
 * Each PI page defines a global connectElgatoStreamDeckSocket entry that the
 * VSD Craft app calls; this file implements it and exposes a small `PI` API. */
(function () {
  let _ws, _uuid, _action, _ctx;
  let _settings = {};
  let _global = { targetApp: 'frontmost' };
  let _readyCb = null, _globalCb = null;

  const PI = {
    onReady(cb) { _readyCb = cb; if (_ws && _ws.readyState === 1) cb(_settings); },
    onGlobal(cb) { _globalCb = cb; if (_ws) cb(_global); },
    settings() { return _settings; },
    set(key, value) { _settings[key] = value; PI.save(); },
    save() {
      if (!_ws) return;
      _ws.send(JSON.stringify({ event: 'setSettings', context: _uuid, payload: _settings }));
    },
    global() { return _global; },
    setGlobal(key, value) {
      _global[key] = value;
      if (!_ws) return;
      _ws.send(JSON.stringify({ event: 'setGlobalSettings', context: _uuid, payload: _global }));
    },
  };
  window.PI = PI;

  window.connectElgatoStreamDeckSocket = function (port, uuid, event, appInfo, actionInfo) {
    _uuid = uuid;
    try {
      const ai = JSON.parse(actionInfo);
      _action = ai.action; _ctx = ai.context;
      _settings = (ai.payload && ai.payload.settings) || {};
    } catch (e) { /* ignore */ }

    _ws = new WebSocket('ws://127.0.0.1:' + port);
    _ws.onopen = function () {
      _ws.send(JSON.stringify({ event: event, uuid: uuid }));
      _ws.send(JSON.stringify({ event: 'getGlobalSettings', context: uuid }));
      if (_readyCb) _readyCb(_settings);
    };
    _ws.onmessage = function (e) {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d.event === 'didReceiveSettings') {
        _settings = (d.payload && d.payload.settings) || {};
        if (_readyCb) _readyCb(_settings);
      } else if (d.event === 'didReceiveGlobalSettings') {
        _global = Object.assign({ targetApp: 'frontmost' }, (d.payload && d.payload.settings) || {});
        if (_globalCb) _globalCb(_global);
      }
    };
  };

  // Inject the shared "Target terminal" selector into any [data-target-app] host,
  // built with safe DOM APIs (no innerHTML).
  window.mountTargetApp = function () {
    const host = document.querySelector('[data-target-app]');
    if (!host) return;
    const opts = [
      ['frontmost', 'Frontmost app (recommended)'],
      ['iterm', 'iTerm2'], ['terminal', 'Terminal'], ['vscode', 'VS Code'],
      ['cursor', 'Cursor'], ['ghostty', 'Ghostty'], ['warp', 'Warp'],
      ['kitty', 'kitty'], ['alacritty', 'Alacritty'],
    ];
    const field = document.createElement('div'); field.className = 'field';
    const label = document.createElement('label'); label.textContent = 'Target terminal';
    const sel = document.createElement('select'); sel.id = '__targetApp';
    opts.forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
    });
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = 'Where keystrokes are sent. "Frontmost" sends to whatever window has focus — best when you keep Claude Code in view.';
    field.append(label, sel, hint);
    host.appendChild(field);
    PI.onGlobal(function (g) { sel.value = g.targetApp || 'frontmost'; });
    sel.addEventListener('change', function () { PI.setGlobal('targetApp', sel.value); });
  };
})();
