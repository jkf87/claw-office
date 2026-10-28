import type { ControlUiHost, ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import { permissionCard, type PermitAnswer } from "./chat";
import type { PaseoAgentRow, PaseoPermission } from "./paseo";

// Giving an OpenClaw agent work, and the one place to look afterwards. The 「일 맡기기」 window asks three
// things (what, which agent, what should be left when it's done) and starts a new session for it, so it
// never cuts into what an agent is already doing. The inbox (「나를 기다리는 것」) holds only what needs
// you: questions an agent is waiting on (question.list), and work you gave that has finished. The jobs
// you gave live in this browser (localStorage): they are a list of your own errands, not shared state.

type Question = { questionId: string; header: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean; isOther?: boolean; isSecret?: boolean };
type QuestionRecord = { id: string; questions: Question[]; agentId?: string; sessionKey?: string; createdAtMs: number; expiresAtMs: number; status: string };

export interface Job {
  id: string;
  agentId: string;
  agentName: string;
  what: string;
  done: string;
  label: string;
  sessionKey: string;
  createdAt: number;
  /** running → finished (the session went quiet after starting) → acked (you looked). */
  state: "running" | "finished" | "acked";
  seenActive: boolean;
  finishedAt?: number;
}

export interface AgentChoice { id: string; name: string; model: string; working: boolean; paseo?: { hostId: string; provider: "claude" | "codex" } }

/** A Paseo agent's permission request waiting on you. */
export interface PaseoWaiting { hostId: string; agentId: string; name: string; where: string; perm: PaseoPermission }

/** What the desk asks of Paseo: answering its requests, opening an agent's conversation, starting a new agent. */
export interface DeskPaseo {
  permit(w: PaseoWaiting, answer: PermitAnswer): Promise<void>;
  openChat(hostId: string, agentId: string, title: string): void;
  create(input: { hostId: string; provider: "claude" | "codex"; cwd: string; prompt: string; title: string }): Promise<string>;
}

export type { PaseoAgentRow };

const STORE = "claw-office:jobs";
const QUIET_MS = 20_000;

function load(): Job[] {
  try { return JSON.parse(localStorage.getItem(STORE) || "[]") as Job[]; } catch { return []; }
}
function save(jobs: Job[]) {
  try { localStorage.setItem(STORE, JSON.stringify(jobs.slice(-60))); } catch { /* storage blocked: jobs last this visit */ }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`;
}

export interface Desk {
  /** A short notice over the office. */
  say(text: string, bad?: boolean): void;
  /** Opens 「일 맡기기」 for this agent (any M5 OpenClaw agent can still be picked inside). */
  assign(agentId: string): void;
  /** Feeds the latest session rows (for job progress) and the agents to choose from. */
  update(sessions: readonly ControlUiSession[], agents: readonly AgentChoice[]): void;
  /** Agents with a question waiting on you, for their red light. */
  readonly asking: ReadonlySet<string>;
  /** Paseo's permission requests for the inbox, and the computers it can start new Claude Code / Codex agents on. */
  setPaseo(waiting: readonly PaseoWaiting[], targets: readonly AgentChoice[]): void;
  /** The folder a new Paseo agent starts in unless told otherwise. */
  setDefaultCwd(cwd: string): void;
  dispose(): void;
}

export function mountDesk(root: HTMLElement, host: ControlUiHost, signal: AbortSignal, onTerminal?: (agentId: string, sessionKey?: string) => void, paseo?: DeskPaseo): Desk {
  const jobs = load();
  let agents: readonly AgentChoice[] = [];
  let paseoTargets: readonly AgentChoice[] = [];
  let paseoWaiting: readonly PaseoWaiting[] = [];
  let defaultCwd = "";
  let questions: QuestionRecord[] = [];
  const asking = new Set<string>();
  const choices = () => [...agents, ...paseoTargets];

  // ── The inbox button and panel ──
  const bell = el("button", "claw-office-inbox-toggle");
  bell.type = "button";
  const inbox = el("aside", "claw-office-inbox");
  inbox.hidden = true;
  inbox.setAttribute("aria-label", "나를 기다리는 것");
  bell.onclick = () => {
    inbox.hidden = !inbox.hidden;
    bell.classList.toggle("is-on", !inbox.hidden);
    drawInbox();
  };
  const toast = el("div", "claw-office-toast");
  toast.hidden = true;
  let toastTimer = 0;
  const say = (text: string, bad = false) => {
    toast.textContent = text;
    toast.classList.toggle("is-bad", bad);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
  };

  // ── 「일 맡기기」 window ──
  const veil = el("div", "claw-office-veil");
  veil.hidden = true;
  const dialog = el("form", "claw-office-assign");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "claw-office-assign-title");
  const title = el("h2", "", "일 맡기기");
  title.id = "claw-office-assign-title";
  const who = el("select", "claw-office-assign-who");
  who.setAttribute("aria-label", "맡을 에이전트");
  const whoNote = el("p", "claw-office-assign-note");
  const what = el("textarea", "claw-office-assign-what");
  what.placeholder = "무엇을 해 주면 될까요? 예: drafts/gpu-how-it-works 기획안의 목차를 5개 장으로 다시 짜 줘";
  what.rows = 4;
  what.required = true;
  what.setAttribute("aria-label", "무엇을");
  const done = el("input", "claw-office-assign-done");
  done.placeholder = "끝나면 남아 있어야 할 것 (선택) 예: plan.md 수정 + 바꾼 이유 3줄";
  done.setAttribute("aria-label", "끝나면 남아 있어야 할 것");
  // A Paseo agent starts in a folder of its own choosing; OpenClaw agents have their workspace already.
  const cwdField = el("input", "claw-office-assign-cwd");
  cwdField.placeholder = "폴더 (절대 경로)";
  cwdField.setAttribute("aria-label", "어느 폴더에서");
  const row = el("div", "claw-office-assign-row");
  const cancel = el("button", "claw-office-btn", "닫기");
  cancel.type = "button";
  // The agent's own chat in a terminal beside the office (its TUI), for when there's more to say than one errand.
  const tui = el("button", "claw-office-btn", "터미널로 열기");
  tui.type = "button";
  tui.hidden = !onTerminal;
  tui.onclick = () => {
    close();
    onTerminal?.(who.value);
  };
  const send = el("button", "claw-office-btn is-primary", "맡기기");
  send.type = "submit";
  row.append(tui, cancel, send);
  const lab = (text: string, field: HTMLElement) => {
    const l = el("label", "claw-office-assign-label");
    l.append(el("span", "", text), field);
    return l;
  };
  const cwdLabel = lab("어느 폴더에서", cwdField);
  dialog.append(title, lab("누구에게", who), whoNote, cwdLabel, lab("무엇을", what), lab("끝나면 남아 있어야 할 것", done), row);
  veil.append(dialog);
  const add = el("button", "claw-office-assign-open", "＋ 일 맡기기");
  add.type = "button";
  const bar = el("div", "claw-office-deskbar");
  bar.append(add, bell);
  root.append(bar, inbox, veil, toast);

  const close = () => (veil.hidden = true);
  cancel.onclick = close;
  veil.onclick = (e) => { if (e.target === veil) close(); };
  dialog.onkeydown = (e) => { if (e.key === "Escape") close(); };
  const noteFor = () => {
    const a = choices().find((x) => x.id === who.value);
    cwdLabel.hidden = !a?.paseo;
    tui.hidden = !onTerminal || !!a?.paseo;
    if (a?.paseo) {
      if (!cwdField.value && defaultCwd) cwdField.value = defaultCwd;
      whoNote.textContent = `Paseo가 이 폴더에서 새 ${a.paseo.provider === "codex" ? "Codex" : "Claude Code"} 세션을 시작해요. 권한 요청은 🔔에 뜨고, 옆 대화 창과 Paseo 앱에서 이어서 말할 수 있어요.`;
      return;
    }
    whoNote.textContent = a ? `${a.model || "기본 모델"} · ${a.working ? "지금 다른 일 중이에요. 새 세션으로 따로 시작해서 하던 일은 건드리지 않아요." : "새 세션으로 시작해요."}` : "";
  };
  who.onchange = noteFor;

  /** A new Claude Code or Codex agent under Paseo, in the folder given: it opens beside the office right away. */
  const assignPaseo = async (a: AgentChoice & { paseo: NonNullable<AgentChoice["paseo"]> }, task: string, goal: string) => {
    const cwd = cwdField.value.trim();
    if (!cwd.startsWith("/")) return say("폴더는 / 로 시작하는 절대 경로로 적어 주세요.", true);
    if (!paseo) return;
    const prompt = goal ? `${task}\n\n끝났다고 볼 기준: ${goal}\n끝나면 무엇을 했는지와 결과물 위치를 짧게 알려 줘.` : task;
    const name = task.length > 60 ? `${task.slice(0, 59)}…` : task;
    send.disabled = true;
    try {
      const agentId = await paseo.create({ hostId: a.paseo.hostId, provider: a.paseo.provider, cwd, prompt, title: name });
      if (signal.aborted) return;
      what.value = "";
      done.value = "";
      close();
      say(`${a.name}에게 맡겼어요. 권한 요청이 오면 🔔에 나와요.`);
      paseo.openChat(a.paseo.hostId, agentId, name);
    } catch (err) {
      say(`맡기지 못했어요: ${String((err as Error)?.message ?? err)}`, true);
    } finally {
      send.disabled = false;
    }
  };

  dialog.onsubmit = async (e) => {
    e.preventDefault();
    const picked = choices().find((x) => x.id === who.value);
    const task = what.value.trim();
    if (!picked || !task) return;
    const goal = done.value.trim();
    if (picked.paseo) return assignPaseo(picked as AgentChoice & { paseo: NonNullable<AgentChoice["paseo"]> }, task, goal);
    const a = picked;
    const label = `claw-${Date.now().toString(36)}`;
    const message = goal ? `${task}\n\n끝났다고 볼 기준: ${goal}\n끝나면 무엇을 했는지와 결과물 위치를 짧게 알려 줘.` : `${task}\n\n끝나면 무엇을 했는지와 결과물 위치를 짧게 알려 줘.`;
    send.disabled = true;
    try {
      const r = await host.request<{ key?: string; sessionKey?: string }>("sessions.create", {
        agentId: a.id,
        label,
        displayName: task.length > 60 ? `${task.slice(0, 59)}…` : task,
        message,
        idempotencyKey: label,
      });
      if (signal.aborted) return;
      jobs.push({ id: label, agentId: a.id, agentName: a.name, what: task, done: goal, label, sessionKey: r?.key ?? r?.sessionKey ?? "", createdAt: Date.now(), state: "running", seenActive: false });
      save(jobs);
      what.value = "";
      done.value = "";
      close();
      say(`${a.name}에게 맡겼어요. 끝나면 🔔에 나와요.`);
      drawBell();
    } catch (err) {
      say(`맡기지 못했어요: ${String((err as Error)?.message ?? err)}`, true);
    } finally {
      send.disabled = false;
    }
  };

  // ── Inbox content ──
  const drawBell = () => {
    const waiting = questions.length + paseoWaiting.length + jobs.filter((j) => j.state === "finished").length;
    const running = jobs.filter((j) => j.state === "running").length;
    bell.textContent = waiting ? `🔔 나를 기다리는 것 ${waiting}` : running ? `🔔 맡긴 일 ${running}개 진행 중` : "🔔 받은함";
    bell.classList.toggle("is-hot", waiting > 0);
  };

  const answer = async (q: QuestionRecord, picks: Map<string, string[]>) => {
    try {
      await host.request("question.resolve", { id: q.id, answers: { answers: Object.fromEntries(picks) } });
      questions = questions.filter((x) => x.id !== q.id);
      say("답했어요. 에이전트가 이어서 일해요.");
      drawInbox();
      drawBell();
    } catch (err) {
      say(`답하지 못했어요: ${String((err as Error)?.message ?? err)}`, true);
    }
  };

  const nameOf = (agentId?: string) => agents.find((a) => a.id === agentId)?.name ?? agentId ?? "에이전트";

  function drawInbox() {
    if (inbox.hidden) return;
    const parts: HTMLElement[] = [el("div", "claw-office-inbox-head", "나를 기다리는 것")];
    const finished = jobs.filter((j) => j.state === "finished");
    if (!questions.length && !finished.length && !paseoWaiting.length) parts.push(el("p", "claw-office-inbox-empty", "지금은 기다리는 게 없어요."));
    // Claude Code and Codex (through Paseo) waiting on a permission: answer here, or open the conversation.
    for (const w of paseoWaiting) {
      const open = el("button", "claw-office-btn", "대화 열기");
      open.type = "button";
      open.onclick = () => paseo?.openChat(w.hostId, w.agentId, w.name);
      const card = permissionCard(w.perm, async (answer) => {
        try {
          await paseo?.permit(w, answer);
          paseoWaiting = paseoWaiting.filter((x) => x.perm.id !== w.perm.id);
          say(answer.allow ? `${w.name}: 허용했어요.` : `${w.name}: 거부했어요.`);
          drawInbox();
          drawBell();
        } catch (err) {
          say(`답하지 못했어요: ${String((err as Error)?.message ?? err)}`, true);
        }
      }, open);
      card.prepend(el("div", "claw-office-card-kind", `${w.where} · ${w.name}`));
      parts.push(card);
    }
    for (const q of questions) {
      const card = el("section", "claw-office-card is-question");
      card.append(el("div", "claw-office-card-kind", `🔴 질문 · ${nameOf(q.agentId)} · ${ago(Date.now() - q.createdAtMs)}`));
      const picks = new Map<string, string[]>();
      for (const item of q.questions) {
        card.append(el("div", "claw-office-card-title", item.header ? `${item.header} — ${item.question}` : item.question));
        if (item.isSecret) {
          card.append(el("p", "claw-office-card-note", "비밀 값을 묻는 질문이라 대화 창에서 직접 답해 주세요."));
          continue;
        }
        const opts = el("div", "claw-office-card-options");
        for (const o of item.options) {
          const b = el("button", "claw-office-chip", o.label);
          b.type = "button";
          if (o.description) b.title = o.description;
          b.onclick = () => {
            const cur = picks.get(item.questionId) ?? [];
            const next = item.multiSelect ? (cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
            picks.set(item.questionId, next);
            for (const c of opts.children) c.classList.toggle("is-on", next.includes((c as HTMLElement).textContent ?? ""));
          };
          opts.append(b);
        }
        if (item.isOther || !item.options.length) {
          const other = el("input", "claw-office-card-other");
          other.placeholder = "직접 쓰기";
          other.oninput = () => picks.set(item.questionId, other.value.trim() ? [other.value.trim()] : []);
          opts.append(other);
        }
        card.append(opts);
      }
      const acts = el("div", "claw-office-card-acts");
      const ok = el("button", "claw-office-btn is-primary", "답하기");
      ok.type = "button";
      ok.onclick = () => {
        if (q.questions.some((i) => !i.isSecret && !(picks.get(i.questionId)?.length))) return say("모든 질문에 답을 골라 주세요.", true);
        void answer(q, picks);
      };
      acts.append(ok);
      if (q.sessionKey && q.agentId) {
        const open = el("button", "claw-office-btn", "대화 열기");
        open.type = "button";
        // Its TUI in the terminal beside the office, not the dashboard's chat page.
        open.onclick = () => onTerminal?.(q.agentId!, q.sessionKey!);
        acts.append(open);
      }
      card.append(acts);
      parts.push(card);
    }
    for (const j of finished) {
      const card = el("section", "claw-office-card is-done");
      card.append(el("div", "claw-office-card-kind", `🟢 끝남 · ${j.agentName} · ${ago(Date.now() - (j.finishedAt ?? j.createdAt))}`));
      card.append(el("div", "claw-office-card-title", j.what));
      if (j.done) card.append(el("div", "claw-office-card-note", `기준: ${j.done}`));
      const row = sessionRow(j);
      const preview = previews.get(j.id);
      if (preview) card.append(el("div", "claw-office-card-result", preview));
      else if (row && !previews.has(j.id)) void loadPreview(j, row.key);
      const acts = el("div", "claw-office-card-acts");
      const open = el("button", "claw-office-btn is-primary", "결과 보기");
      open.type = "button";
      open.onclick = () => { if (row) onTerminal?.(j.agentId, row.key); };
      const ack = el("button", "claw-office-btn", "확인");
      ack.type = "button";
      ack.onclick = () => {
        j.state = "acked";
        save(jobs);
        drawInbox();
        drawBell();
      };
      acts.append(open, ack);
      card.append(acts);
      parts.push(card);
    }
    const running = jobs.filter((j) => j.state === "running");
    if (running.length) {
      parts.push(el("div", "claw-office-inbox-sub", `진행 중 ${running.length}`));
      for (const j of running) {
        const r = el("div", "claw-office-inbox-running");
        r.textContent = `${j.agentName} · ${j.what}`;
        const row = sessionRow(j);
        if (row) {
          r.classList.add("is-link");
          r.onclick = () => onTerminal?.(j.agentId, row.key);
        }
        parts.push(r);
      }
    }
    inbox.replaceChildren(...parts);
  }

  let rows: readonly ControlUiSession[] = [];
  // The last thing a finished job's session said, read once per job (the office's own session list skips it to stay light).
  const previews = new Map<string, string>();
  const loadPreview = async (j: Job, key: string) => {
    previews.set(j.id, "");
    try {
      const r = await host.request<{ sessions?: { key: string; lastMessagePreview?: string }[] }>("sessions.list", { agentId: j.agentId, search: j.label, limit: 5, includeLastMessage: true });
      const text = r?.sessions?.find((s) => s.key === key)?.lastMessagePreview ?? "";
      if (signal.aborted || !text) return;
      previews.set(j.id, text);
      drawInbox();
    } catch { /* no preview: the card still links to the result */ }
  };
  const sessionRow = (j: Job) => rows.find((s) => (j.sessionKey && s.key === j.sessionKey) || s.label === j.label) ?? null;

  const pollQuestions = async () => {
    try {
      const r = await host.request<{ questions: QuestionRecord[] }>("question.list", {});
      if (signal.aborted) return;
      questions = (r?.questions ?? []).filter((q) => q.status === "pending" && q.expiresAtMs > Date.now());
      asking.clear();
      for (const q of questions) if (q.agentId) asking.add(q.agentId);
      drawBell();
      drawInbox();
    } catch { /* no question support on this connection: the inbox shows finished work only */ }
  };
  // A question shows the moment the Gateway announces it; the slow poll only catches what an event missed.
  void pollQuestions();
  const timer = window.setInterval(() => { if (!document.hidden) void pollQuestions(); }, 20_000);
  const offAsked = host.onEvent("question.requested", () => void pollQuestions());
  const offAnswered = host.onEvent("question.resolved", () => void pollQuestions());

  // N jumps to the inbox, as Agent Office's N goes to whoever is waiting.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "n" && e.key !== "N") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!root.isConnected || veil.hidden === false) return;
    inbox.hidden = false;
    bell.classList.add("is-on");
    drawInbox();
  };
  window.addEventListener("keydown", onKey);
  drawBell();

  const desk: Desk = {
    say,
    asking,
    setPaseo(waiting, targets) {
      const before = paseoWaiting.map((w) => w.perm.id).join("|");
      paseoWaiting = waiting;
      paseoTargets = targets;
      if (waiting.map((w) => w.perm.id).join("|") !== before) {
        drawBell();
        drawInbox();
      }
    },
    setDefaultCwd(cwd) {
      defaultCwd = cwd;
    },
    assign(agentId) {
      const all = choices();
      who.replaceChildren(...all.map((a) => {
        const o = new Option(`${a.name}${a.working ? " (일하는 중)" : ""}`, a.id);
        return o;
      }));
      if (!all.length) return say("일을 맡길 에이전트가 아직 없어요.", true);
      who.value = all.some((a) => a.id === agentId) ? agentId : all[0].id;
      noteFor();
      veil.hidden = false;
      what.focus();
    },
    update(next, nextAgents) {
      rows = next;
      agents = nextAgents;
      const now = Date.now();
      let changed = false;
      for (const j of jobs) {
        if (j.state !== "running") continue;
        const row = sessionRow(j);
        if (!row) continue;
        if (!j.sessionKey) { j.sessionKey = row.key; changed = true; }
        if (row.hasActiveRun) { if (!j.seenActive) { j.seenActive = true; changed = true; } continue; }
        // Quiet now: finished once it had started, or once it has been quiet a while after we gave it.
        const last = row.updatedAt ?? 0;
        // (Activity unknown counts as quiet only after three times as long.)
        const quiet = row.hasActiveRun === false ? QUIET_MS : QUIET_MS * 3;
        if ((j.seenActive || last > j.createdAt + 1000) && now - last > quiet) {
          j.state = "finished";
          j.finishedAt = last || now;
          changed = true;
        }
      }
      if (changed) save(jobs);
      drawBell();
      drawInbox();
    },
    dispose() {
      clearInterval(timer);
      offAsked();
      offAnswered();
      clearTimeout(toastTimer);
      window.removeEventListener("keydown", onKey);
      bar.remove();
      inbox.remove();
      veil.remove();
      toast.remove();
    },
  };
  add.onclick = () => desk.assign("");
  return desk;
}
