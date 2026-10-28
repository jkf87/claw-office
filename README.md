# Claw Office

This OpenClaw feature plugin includes a typed draft-analysis operation, a model tool, a native page, and a composer replacement. The browser entry owns its DOM and uses the host's canonical draft and send operations.

## Build and install

```sh
npm install
npm run build
npm run validate
openclaw plugins install .
```

Installation applies the plugin in the running local Gateway. If the Gateway is stopped, start it to load the saved installation.

For native UI, enable **Settings > Labs > Custom plugin UI** (`gateway.controlUi.experimental.customPlugins: true`), then restart the Gateway and reload the browser tab. This setting is off by default; backend installation does not require it.

Select Claw Office in the Control UI sidebar. Open **Plugins > Customize UI** and choose Draft composer to try the replacement; choose Built-in to restore it.

For agent-requested activation, run `npm run pack`. The receipt contains the exact archive path and SHA-256 digest for `plugin_activate_artifact`. Approval applies to those bundled bytes and does not enable Custom plugin UI. The archive has no install scripts or package dependencies; backend activation applies through the running Gateway.

After browser-only changes, run the build again and use **Plugins > Customize UI > Reload plugin UI** as an administrator. After editing installed backend source, run `openclaw plugins reload claw-office`. Rebuild compiled code before reloading; for a copied installation, reinstall the rebuilt package. Plugin install and update commands apply changes through the running Gateway. Native plugins run trusted code in the Gateway and browser; install only code you trust.

## Paseo (driving Claude Code and Codex from the office)

The office drives Claude Code and Codex sessions through [Paseo](https://paseo.sh), which runs them on each computer. Because Paseo owns the running process, a message typed in the office's conversation panel goes into that same session. The old "continue in terminal" path started a second `claude --resume` process instead. Permission requests come back as data, so they appear in 🔔 and in the panel as buttons.

1. On each computer, install and start Paseo, and sign in to `claude` and `codex` there:
   ```sh
   npm install -g @getpaseo/cli
   paseo daemon start
   paseo provider diagnostic claude   # should find the claude binary
   ```
2. Tell the office which daemons to use in `~/.claw-office/paseo.json` on the Gateway's computer. Without this file it uses only this computer's daemon at `ws://127.0.0.1:6767/ws`.
   ```json
   { "hosts": [
     { "id": "m5", "label": "M5", "url": "ws://127.0.0.1:6767/ws" },
     { "id": "m2max", "label": "M2 Max", "url": "ws://<tailscale-ip>:6767/ws", "password": "<daemon password>" }
   ] }
   ```
   The `id` is the office area where that computer's agents sit (`m5`, `m2max`, `a4000`). Before a remote daemon can take this connection, set `daemon.listen` to its Tailscale address and give it a password, as described in Paseo's connectivity docs.
3. Use it as follows:
   - Click a Paseo worker to open its conversation beside the office.
   - Use **＋ 일 맡기기 → Claude Code · M5 (Paseo)** to start a new session in a folder.
   - Click a session found only in the logs, then choose **Paseo로 가져오기** to import it. After importing, don't also `claude --resume` it in a terminal.
   - The Paseo phone app shows the same sessions.

Keep browser imports on the browser-safe `control-ui` and `feature-contract` SDK entrypoints. Bundle framework dependencies with the plugin. Return a dispose handle for DOM, subscriptions, and other resources; check the view's abort signal after asynchronous work.
