import type { FeatureClient, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";

// The conversation panel for a Paseo agent: what was asked, what it answered, one line per tool call, and its
// permission requests as buttons. What you type goes into that same running session through Paseo (no second
// `claude --resume` process), so the agent, the Paseo app on your phone and this panel all see one conversation.
// It reads structured timeline data rather than a terminal's screen, so nothing is redrawn into a narrow box.

type Feature = FeatureClient<typeof contract>;
type Timeline = FeatureOutput<typeof contract, "paseo-timeline">;
type Agent = NonNullable<Timeline["agent"]>;
type Permission = Agent["permissions"][number];
type Item = Timeline["items"][number];

const POLL_MS = 2_000;
const IDLE_POLL_MS = 6_000;
const WIDTH_STORE = "claw-office:chat-width";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const STATUS: Record<string, string> = { running: "일하는 중", idle: "대기", initializing: "준비 중", error: "오류", closed: "닫힘" };
const MODE: Record<string, string> = { default: "매번 묻기", acceptEdits: "편집 자동 허용", auto: "자동 검토", plan: "계획", bypassPermissions: "모두 허용" };
const time = (ms: number) => (ms ? new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "");

export interface PermitAnswer { allow: boolean; actionId?: string; acceptEdits?: boolean }

export interface PaseoChat {
  open(hostId: string, agentId: string, title: string): void;
  /** True while it shows this agent (the office skips its own notice then). */
  showing(hostId: string, agentId: string): boolean;
  dispose(): void;
}

/** Permission request card, shared with the inbox: summary, what exactly, and its answers. */
export function permissionCard(p: Permission, answer: (a: PermitAnswer) => Promise<void>, extra?: HTMLElement): HTMLElement {
  const card = el("section", "claw-chat-perm");
  card.append(el("div", "claw-chat-perm-kind", `🔴 권한 요청 · ${p.name}`), el("div", "claw-chat-perm-sum", p.summary));
  if (p.detail && p.detail !== p.summary.replace(/^\$ /, "")) {
    const more = el("pre", "claw-chat-perm-detail", p.detail);
    card.append(more);
  }
  const acts = el("div", "claw-chat-perm-acts");
  const buttons: HTMLButtonElement[] = [];
  const add = (label: string, cls: string, a: PermitAnswer) => {
    const b = el("button", `claw-office-btn ${cls}`, label);
    b.type = "button";
    b.onclick = async () => {
      for (const x of buttons) x.disabled = true;
      try { await answer(a); } finally { for (const x of buttons) x.disabled = false; }
    };
    buttons.push(b);
    acts.append(b);
  };
  if (p.actions.length) for (const a of p.actions) add(a.label, a.behavior === "allow" ? "is-primary" : "", { allow: a.behavior === "allow", actionId: a.id });
  else {
    add("허용", "is-primary", { allow: true });
    if (p.canAcceptEdits) add("이 세션은 편집 자동 허용", "", { allow: true, acceptEdits: true });
    add("거부", "is-danger", { allow: false });
  }
  if (extra) acts.append(extra);
  card.append(acts);
  return card;
}

export function mountPaseoChat(root: HTMLElement, feature: Feature, signal: AbortSignal, say: (text: string, bad?: boolean) => void): PaseoChat {
  const panel = el("aside", "claw-chat");
  panel.hidden = true;
  panel.setAttribute("aria-label", "Paseo 대화");
  const divider = el("div", "claw-term-divider");
  divider.setAttribute("role", "separator");
  divider.tabIndex = 0;
  const head = el("div", "claw-chat-head");
  const titleEl = el("div", "claw-chat-title");
  const meta = el("div", "claw-chat-meta");
  const stop = el("button", "claw-term-btn", "■ 멈추기");
  stop.type = "button";
  stop.title = "지금 하던 턴을 멈춰요. 세션은 그대로 남아요.";
  const close = el("button", "claw-term-btn", "닫기");
  close.type = "button";
  const titles = el("div", "claw-chat-titles");
  titles.append(titleEl, meta);
  head.append(titles, stop, close);
  const list = el("div", "claw-chat-list");
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");
  const perms = el("div", "claw-chat-perms");
  const form = el("form", "claw-chat-compose");
  const input = el("textarea");
  input.rows = 2;
  input.placeholder = "이 세션에 이어서 말하기 (Enter 보내기, Shift+Enter 줄바꿈)";
  input.setAttribute("aria-label", "보낼 메시지");
  const row = el("div", "claw-chat-compose-row");
  const interruptLabel = el("label", "claw-chat-interrupt");
  const interrupt = el("input");
  interrupt.type = "checkbox";
  interruptLabel.append(interrupt, " 하던 일 멈추고 보내기");
  interruptLabel.title = "끄면 일하는 중에 보낸 말은 지금 턴에 덧붙어요(Claude Code에서 작업 중에 입력하는 것과 같아요).";
  const send = el("button", "claw-term-btn is-primary", "보내기");
  send.type = "submit";
  row.append(interruptLabel, send);
  form.append(input, row);
  panel.append(divider, head, list, perms, form);
  root.append(panel);

  let current: { hostId: string; agentId: string; title: string } | null = null;
  let timer = 0;
  let lastKey = "";
  let busy = false;

  const setWidth = (px: number) => {
    const narrow = root.clientWidth < 720;
    const w = narrow ? root.clientWidth : Math.round(Math.max(340, Math.min(px, root.clientWidth - 280)));
    root.style.setProperty("--claw-chat-w", panel.hidden || narrow ? "0px" : `${w}px`);
    panel.style.width = `${w}px`;
    try { localStorage.setItem(WIDTH_STORE, String(w)); } catch { /* storage blocked */ }
  };
  const savedWidth = () => {
    try { return Number(localStorage.getItem(WIDTH_STORE)) || 0; } catch { return 0; }
  };
  divider.onpointerdown = (e) => {
    divider.setPointerCapture(e.pointerId);
    const right = panel.getBoundingClientRect().right;
    divider.onpointermove = (m) => setWidth(right - m.clientX);
    divider.onpointerup = () => (divider.onpointermove = null);
  };
  divider.onkeydown = (e) => {
    if (e.key === "ArrowLeft") setWidth(panel.clientWidth + 40);
    if (e.key === "ArrowRight") setWidth(panel.clientWidth - 40);
  };

  const hide = () => {
    panel.hidden = true;
    current = null;
    clearTimeout(timer);
    root.style.setProperty("--claw-chat-w", "0px");
  };
  close.onclick = hide;

  const itemEl = (it: Item): HTMLElement => {
    switch (it.kind) {
      case "user": {
        const b = el("div", "claw-chat-msg is-user");
        b.append(el("div", "claw-chat-text", it.text), el("div", "claw-chat-at", time(it.at)));
        return b;
      }
      case "assistant": {
        const b = el("div", "claw-chat-msg is-assistant");
        b.append(el("div", "claw-chat-text", it.text), el("div", "claw-chat-at", time(it.at)));
        return b;
      }
      case "tool": return el("div", `claw-chat-tool is-${it.status || "done"}`, `${it.status === "running" ? "⋯ " : it.status === "failed" ? "✗ " : ""}${it.text}`);
      case "reasoning": return el("div", "claw-chat-reason", `💭 ${it.text}`);
      case "todo": return el("pre", "claw-chat-todo", it.text);
      case "error": return el("div", "claw-chat-error", `⚠ ${it.text}`);
      default: return el("div", "claw-chat-note", it.text);
    }
  };

  const answer = async (p: Permission, a: PermitAnswer) => {
    if (!current) return;
    try {
      await feature.invoke("paseo-permit", { hostId: current.hostId, agentId: current.agentId, requestId: p.id, allow: a.allow, ...(a.actionId ? { actionId: a.actionId } : {}), ...(a.acceptEdits ? { acceptEdits: true } : {}) });
      say(a.allow ? "허용했어요. 이어서 일해요." : "거부했어요.");
      lastKey = "";
      void load();
    } catch (err) { say(`답하지 못했어요: ${String((err as Error)?.message ?? err)}`, true); }
  };

  const draw = (t: Timeline) => {
    const a = t.agent;
    titleEl.textContent = a?.title || current?.title || "Paseo 에이전트";
    meta.textContent = a ? [STATUS[a.status] ?? a.status, a.provider === "codex" ? "Codex" : "Claude Code", a.project, a.mode ? `모드 ${MODE[a.mode] ?? a.mode}` : ""].filter(Boolean).join(" · ") : "";
    panel.classList.toggle("is-running", a?.status === "running");
    stop.disabled = a?.status !== "running";
    const key = JSON.stringify([t.items.length, t.items.at(-1)?.text.length, t.items.at(-1)?.status, a?.permissions.map((p) => p.id), a?.status]);
    if (key === lastKey) return;
    lastKey = key;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.replaceChildren(...(t.items.length ? t.items.map(itemEl) : [el("div", "claw-chat-note", "아직 주고받은 말이 없어요.")]));
    if (a?.lastError && a.status === "error") list.append(el("div", "claw-chat-error", `⚠ ${a.lastError}`));
    if (a?.status === "running" && !a.permissions.length) list.append(el("div", "claw-chat-working", "일하는 중…"));
    perms.replaceChildren(...(a?.permissions ?? []).map((p) => permissionCard(p, (x) => answer(p, x))));
    if (nearBottom) list.scrollTop = list.scrollHeight;
  };

  const load = async () => {
    clearTimeout(timer);
    const c = current;
    if (!c || signal.aborted) return;
    let running = false;
    try {
      const t = await feature.invoke("paseo-timeline", { hostId: c.hostId, agentId: c.agentId, limit: 80 });
      if (current !== c || signal.aborted) return;
      running = t.agent?.status === "running" || t.agent?.status === "initializing" || !!t.agent?.permissions.length;
      draw(t);
    } catch (err) {
      if (current !== c) return;
      meta.textContent = `읽지 못했어요: ${String((err as Error)?.message ?? err)}`;
    }
    if (current === c && !panel.hidden) timer = window.setTimeout(() => (document.hidden ? (timer = window.setTimeout(load, IDLE_POLL_MS)) : void load()), running ? POLL_MS : IDLE_POLL_MS);
  };

  const submit = async () => {
    const c = current;
    const text = input.value.trim();
    if (!c || !text || busy) return;
    busy = true;
    send.disabled = true;
    try {
      await feature.invoke("paseo-send", { hostId: c.hostId, agentId: c.agentId, text, interrupt: interrupt.checked });
      input.value = "";
      interrupt.checked = false;
      lastKey = "";
      void load();
    } catch (err) {
      say(`보내지 못했어요: ${String((err as Error)?.message ?? err)}`, true);
    } finally {
      busy = false;
      send.disabled = false;
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    void submit();
  };
  input.onkeydown = (e) => {
    // Korean (and other IME) input: Enter that ends a syllable's composition isn't a send.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void submit();
    }
  };
  stop.onclick = async () => {
    if (!current) return;
    try {
      await feature.invoke("paseo-stop", { hostId: current.hostId, agentId: current.agentId });
      say("멈췄어요.");
      void load();
    } catch (err) { say(`멈추지 못했어요: ${String((err as Error)?.message ?? err)}`, true); }
  };

  return {
    open(hostId, agentId, title) {
      const same = current?.hostId === hostId && current.agentId === agentId;
      current = { hostId, agentId, title };
      if (!same) {
        lastKey = "";
        list.replaceChildren(el("div", "claw-chat-note", "불러오는 중…"));
        perms.replaceChildren();
        titleEl.textContent = title;
        meta.textContent = "";
      }
      panel.hidden = false;
      setWidth(savedWidth() || Math.min(520, root.clientWidth * 0.42));
      void load();
      input.focus();
    },
    showing(hostId, agentId) {
      return !panel.hidden && current?.hostId === hostId && current.agentId === agentId;
    },
    dispose() {
      clearTimeout(timer);
      panel.remove();
      root.style.removeProperty("--claw-chat-w");
    },
  };
}
