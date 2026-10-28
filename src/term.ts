import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

// The terminal panel beside the office: the Gateway's own operator terminal (terminal.* RPCs, terminal.data
// and terminal.exit events), drawn with xterm.js in tabs. A tab either continues an existing Claude Code,
// Codex, AGY or GJC session from the Gateway's session catalog (terminal.open with its locator), starts a
// new one of those CLIs in a folder (sessions.catalog.startTerminal), opens an OpenClaw agent's TUI, or
// opens a plain shell. Hiding the panel or closing the page only detaches: the Gateway keeps the PTY for
// gateway.terminal.detachedSessionTimeoutSeconds, and an open tab reattaches when the office comes back.

export type CliKind = "claude" | "codex" | "agy" | "gjc";
export interface Locator { catalogId: CliKind; hostId: string; threadId: string }

const KIND_LABEL: Record<CliKind | "openclaw" | "shell", string> = { claude: "Claude Code", codex: "Codex", agy: "AGY", gjc: "GJC", openclaw: "OpenClaw TUI", shell: "셸" };
const STORE = "claw-office:terminals";
const WIDTH_STORE = "claw-office:terminal-width";

interface Tab { sessionId: string; title: string; term: Terminal; fit: FitAddon; el: HTMLElement; tabEl: HTMLElement; ended: boolean; href?: string }
interface Saved { sessionId: string; title: string; href?: string }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface Terminals {
  /** Continues an existing session from the catalog in a new tab (in `cwd`, its folder, trusted first when known). */
  openCatalog(loc: Locator, title: string, href?: string, cwd?: string): Promise<void>;
  /** Starts a fresh CLI, an OpenClaw agent's TUI or a shell in a new tab. */
  openNew(kind: CliKind | "openclaw" | "shell", opts: { cwd?: string; agentId?: string; sessionKey?: string; title?: string }): Promise<void>;
  /** The folder new sessions start in unless told otherwise (the latest session's, as the office learns it). */
  setDefaultCwd(cwd: string): void;
  /** The OpenClaw agents to offer in 「새 터미널」. */
  setAgents(agents: readonly { id: string; name: string; sessionKey?: string }[]): void;
  dispose(): void;
}

export function mountTerminals(root: HTMLElement, host: ControlUiHost, signal: AbortSignal, say: (text: string, bad?: boolean) => void, trust?: (kind: CliKind, cwd: string) => Promise<void>): Terminals {
  const panel = el("aside", "claw-term");
  panel.hidden = true;
  panel.setAttribute("aria-label", "터미널");
  const divider = el("div", "claw-term-divider");
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.tabIndex = 0;
  const head = el("div", "claw-term-head");
  const tabsEl = el("div", "claw-term-tabs");
  tabsEl.setAttribute("role", "tablist");
  const add = el("button", "claw-term-btn", "＋ 새 터미널");
  add.type = "button";
  const hide = el("button", "claw-term-btn", "숨기기");
  hide.type = "button";
  hide.title = "패널만 숨겨요. 터미널은 계속 돌아요.";
  head.append(tabsEl, add, hide);
  const body = el("div", "claw-term-body");
  const menu = el("form", "claw-term-menu");
  menu.hidden = true;
  const kind = el("select");
  kind.setAttribute("aria-label", "무엇을 열까요");
  for (const k of ["claude", "codex", "gjc", "agy", "openclaw", "shell"] as const) kind.append(new Option(KIND_LABEL[k], k));
  const agentSel = el("select");
  agentSel.setAttribute("aria-label", "OpenClaw 에이전트");
  const cwdIn = el("input");
  cwdIn.setAttribute("aria-label", "폴더");
  cwdIn.placeholder = "폴더 (절대 경로)";
  const go = el("button", "claw-term-btn is-primary", "열기");
  go.type = "submit";
  menu.append(kind, agentSel, cwdIn, go);
  // On a phone the terminal's own hidden input loses Korean (the keyboard composes syllables xterm never
  // sees finished), so touch devices get an ordinary input line under it: type there with the phone's own
  // keyboard and send, plus the keys a phone keyboard lacks.
  const touch = window.matchMedia("(pointer: coarse)").matches;
  const bar = el("form", "claw-term-input");
  bar.hidden = !touch;
  const line = el("input");
  line.setAttribute("aria-label", "터미널에 보낼 글");
  line.placeholder = "여기에 입력하고 ⏎";
  line.autocapitalize = "off";
  line.setAttribute("autocorrect", "off");
  line.spellcheck = false;
  line.enterKeyHint = "send";
  const sendBtn = el("button", "claw-term-btn is-primary", "⏎");
  sendBtn.type = "submit";
  sendBtn.setAttribute("aria-label", "보내기");
  const keys = el("div", "claw-term-keys");
  const KEYS: [string, string, string][] = [["Esc", "\x1b", "Esc"], ["Tab", "\t", "Tab"], ["↑", "\x1b[A", "위"], ["↓", "\x1b[B", "아래"], ["^C", "\x03", "Ctrl-C"], ["⏎", "\r", "엔터만"]];
  for (const [label, seq, name] of KEYS) {
    const k = el("button", "claw-term-btn", label);
    k.type = "button";
    k.setAttribute("aria-label", name);
    k.onclick = () => sendRaw(seq);
    keys.append(k);
  }
  bar.append(line, sendBtn, keys);
  panel.append(divider, head, menu, body, bar);
  // A launcher at the bottom left, beside the office's own buttons.
  const opener = el("button", "claw-term-open", "⌨ 터미널");
  opener.type = "button";
  root.append(panel, opener);

  const tabs = new Map<string, Tab>();
  /** Sends text to the active terminal as if typed there. */
  function sendRaw(data: string) {
    const t = tabs.get(active);
    if (!t || t.ended) return;
    void host.request("terminal.input", { sessionId: t.sessionId, data }).catch(() => {});
  }
  bar.onsubmit = (e) => {
    e.preventDefault();
    // Whatever the keyboard is still composing is part of the line by now: submit ends the composition.
    sendRaw(`${line.value}\r`);
    line.value = "";
  };
  let active = "";
  let agents: readonly { id: string; name: string; sessionKey?: string }[] = [];
  let defaultCwd = "";

  const setWidth = (px: number) => {
    // A narrow screen (a phone) gets the terminal over the whole office instead of beside it.
    const narrow = root.clientWidth < 720;
    const w = narrow ? root.clientWidth : Math.round(Math.max(320, Math.min(px, root.clientWidth - 280)));
    root.style.setProperty("--claw-term-w", panel.hidden || narrow ? "0px" : `${w}px`);
    panel.style.width = `${w}px`;
    try { localStorage.setItem(WIDTH_STORE, String(w)); } catch { /* storage blocked */ }
    refit();
  };
  const savedWidth = () => {
    try { return Number(localStorage.getItem(WIDTH_STORE)) || 0; } catch { return 0; }
  };
  const show = (on: boolean) => {
    panel.hidden = !on;
    opener.hidden = on;
    setWidth(savedWidth() || root.clientWidth * 0.46);
  };
  hide.onclick = () => show(false);
  opener.onclick = () => {
    show(true);
    if (!tabs.size) toggleMenu(true);
  };

  divider.onpointerdown = (e) => {
    divider.setPointerCapture(e.pointerId);
    const right = root.getBoundingClientRect().right;
    divider.onpointermove = (m) => setWidth(right - m.clientX);
    divider.onpointerup = () => (divider.onpointermove = null);
  };
  divider.onkeydown = (e) => {
    if (e.key === "ArrowLeft") setWidth(panel.clientWidth + 40);
    if (e.key === "ArrowRight") setWidth(panel.clientWidth - 40);
  };

  const save = () => {
    const list: Saved[] = [...tabs.values()].filter((t) => !t.ended).map((t) => ({ sessionId: t.sessionId, title: t.title, href: t.href }));
    try { localStorage.setItem(STORE, JSON.stringify(list)); } catch { /* storage blocked */ }
  };

  let fitTimer = 0;
  function refit() {
    clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => {
      const t = tabs.get(active);
      if (!t || panel.hidden) return;
      t.fit.fit();
      if (!t.ended) void host.request("terminal.resize", { sessionId: t.sessionId, cols: t.term.cols, rows: t.term.rows }).catch(() => {});
    }, 60);
  }
  const ro = new ResizeObserver(refit);
  ro.observe(body);

  const select = (id: string) => {
    active = id;
    for (const t of tabs.values()) {
      const on = t.sessionId === id;
      t.el.hidden = !on;
      t.tabEl.classList.toggle("is-on", on);
      t.tabEl.setAttribute("aria-selected", String(on));
    }
    refit();
    tabs.get(id)?.term.focus();
  };

  const close = (id: string) => {
    const t = tabs.get(id);
    if (!t) return;
    if (!t.ended) void host.request("terminal.close", { sessionId: id }).catch(() => {});
    t.term.dispose();
    t.el.remove();
    t.tabEl.remove();
    tabs.delete(id);
    save();
    if (active === id) select([...tabs.keys()].at(-1) ?? "");
  };

  /** Puts a Gateway terminal session in a tab, writing what it printed so far. */
  const adopt = (sessionId: string, title: string, buffer = "", href?: string) => {
    if (tabs.has(sessionId)) return select(sessionId);
    const term = new Terminal({ fontFamily: 'ui-monospace, Menlo, "Apple SD Gothic Neo", monospace', fontSize: 13, cursorBlink: true, theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc" }, scrollback: 5000, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const box = el("div", "claw-term-pane");
    body.append(box);
    term.open(box);
    if (buffer) term.write(buffer);
    term.onData((data) => void host.request("terminal.input", { sessionId, data }).catch(() => {}));
    const tabEl = el("div", "claw-term-tab");
    tabEl.setAttribute("role", "tab");
    const name = el("button", "claw-term-tab-name", title);
    name.type = "button";
    name.onclick = () => select(sessionId);
    tabEl.append(name);
    if (href) {
      const chat = el("button", "claw-term-tab-x", "💬");
      chat.type = "button";
      chat.title = "대화 화면으로 열기";
      chat.onclick = () => location.assign(href);
      tabEl.append(chat);
    }
    const x = el("button", "claw-term-tab-x", "×");
    x.type = "button";
    x.title = "터미널 닫기 (세션 종료)";
    x.onclick = () => close(sessionId);
    tabEl.append(x);
    tabsEl.append(tabEl);
    tabs.set(sessionId, { sessionId, title, term, fit, el: box, tabEl, ended: false, href });
    save();
    select(sessionId);
  };

  const offData = host.onEvent("terminal.data", (p) => {
    const e = p as { sessionId?: string; data?: string };
    if (e.sessionId && typeof e.data === "string") tabs.get(e.sessionId)?.term.write(e.data);
  });
  const offExit = host.onEvent("terminal.exit", (p) => {
    const e = p as { sessionId?: string; reason?: string; exitCode?: number | null };
    const t = e.sessionId ? tabs.get(e.sessionId) : undefined;
    if (!t) return;
    t.ended = true;
    t.tabEl.classList.add("is-ended");
    t.term.write(`\r\n\x1b[2m[${e.reason === "detached" ? "다른 화면이 이 터미널을 가져갔어요" : `세션 종료${e.exitCode != null ? ` (코드 ${e.exitCode})` : ""}`}]\x1b[0m\r\n`);
    save();
  });

  const size = () => {
    // Before the first tab there is no terminal to measure: a plausible size, corrected by the first fit.
    const t = tabs.get(active);
    return t ? { cols: t.term.cols, rows: t.term.rows } : { cols: 100, rows: 30 };
  };
  const fail = (what: string, err: unknown) => say(`${what}: ${String((err as Error)?.message ?? err)}`, true);

  const api: Terminals = {
    async openCatalog(loc, title, href, cwd) {
      show(true);
      try {
        // The CLI would stop to ask whether it may trust the folder; it's the session's own folder, so say yes for it.
        if (cwd && loc.hostId === "gateway:local") await trust?.(loc.catalogId, cwd);
        const agentId = host.agents.defaultId ?? "main";
        const open = () => host.request<{ sessionId: string }>("terminal.open", { agentId, catalog: loc, ...size() });
        let r: { sessionId: string };
        try {
          r = await open();
        } catch {
          // The Gateway only opens catalog sessions this connection has listed lately (the dashboard's sidebar
          // does that on a desktop, a phone's page doesn't): list that catalog, then try once more.
          await host.request("sessions.catalog.list", { catalogId: loc.catalogId }).catch(() => undefined);
          try {
            r = await open();
          } catch (err) {
            // Still refused (a session past the catalog's page, say): resume it with the CLI in a shell instead.
            const resume = loc.catalogId === "claude" ? `claude --resume ${loc.threadId}` : loc.catalogId === "codex" ? `codex resume ${loc.threadId}` : "";
            if (!resume || !cwd || loc.hostId !== "gateway:local") throw err;
            r = await host.request<{ sessionId: string }>("terminal.open", { agentId, ...size() });
            await host.request("terminal.input", { sessionId: r.sessionId, data: `cd ${JSON.stringify(cwd)} && ${resume}\r` });
          }
        }
        if (!signal.aborted) adopt(r.sessionId, title, "", href);
      } catch (err) { fail("터미널을 열지 못했어요", err); }
    },
    async openNew(k, opts) {
      show(true);
      const agentId = opts.agentId ?? host.agents.defaultId ?? "main";
      try {
        if (k === "openclaw" || k === "shell") {
          const r = await host.request<{ sessionId: string }>("terminal.open", { agentId, ...size() });
          if (signal.aborted) return;
          adopt(r.sessionId, opts.title ?? (k === "shell" ? "셸" : `OpenClaw · ${agentId}`));
          if (k === "openclaw") await host.request("terminal.input", { sessionId: r.sessionId, data: `openclaw tui${opts.sessionKey ? ` --session ${opts.sessionKey}` : ""}\r` });
          return;
        }
        const cwd = (opts.cwd || defaultCwd).trim();
        if (!cwd.startsWith("/")) return say("폴더는 / 로 시작하는 절대 경로로 적어 주세요.", true);
        await trust?.(k, cwd);
        const r = await host.request<{ sessionId: string }>("sessions.catalog.startTerminal", { catalogId: k, hostId: "gateway:local", agentId, cwd });
        if (signal.aborted) return;
        const att = await host.request<{ buffer?: string }>("terminal.attach", { sessionId: r.sessionId }).catch(() => ({ buffer: "" }));
        adopt(r.sessionId, opts.title ?? `${KIND_LABEL[k]} · ${cwd.split("/").pop()}`, att.buffer ?? "");
      } catch (err) { fail(`${KIND_LABEL[k]}을(를) 열지 못했어요`, err); }
    },
    setDefaultCwd(cwd) {
      defaultCwd = cwd;
      if (!cwdIn.value) cwdIn.placeholder = `폴더 (기본: ${cwd})`;
    },
    setAgents(next) {
      agents = next;
    },
    dispose() {
      offData();
      offExit();
      ro.disconnect();
      clearTimeout(fitTimer);
      // Detach only: the Gateway keeps each PTY for a while, and this page reattaches them next time.
      for (const t of tabs.values()) t.term.dispose();
      panel.remove();
      opener.remove();
      root.style.removeProperty("--claw-term-w");
    },
  };

  function toggleMenu(on = menu.hidden) {
    menu.hidden = !on;
    if (!on) return;
    agentSel.replaceChildren(...agents.map((a) => new Option(a.name, a.id)));
    const sync = () => {
      const k = kind.value;
      agentSel.hidden = k !== "openclaw";
      cwdIn.hidden = k === "openclaw" || k === "shell";
    };
    kind.onchange = sync;
    sync();
    kind.focus();
  }
  add.onclick = () => toggleMenu();
  menu.onsubmit = (e) => {
    e.preventDefault();
    const k = kind.value as CliKind | "openclaw" | "shell";
    const a = agents.find((x) => x.id === agentSel.value);
    menu.hidden = true;
    void api.openNew(k, { cwd: cwdIn.value, agentId: k === "openclaw" ? a?.id : undefined, sessionKey: a?.sessionKey, title: k === "openclaw" && a ? `OpenClaw · ${a.name}` : undefined });
  };

  // Tabs from the last visit come back if the Gateway still holds their PTYs.
  void (async () => {
    let saved: Saved[] = [];
    try { saved = JSON.parse(localStorage.getItem(STORE) || "[]") as Saved[]; } catch { /* nothing saved */ }
    for (const s of saved) {
      try {
        const r = await host.request<{ buffer?: string }>("terminal.attach", { sessionId: s.sessionId });
        if (signal.aborted) return;
        if (panel.hidden) show(true);
        adopt(s.sessionId, s.title, r.buffer ?? "", s.href);
      } catch { /* gone: its detach window passed */ }
    }
    save();
  })();

  return api;
}
