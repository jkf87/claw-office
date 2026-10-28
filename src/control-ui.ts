import { defineControlUiPlugin, type ControlUiHost, type ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import type { WorkerStatus } from "../vendor/agent-office/shared/protocol";
import { contract } from "./contract.js";
import { OfficeScene, type Seat } from "./office/scene";
import { mountDesk, type AgentChoice, type PaseoWaiting } from "./desk";
import { mountTerminals, type CliKind, type Locator } from "./term";
import { mountPaseoChat } from "./chat";
import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import "./control-ui.css";

// OpenClaw agents get the first desks, each in a color of its own; then this machine's Claude Code
// and Codex sessions, newest first. What each one is on comes from session titles (an OpenClaw title may be
// derived from the session's first message) and tool calls; a channel conversation (Telegram…) shows only its channel.
const AGENT_COLORS = ["#ef476f", "#2a9d8f", "#e9c46a", "#8ecae6", "#b5838d", "#f4a261", "#90be6d", "#9d8df1"];
const TOOL_COLORS = { claude: "#d97757", codex: "#3a86ff" } as const;
const DONE_MS = 10 * 60_000;
// How often the office asks the Gateway for this computer's session logs (it reads them at most every 9 s anyway).
const POLL_MS = 10_000;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

type AgentRow = ControlUiHost["agents"]["rows"][number] & { model?: unknown; identity?: { name?: string; emoji?: string } };

function modelOf(a: AgentRow): string {
  const m = a.model as unknown;
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && "primary" in m && typeof (m as { primary: unknown }).primary === "string") return (m as { primary: string }).primary;
  return "";
}

/** A session's name in the office: its own label, else its derived title, else just where it talks. Channel chats stay unnamed. */
function sessionTitle(s: ControlUiSession): string {
  if (s.label) return s.label;
  if (s.channel && s.channel !== "webchat") return `${s.channel} 대화`;
  const derived = s.derivedTitle && s.derivedTitle.length > 48 ? `${s.derivedTitle.slice(0, 47)}…` : s.derivedTitle;
  return derived || s.displayName || (s.isMain ? "메인 세션" : s.kind === "group" ? "그룹 대화" : "세션");
}

type OpenClawSeat = Seat & { open: { sessionKey: string; agentId: string } | null };
type LocalSession = { id: string; cwd?: string; tool: "claude" | "codex"; project: string; updatedAt: number; state: "working" | "done" | "idle"; title: string; actions: string[] };
type Machine = { id: string; label: string; reachable: boolean; error: string; fetchedAt: number; agents: { id: string; model: string; sessions: number; updatedAt: number }[]; sessions: LocalSession[] };

// Every computer's team sits in the one office; this one (the Gateway's) is first, to the west.
const HOME = { id: "m5", label: "M5" };
const ORDER_FOR_SEATS: Partial<Record<WorkerStatus, number>> = { needs_input: 0, working: 1, done: 2, idle: 3, offline: 4 };

/** A computer's Claude Code and Codex sessions, one desk each, numbered when several share a folder. */
function localSeats(machine: string, sessions: readonly LocalSession[], now: number): Seat[] {
  const perProject = new Map<string, number>();
  return sessions.filter((s) => s.state === "working" || now - s.updatedAt < LEAVE_AFTER_MS).map((s) => {
    const base = s.project || (s.tool === "claude" ? "claude" : "codex");
    const n = (perProject.get(`${s.tool}:${base}`) ?? 0) + 1;
    perProject.set(`${s.tool}:${base}`, n);
    return {
      key: `${machine}:${s.tool}:${s.id}`,
      machine,
      tool: s.tool,
      name: n > 1 ? `${base} ${n}` : base,
      color: TOOL_COLORS[s.tool],
      status: s.state,
      card: `${s.tool === "claude" ? "Claude Code" : "Codex"} · ${base}`,
      screen: [`${s.tool} 세션 ${s.id.slice(0, 8)}`, `폴더 ${base}`, `기록 ${ago(now - s.updatedAt)}`],
      brief: s.title,
      actions: s.actions,
    };
  });
}

type CatalogRow = { threadId: string; name?: string; cwd?: string; status?: string; updatedAt?: number; recencyAt?: number };
type CatalogHost = { hostId: string; label?: string; kind?: string; connected?: boolean; sessions?: CatalogRow[] };
// AGY and GJC keep no logs we read, so they come from the Gateway's session catalog: the last two hours, a few each.
const CATALOG_KINDS = ["agy", "gjc"] as const;
const CATALOG_HOURS = 2;
// A Claude Code, Codex, AGY or GJC session that has written nothing for this long has gone home: its worker
// packs up and leaves its desk. (OpenClaw agents are staff: they stay at their desks.)
const LEAVE_AFTER_MS = 30 * 60_000;
const CATALOG_PER_HOST = 8;
const CATALOG_POLL_MS = 60_000;

/** A catalog host's computer: the Gateway's own sessions are M5's, a paired node's are the computer it names. */
function machineOfHost(h: CatalogHost): string | null {
  if (h.hostId === "gateway:local") return HOME.id;
  return /m2max/i.test(h.label ?? "") ? "m2max" : null;
}

function catalogSeats(kind: "agy" | "gjc", hosts: readonly CatalogHost[], now: number): Seat[] {
  return hosts.flatMap((h) => {
    const machine = machineOfHost(h);
    if (!machine) return [];
    return (h.sessions ?? [])
      .filter((r) => r.status === "active" || r.status === "running" || now - (r.recencyAt ?? r.updatedAt ?? 0) < Math.min(CATALOG_HOURS * 3_600_000, LEAVE_AFTER_MS))
      .slice(0, CATALOG_PER_HOST)
      .map((r) => {
        const at = r.recencyAt ?? r.updatedAt ?? now;
        const status: WorkerStatus = r.status === "active" || r.status === "running" ? "working" : now - at < DONE_MS ? "done" : "idle";
        const title = (r.name ?? "").replace(/\s+/g, " ").slice(0, 60);
        return {
          key: `${machine}:${kind}:${r.threadId}`,
          machine,
          tool: kind,
          name: kind.toUpperCase(),
          color: kind === "agy" ? "#2a9d8f" : "#8338ec",
          status,
          card: `${kind.toUpperCase()} · ${r.cwd ? r.cwd.split("/").pop() : "세션"}`,
          screen: [`${kind} ${r.threadId.slice(-8)}`, `기록 ${ago(now - at)}`],
          brief: title,
          actions: [],
        };
      });
  });
}

/** Another computer's OpenClaw agents, as its own CLI lists them (no live-run flag there: a session touched in the last 30 s counts as working). */
function remoteAgentSeats(m: Machine, now: number): Seat[] {
  return m.agents.map((a, i) => {
    const age = a.updatedAt ? now - a.updatedAt : Infinity;
    const status: WorkerStatus = !m.reachable ? "offline" : age < 30_000 ? "working" : age < DONE_MS ? "done" : "idle";
    return {
      key: `${m.id}:openclaw:${a.id}`,
      machine: m.id,
      tool: "openclaw" as const,
      name: a.id,
      color: AGENT_COLORS[i % AGENT_COLORS.length],
      status,
      card: `${a.id}${a.model ? ` · ${a.model}` : ""}`,
      screen: [`agent:${a.id}`, a.model || "모델 기본값", `세션 ${a.sessions}개${a.updatedAt ? ` · ${ago(age)}` : ""}`, m.label],
      brief: a.updatedAt ? `마지막 활동 ${ago(age)}` : "최근 하루 활동 없음",
      actions: [],
    };
  });
}

type PaseoHost = FeatureOutput<typeof contract, "paseo-agents">["hosts"][number];
type PaseoAgent = PaseoHost["agents"][number];
const PASEO_POLL_MS = 3_000;
const MODE_LABEL: Record<string, string> = { default: "매번 묻기", acceptEdits: "편집 자동 허용", auto: "자동 검토", plan: "계획", bypassPermissions: "모두 허용" };

/** Claude Code and Codex agents that Paseo runs on one computer: a desk each, red-lit while a permission waits on you. */
function paseoSeats(host: PaseoHost, scanned: ReadonlyMap<string, LocalSession>, now: number): Seat[] {
  const perProject = new Map<string, number>();
  return host.agents.filter((a) => a.status === "running" || a.permissions.length || now - a.updatedAt < LEAVE_AFTER_MS).map((a) => {
    const tool = a.provider === "codex" ? "codex" : "claude";
    const base = a.project || tool;
    const n = (perProject.get(`${tool}:${base}`) ?? 0) + 1;
    perProject.set(`${tool}:${base}`, n);
    const status: WorkerStatus = a.permissions.length ? "needs_input" : a.status === "running" || a.status === "initializing" ? "working" : now - a.updatedAt < DONE_MS ? "done" : "idle";
    const log = a.sessionId ? scanned.get(a.sessionId) : undefined;
    const waiting = a.permissions[0];
    return {
      key: `paseo:${host.id}:${a.id}`,
      machine: host.id,
      tool,
      name: n > 1 ? `${base} ${n}` : base,
      color: TOOL_COLORS[tool],
      status,
      card: `${tool === "claude" ? "Claude Code" : "Codex"} · ${base} · Paseo`,
      screen: [`Paseo ${a.id.slice(0, 8)}`, `모드 ${MODE_LABEL[a.mode] ?? (a.mode || "기본")}`, `기록 ${ago(now - a.updatedAt)}`],
      brief: waiting ? `권한 요청: ${waiting.summary}` : a.title || log?.title || "",
      actions: [...(log?.actions ?? []), ...(waiting ? [`⏸ ${waiting.summary}`] : [])].slice(-10),
    };
  });
}

function openclawSeats(agents: readonly AgentRow[], sessions: readonly ControlUiSession[], now: number): OpenClawSeat[] {
  return agents
    .filter((a) => a.kind !== "system")
    .map((a, i): OpenClawSeat => {
      const own = sessions.filter((s) => s.agentId === a.id);
      const latest = own.reduce<ControlUiSession | null>((best, s) => ((s.updatedAt ?? 0) > (best?.updatedAt ?? 0) ? s : best), null);
      const last = latest?.updatedAt ?? 0;
      const status: WorkerStatus = a.status === "degraded" ? "offline" : own.some((s) => s.hasActiveRun) ? "working" : last && now - last < DONE_MS ? "done" : "idle";
      const name = a.identity?.name || a.name || a.id;
      const channels = [...new Set(own.map((s) => s.channel).filter(Boolean))].slice(0, 3).join(", ");
      const recent = [...own].sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0)).slice(0, 8).reverse();
      return {
        key: `openclaw:${a.id}`,
        machine: HOME.id,
        tool: "openclaw" as const,
        name,
        color: AGENT_COLORS[i % AGENT_COLORS.length],
        status,
        card: `${a.id}${modelOf(a) ? ` · ${modelOf(a)}` : ""}`,
        screen: [`agent:${a.id}`, modelOf(a) || "모델 기본값", `세션 ${own.length}개${last ? ` · ${ago(now - last)}` : ""}`, channels ? `채널 ${channels}` : "채널 없음"],
        brief: latest ? sessionTitle(latest) : "",
        actions: recent.map((s) => `${s.hasActiveRun ? "▶" : "·"} ${sessionTitle(s)} · ${ago(now - (s.updatedAt ?? now))}`),
        open: latest ? { sessionKey: latest.key, agentId: a.id } : null,
      };
    });
}

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({ id: "office", label: "Claw Office", page: { id: "office" }, icon: "building" });
    host.ui.registerPage({
      id: "office",
      label: "Claw Office",
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);
        const root = document.createElement("section");
        root.className = "claw-office";
        const hud = document.createElement("div");
        hud.className = "claw-office-hud";
        hud.innerHTML = `<div class="claw-office-title">Claw Office</div><div class="claw-office-counts">사무실을 짓는 중…</div><div class="claw-office-legend"><span style="--c:#ffd166">일하는 중</span><span style="--c:#06d6a0">방금 끝남</span><span style="--c:#8ecae6">대기</span><span style="--c:#6c757d">꺼짐</span></div><div class="claw-office-legend is-desks"><span style="--c:#ef476f">OpenClaw</span><span style="--c:#d97757">Claude Code</span><span style="--c:#3a86ff">Codex</span><span style="--c:#8338ec">GJC</span><span style="--c:#2a9d8f">AGY</span></div><div class="claw-office-keys">WASD 이동 · Q/E 회전 · Shift 빠르게 · 휠 확대</div>`;
        const toggle = document.createElement("button");
        toggle.className = "claw-office-brief-toggle";
        toggle.type = "button";
        toggle.textContent = "📋 브리핑";
        const panel = document.createElement("aside");
        panel.className = "claw-office-brief";
        panel.hidden = true;
        const ORDER: Partial<Record<WorkerStatus, number>> = { needs_input: 0, working: 1, done: 2, idle: 3, offline: 4 };
        const STATE: Partial<Record<WorkerStatus, string>> = { needs_input: "확인 필요", working: "일하는 중", done: "방금 끝남", idle: "대기", offline: "꺼짐" };
        const briefing = () => {
          const rows = [...all].sort((x, y) => (ORDER[x.status] ?? 9) - (ORDER[y.status] ?? 9));
          const working = rows.filter((s) => s.status === "working");
          const head = document.createElement("div");
          head.className = "claw-office-brief-head";
          head.textContent = working.length ? `지금 ${working.length}명이 일하는 중 · 전체 ${rows.length}명` : `지금 일하는 사람 없음 · 전체 ${rows.length}명`;
          const list = rows.map((s) => {
            const row = document.createElement("div");
            row.className = `claw-office-brief-row is-${s.status}`;
            const top = document.createElement("div");
            top.className = "claw-office-brief-name";
            top.innerHTML = `<i style="background:${s.color}"></i>`;
            top.append(`${s.name}`, Object.assign(document.createElement("span"), { textContent: `${machineLabel(s.machine)} · ${({ openclaw: "OpenClaw", claude: "Claude", codex: "Codex", agy: "AGY", gjc: "GJC" } as const)[s.tool]} · ${STATE[s.status] ?? s.status}` }));
            const what = document.createElement("div");
            what.className = "claw-office-brief-what";
            what.textContent = s.brief || "제목 없음";
            const act = document.createElement("div");
            act.className = "claw-office-brief-act";
            act.textContent = s.actions.at(-1) ?? s.screen.at(-1) ?? "";
            row.append(top, what, act);
            // Same as clicking the worker: Paseo or a terminal beside the office, never the dashboard's chat page.
            if (canOpen(s)) {
              row.classList.add("is-link");
              row.onclick = () => openSeat(s, "briefing");
            }
            return row;
          });
          panel.replaceChildren(head, ...list);
        };
        toggle.onclick = () => {
          panel.hidden = !panel.hidden;
          toggle.classList.toggle("is-on", !panel.hidden);
          if (!panel.hidden) briefing();
        };
        const tip = document.createElement("div");
        tip.className = "claw-office-tip";
        tip.hidden = true;
        const error = document.createElement("div");
        error.className = "claw-office-error";
        error.hidden = true;
        root.append(hud, toggle, panel, tip, error);
        container.append(root);

        const office = new OfficeScene(root);
        // An OpenClaw agent's TUI opens beside the office from the assign window; terms is set just below.
        let terms: ReturnType<typeof mountTerminals> | null = null;
        // Paseo agents' conversations open beside the office; chat is set just below (the desk needs it first).
        let chat: ReturnType<typeof mountPaseoChat> | null = null;
        let paseoHosts: PaseoHost[] = [];
        const desk = mountDesk(root, context.host, context.signal, (agentId, sessionKey) => {
          const key = sessionKey ?? opens.get(`openclaw:${agentId}`)?.sessionKey;
          void terms?.openNew("openclaw", { agentId, sessionKey: key, title: `OpenClaw · ${agents.find((a) => a.id === agentId)?.identity?.name ?? agentId}` });
        }, {
          permit: async (w, a) => {
            await feature.invoke("paseo-permit", { hostId: w.hostId, agentId: w.agentId, requestId: w.perm.id, allow: a.allow, ...(a.actionId ? { actionId: a.actionId } : {}), ...(a.acceptEdits ? { acceptEdits: true } : {}) });
            void pollPaseo();
          },
          openChat: (hostId, agentId, title) => chat?.open(hostId, agentId, title),
          create: async (input) => {
            const r = await feature.invoke("paseo-create", input);
            void pollPaseo();
            return r.agentId;
          },
        });
        chat = mountPaseoChat(root, feature, context.signal, desk.say);
        // Claude Code and Codex ask once per folder whether to trust it; the office answers before opening a terminal there.
        terms = mountTerminals(root, context.host, context.signal, desk.say, async (kind, cwd) => {
          if (kind !== "claude" && kind !== "codex") return;
          await feature.invoke("trust-folder", { tool: kind, cwd }).catch(() => undefined);
        });
        let catalogs: Record<string, CatalogHost[]> = {};
        let nodeHosts = new Map<string, string>();
        let agents: readonly AgentRow[] = context.host.agents.rows as readonly AgentRow[];
        let sessions: readonly ControlUiSession[] = [];
        let locals: LocalSession[] = [];
        let remotes: Machine[] = [];
        let all: Seat[] = [];
        const opens = new Map<string, { sessionKey: string; agentId: string }>();

        // A session Paseo runs sits at Paseo's desk; its log (read from disk) only lends that desk its latest tool calls.
        const paseoSeatsOf = (id: string, logs: readonly LocalSession[], now: number): { seats: Seat[]; logs: LocalSession[] } => {
          const host = paseoHosts.find((h) => h.id === id && h.connected);
          if (!host) return { seats: [], logs: [...logs] };
          const scanned = new Map(logs.map((l) => [l.id, l]));
          const owned = new Set(host.agents.map((a) => a.sessionId).filter(Boolean));
          return { seats: paseoSeats(host, scanned, now), logs: logs.filter((l) => !owned.has(l.id)) };
        };

        const seatsOf = (id: string, now: number): Seat[] => {
          const fromCatalog = CATALOG_KINDS.flatMap((k) => catalogSeats(k, catalogs[k] ?? [], now)).filter((x) => x.machine === id);
          if (id === HOME.id) {
            const p = paseoSeatsOf(id, locals, now);
            return [...openclawSeats(agents, sessions, now).map((s) => (desk.asking.has(s.key.slice("openclaw:".length)) ? { ...s, status: "needs_input" as const } : s)), ...p.seats, ...localSeats(HOME.id, p.logs, now), ...fromCatalog];
          }
          const m = remotes.find((r) => r.id === id);
          const p = paseoSeatsOf(id, m?.sessions ?? [], now);
          return m ? [...remoteAgentSeats(m, now), ...p.seats, ...localSeats(m.id, p.logs, now), ...fromCatalog] : [...p.seats, ...fromCatalog];
        };
        /** Every computer with a floor: this one, the ones read over SSH, and any other with a Paseo daemon. */
        const areaIds = () => [...new Set([HOME.id, ...remotes.map((r) => r.id), ...paseoHosts.map((h) => h.id)])];

        const machineLabel = (id: string) => (id === HOME.id ? HOME.label : remotes.find((r) => r.id === id)?.label ?? paseoHosts.find((h) => h.id === id)?.label ?? id);
        const paseoOf = (seat: Seat): { hostId: string; agentId: string } | null => {
          if (!seat.key.startsWith("paseo:")) return null;
          const [, hostId, agentId] = seat.key.split(":");
          return { hostId, agentId };
        };
        /** A session from the logs that a connected Paseo on its computer could take over. */
        const importable = (seat: Seat): { hostId: string; provider: "claude" | "codex"; sessionId: string; cwd?: string } | null => {
          if (seat.tool !== "claude" && seat.tool !== "codex") return null;
          if (seat.key.startsWith("paseo:") || !paseoHosts.some((h) => h.id === seat.machine && h.connected)) return null;
          const sessionId = seat.key.split(":").slice(2).join(":");
          const logs = seat.machine === HOME.id ? locals : remotes.find((r) => r.id === seat.machine)?.sessions ?? [];
          return { hostId: seat.machine, provider: seat.tool, sessionId, cwd: logs.find((l) => l.id === sessionId)?.cwd || undefined };
        };

        /** Where a desk's session lives in the Gateway's catalog, to continue it in a terminal; null for an OpenClaw agent. */
        const locatorOf = (seat: Seat): Locator | null => {
          if (seat.tool === "openclaw") return null;
          const hostId = seat.machine === HOME.id ? "gateway:local" : nodeHosts.get(seat.machine);
          if (!hostId) return null;
          return { catalogId: seat.tool as CliKind, hostId, threadId: seat.key.split(":").slice(2).join(":") };
        };

        const render = () => {
          const now = Date.now();
          // An agent with a question waiting on you gets the red light, whatever its sessions say.
          const claw = openclawSeats(agents, sessions, now).map((s) => (desk.asking.has(s.key.slice("openclaw:".length)) ? { ...s, status: "needs_input" as const } : s));
          const choices: AgentChoice[] = claw.map((s) => ({ id: s.key.slice("openclaw:".length), name: s.name, model: s.card.split(" · ")[1] ?? "", working: s.status === "working" }));
          desk.update(sessions, choices);
          terms?.setAgents(choices.map((c) => ({ id: c.id, name: c.name, sessionKey: opens.get(`openclaw:${c.id}`)?.sessionKey })));
          const latest = [...locals].sort((x, y) => y.updatedAt - x.updatedAt).find((x) => x.cwd);
          if (latest?.cwd) {
            terms?.setDefaultCwd(latest.cwd);
            desk.setDefaultCwd(latest.cwd);
          }
          // Paseo: what waits on you goes to the inbox; each connected computer can take new Claude Code / Codex work.
          const waiting: PaseoWaiting[] = paseoHosts.flatMap((h) => h.agents.flatMap((a) => a.permissions.map((perm) => ({ hostId: h.id, agentId: a.id, name: a.title || a.project, where: `${h.label} · ${a.provider === "codex" ? "Codex" : "Claude Code"}`, perm }))));
          const targets: AgentChoice[] = paseoHosts.filter((h) => h.connected).flatMap((h) => (["claude", "codex"] as const).map((provider) => ({ id: `paseo:${h.id}:${provider}`, name: `${provider === "claude" ? "Claude Code" : "Codex"} · ${h.label} (Paseo)`, model: "", working: false, paseo: { hostId: h.id, provider } })));
          desk.setPaseo(waiting, targets);
          opens.clear();
          for (const s of claw) if (s.open) opens.set(s.key, s.open);
          all = areaIds().flatMap((id) => seatsOf(id, now));
          // More people than an area has desks: the ones at work (or waiting on you) get the seats, then the freshest.
          office.setSeats([...all].sort((x, y) => (ORDER_FOR_SEATS[x.status] ?? 9) - (ORDER_FOR_SEATS[y.status] ?? 9)));
          if (!panel.hidden) briefing();
          // One line per computer: who's there, who's working, and whether it could be read at all.
          const lines = areaIds().map((id) => {
            const m = remotes.find((r) => r.id === id);
            const mine = all.filter((x) => x.machine === id);
            const working = mine.filter((x) => x.status === "working").length;
            const cap = office.capacity(id);
            const state = m && !m.reachable ? (m.fetchedAt ? " (연결 안 됨)" : " (읽는 중)") : "";
            const body = mine.length ? `${mine.length}명${working ? ` · 일하는 중 ${working}` : ""}${cap && mine.length > cap ? ` · 자리 ${cap}` : ""}` : "에이전트 없음";
            const ph = paseoHosts.find((h) => h.id === id);
            const paseoState = ph ? (ph.connected ? " · Paseo ✓" : " · Paseo 연결 안 됨") : "";
            return `${machineLabel(id)} ${body}${state}${paseoState}`;
          });
          (hud.querySelector(".claw-office-counts") as HTMLElement).textContent = lines.join("  ·  ");
        };

        const takeIntoPaseo = async (seat: Seat, imp: NonNullable<ReturnType<typeof importable>>) => {
          try {
            const r = await feature.invoke("paseo-import", imp);
            desk.say(`${seat.name}을(를) Paseo로 가져왔어요. 이제 여기와 Paseo 앱에서 같은 세션으로 이어져요.`);
            await pollPaseo();
            chat?.open(imp.hostId, r.agentId, seat.brief || seat.name);
          } catch (err) {
            desk.say(`가져오지 못했어요: ${String((err as Error)?.message ?? err)}`, true);
          }
        };

        // Where a Claude Code / Codex session opens when clicked: Paseo (default) or a terminal beside the office.
        // Nothing jumps to the dashboard's chat page any more. A session Paseo already runs always opens in Paseo,
        // since resuming it in a terminal would start a second process on the same conversation.
        const OPEN_STORE = "claw-office:open-with";
        let openWith: "paseo" | "terminal" = (() => {
          try { return localStorage.getItem(OPEN_STORE) === "terminal" ? "terminal" : "paseo"; } catch { return "paseo"; }
        })();
        const openMode = document.createElement("button");
        openMode.type = "button";
        openMode.className = "claw-office-openmode";
        const drawOpenMode = () => {
          openMode.textContent = openWith === "paseo" ? "열기: Paseo" : "열기: 터미널";
          openMode.title = openWith === "paseo" ? "세션을 누르면 Paseo 대화 창으로 열어요 (눌러서 터미널로 바꾸기)" : "세션을 누르면 옆 터미널에서 이어 가요 (눌러서 Paseo로 바꾸기)";
          openMode.classList.toggle("is-terminal", openWith === "terminal");
        };
        openMode.onclick = () => {
          openWith = openWith === "paseo" ? "terminal" : "paseo";
          try { localStorage.setItem(OPEN_STORE, openWith); } catch { /* storage blocked: this visit only */ }
          drawOpenMode();
          desk.say(openWith === "paseo" ? "이제 세션을 누르면 Paseo로 열어요." : "이제 세션을 누르면 터미널로 열어요. (Paseo가 맡은 세션은 계속 Paseo로 열려요)");
        };
        drawOpenMode();
        const topbar = document.createElement("div");
        topbar.className = "claw-office-topbar";
        toggle.replaceWith(topbar);
        topbar.append(openMode, toggle);

        const termTitle = (seat: Seat) => `${seat.name}${seat.brief ? ` · ${seat.brief.slice(0, 24)}` : ""}`;
        const inTerminal = (seat: Seat, loc: Locator) => {
          const cwd = seat.machine === HOME.id ? locals.find((l) => l.id === loc.threadId)?.cwd : undefined;
          void terms?.openCatalog(loc, termTitle(seat), cwd);
        };
        /** Whether clicking does anything for this worker (another computer's OpenClaw agent only shows what it's doing). */
        const canOpen = (seat: Seat) => seat.key.startsWith("openclaw:") || !!paseoOf(seat) || !!importable(seat) || !!locatorOf(seat);

        const openSeat = (seat: Seat, from: "office" | "briefing") => {
          // OpenClaw agents: a click in the office gives them work; from the briefing, their own TUI in the terminal.
          if (seat.key.startsWith("openclaw:")) {
            const agentId = seat.key.slice("openclaw:".length);
            if (from === "office") return desk.assign(agentId);
            return void terms?.openNew("openclaw", { agentId, sessionKey: opens.get(seat.key)?.sessionKey, title: `OpenClaw · ${seat.name}` });
          }
          const pa = paseoOf(seat);
          if (pa) return chat?.open(pa.hostId, pa.agentId, seat.brief || seat.name);
          const loc = locatorOf(seat);
          const imp = importable(seat);
          if (openWith === "paseo" && imp) {
            // Still writing in some terminal: taking it now would put two processes on one conversation.
            if (seat.status === "working") return desk.say(`${seat.name}은(는) 지금 다른 터미널에서 일하는 중이에요. 그 claude를 끝낸 뒤 다시 누르면 Paseo로 가져와요.`, true);
            return void takeIntoPaseo(seat, imp);
          }
          if (openWith === "paseo" && (seat.tool === "claude" || seat.tool === "codex") && loc) desk.say(`${machineLabel(seat.machine)}에 Paseo가 연결돼 있지 않아 터미널로 열었어요.`);
          if (loc) {
            if (seat.status === "working") desk.say(`${seat.name}은(는) 다른 곳에서도 일하는 중이에요. 터미널 쪽 입력은 그 세션에 함께 들어가요.`);
            return inTerminal(seat, loc);
          }
        };

        office.onHover = (seat) => {
          tip.hidden = !seat;
          if (!seat) return;
          const imp = importable(seat);
          const how = seat.key.startsWith("openclaw:") ? "  (눌러서 일 맡기기)"
            : paseoOf(seat) ? (seat.status === "needs_input" ? "  (눌러서 권한 답하기)" : "  (눌러서 Paseo로 이어 가기)")
            : openWith === "paseo" && imp ? "  (눌러서 Paseo로 가져와 이어 가기)"
            : locatorOf(seat) ? "  (눌러서 옆 터미널에서 이어 가기)"
            : seat.machine !== HOME.id ? `  (${machineLabel(seat.machine)}에 Paseo나 노드가 연결되면 열 수 있어요)` : "";
          tip.textContent = `${machineLabel(seat.machine)} · ${seat.name} — ${seat.brief || seat.card}${seat.actions.length ? ` · ${seat.actions.at(-1)}` : ""}${how}`;
        };
        office.onPick = (seat) => openSeat(seat, "office");

        const sub = context.host.sessions.observe({ configuredAgentsOnly: true, archived: false, limit: 80, includeDerivedTitles: true }, (snap) => {
          if (snap.result) sessions = snap.result.sessions;
          render();
        });
        const unsub = context.host.subscribe(() => {
          agents = context.host.agents.rows as readonly AgentRow[];
          render();
        });
        const poll = async () => {
          try {
            const r = await feature.invoke("local-sessions", { hours: 6 });
            if (context.signal.aborted) return;
            locals = r.sessions;
            error.hidden = true;
          } catch (e) {
            if (context.signal.aborted) return;
            error.hidden = false;
            error.textContent = `로컬 세션을 읽지 못했습니다: ${String((e as Error)?.message ?? e)}`;
          }
          render();
        };
        /** Each computer's Paseo agents and what they wait on (the Gateway reads every daemon at most every 1.5 s). */
        async function pollPaseo() {
          try {
            const r = await feature.invoke("paseo-agents", {});
            if (context.signal.aborted) return;
            paseoHosts = r.hosts;
          } catch { /* no Paseo support on this Gateway yet: the office works as before */ }
          render();
        }
        const pollRemote = async () => {
          try {
            const r = await feature.invoke("remote-machines", {});
            if (context.signal.aborted) return;
            remotes = r.machines;
          } catch { /* the next poll tries again; this floor keeps what it had */ }
          render();
        };
        void poll();
        // AGY and GJC sessions, and which paired node is which computer (from the cheap Pi catalog's host list).
        const pollCatalogs = async () => {
          const next: Record<string, CatalogHost[]> = {};
          for (const k of [...CATALOG_KINDS, "pi"]) {
            try {
              const r = await context.host.request<{ catalogs?: { id: string; hosts?: CatalogHost[] }[] }>("sessions.catalog.list", { catalogId: k });
              next[k] = r?.catalogs?.find((c) => c.id === k)?.hosts ?? [];
            } catch { next[k] = catalogs[k] ?? []; }
            if (context.signal.aborted) return;
          }
          catalogs = next;
          nodeHosts = new Map(Object.values(next).flat().flatMap((h) => {
            const m = machineOfHost(h);
            return m && m !== HOME.id && h.hostId.startsWith("node:") ? [[m, h.hostId] as [string, string]] : [];
          }));
          render();
        };
        void pollRemote();
        void pollCatalogs();
        void pollPaseo();
        const paseoTimer = setInterval(() => { if (!document.hidden) void pollPaseo(); }, PASEO_POLL_MS);
        // Each computer's health for the boards on the north wall (the Gateway reads it every 20 s in the background).
        const pollStats = async () => {
          try {
            const r = await feature.invoke("machine-stats", {});
            if (!context.signal.aborted) office.setStats(r.machines);
          } catch { /* the boards keep their last reading */ }
        };
        void pollStats();
        const statsTimer = setInterval(() => { if (!document.hidden) void pollStats(); }, 20_000);
        const catalogTimer = setInterval(() => { if (!document.hidden) void pollCatalogs(); }, CATALOG_POLL_MS);
        const remoteTimer = setInterval(() => { if (!document.hidden) void pollRemote(); }, POLL_MS * 3);
        const timer = setInterval(() => {
          if (!document.hidden) void poll();
          else render();
        }, POLL_MS);
        office.ready.then(() => {
          if (context.signal.aborted) return;
          render();
        }, (e) => {
          error.hidden = false;
          error.textContent = `사무실을 짓지 못했습니다: ${String((e as Error)?.message ?? e)}`;
        });
        if (context.presented) office.start();

        return {
          update(next) {
            if (next.presented) office.start();
            else office.stop();
          },
          dispose() {
            clearInterval(timer);
            clearInterval(remoteTimer);
            clearInterval(catalogTimer);
            clearInterval(statsTimer);
            clearInterval(paseoTimer);
            chat?.dispose();
            terms?.dispose();
            sub.dispose();
            unsub();
            desk.dispose();
            office.dispose();
            root.remove();
          },
        };
      },
    });
  },
});
