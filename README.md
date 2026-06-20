# Claude Code Control — VSD Craft plugin

Drive [Claude Code](https://claude.com/claude-code) from a **VSD Craft** macro device
(StreamDock / MiraBox). Map slash commands, *Interrupt*, *Toggle mode*, session-tab
switching, and a session dial to your buttons and knobs.

## How it works

VSD Craft launches plugins as Node subprocesses using its bundled
`node20` runtime and talks to them over the Elgato/StreamDock WebSocket protocol.
This plugin listens for button/dial events and injects the matching keystrokes into
your **focused terminal** via macOS `osascript` + System Events. No native modules,
no extra daemon — it runs entirely inside VSD Craft.

```
VSD Craft  ──WebSocket──▶  plugin/index.js (node20)  ──osascript──▶  Terminal running Claude Code
   button press                dispatch + map                 keystroke
```

## Actions

| Action | Controller | What it does |
|---|---|---|
| **Send Command** | key | Types a slash command / prompt (e.g. `/clear`, `/compact`, `/model opus`, `/resume`) and optionally presses Enter. Pre-clear the line with Ctrl+U if you like. |
| **Send Key** | key | One control key: **Interrupt** (Esc), Submit, **Toggle mode** (Shift+Tab → auto-accept / plan), Approve / option 1·2·3, Reject, New line, History ↑/↓, Edit-previous (Esc Esc), Quit (Ctrl+C), and prompt shortcuts `!` `#` `@`. |
| **Switch Session** | key | Jump to terminal **tab 1–9** (Cmd+N) or cycle next/prev (Cmd+Shift+]/[). Keep one Claude Code session per tab. |
| **Session Dial** | knob | Rotate to scrub input history / switch tabs / scroll; press to Interrupt (or Submit / Toggle mode). Clockwise = next / down. |

A **Target terminal** selector in every action's settings chooses where keystrokes go.
Default **Frontmost app** sends to whatever window has focus — best when you keep Claude
Code on screen. You can also pin it to iTerm2, Terminal, VS Code, Cursor, Ghostty, Warp,
kitty, or Alacritty.

## Install

```bash
./install.sh
```

This copies the plugin to
`~/Library/Application Support/HotSpot/StreamDock/plugins/` and installs the one
JS dependency (`ws`).

Then:

1. **Quit VSD Craft completely** (menu bar → Quit) and reopen it, so it loads the new plugin.
2. Grant permission so keystrokes can be sent:
   **System Settings → Privacy & Security → Accessibility → enable “VSD Craft.”**
   The first time a button fires you may also get an **Automation** prompt to allow VSD
   Craft to control your terminal / System Events — click **OK**.
3. In VSD Craft, open the **Claude Code** category and drag actions onto keys and dials.

> Without the Accessibility grant, button presses do nothing (System Events keystrokes are
> blocked by macOS). This is the one required manual step.

## Suggested layout for the pictured device (6 keys + dials + 3 buttons)

| Key | Action | Setting |
|---|---|---|
| 1 | Send Key | **Interrupt** (Esc) — your panic button |
| 2 | Send Key | **Toggle mode** (auto-accept ⇄ plan) |
| 3 | Send Command | `/clear` |
| 4 | Send Command | `/compact` |
| 5 | Send Command | `/model` (Press Enter off, so you can pick) |
| 6 | Send Key | **Approve** (Enter) |
| Big dial | Session Dial | rotate = history, press = Interrupt |
| Small dials | Session Dial | rotate = switch tabs |
| Bottom buttons | Switch Session | tabs 1 / 2 / 3 |

## Notes & tuning

- **Tabs:** Cmd+number and Cmd+Shift+]/[ are tuned for **iTerm2** and **Terminal.app**.
  In VS Code, terminal tabs don't use Cmd+number — use the dial in "switch tabs" mode or
  remap inside the source if you want VS Code-specific bindings.
- **New line** uses Shift+Enter. If your terminal uses Option+Enter instead, change
  `newline` in `plugin/index.js` (`KEY_BODY`) to `key code 36 using option down`.
- **Logs:** `plugin/log/plugin.log` inside the installed plugin folder. Set the env var
  `CLAUDE_VSD_DRYRUN=1` to log the AppleScript instead of executing it.

## Develop / test

```bash
node tools/gen-icons.js                 # regenerate the action icons
node tools/test-protocol.js             # mock-host protocol tests (dry-run, no keystrokes)
# run the tests against the app's bundled node:
PLUGIN_NODE="/Applications/VSD Craft.app/Contents/Helpers/node20" \
  NODE_PATH=com.sandeep.claudecode.sdPlugin/plugin/node_modules \
  node tools/test-protocol.js
```

After editing files, re-run `./install.sh` and restart VSD Craft.

## Layout

```
com.sandeep.claudecode.sdPlugin/
  manifest.json            # 4 actions, node20 runtime
  en.json
  plugin/
    index.js               # WS protocol + dispatch + keystroke engine (osascript)
    package.json
    node_modules/ws        # vendored
  propertyInspector/
    shared/{pi.js,pi.css}  # PI bridge + styles + Target-terminal selector
    command/ key/ tab/ dial/index.html
  static/*.png             # action-picker icons (device keys render live SVG)
install.sh
tools/{gen-icons.js,test-protocol.js}
```
