import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

// Each computer's Paseo daemon, one connection each from the Gateway. Paseo owns the Claude Code and Codex
// processes, so a prompt sent here goes into the very session that is running (not a second `--resume`
// process), and its permission requests come back as data the office can show and answer.
//
// Which daemons: ~/.claw-office/paseo.json, e.g.
//   { "hosts": [ { "id": "m5", "label": "M5", "url": "ws://127.0.0.1:6767/ws" },
//                { "id": "m2max", "label": "M2 Max", "url": "ws://100.64.0.2:6767/ws", "password": "…" } ] }
// The id is the office area the host's agents sit in (m5, m2max, a4000). Without the file, only this computer's
// daemon at its default address.

export interface HostDef { id: string; label: string; url: string; password?: string }

const CONFIG = join(homedir(), ".claw-office", "paseo.json");
const DEFAULT_HOSTS: HostDef[] = [{ id: "m5", label: "M5", url: "ws://127.0.0.1:6767/ws" }];
// One reading of every daemon serves every open office tab for this long.
const CACHE_MS = 1_500;
const CONNECT_TIMEOUT_MS = 6_000;
const AGENT_LIMIT = 60;

function hostsFromConfig(): HostDef[] {
  try {
    const raw = JSON.parse(readFileSync(CONFIG, "utf8")) as { hosts?: unknown };
    const hosts = (Array.isArray(raw.hosts) ? raw.hosts : []).flatMap((h): HostDef[] => {
      const r = h as Partial<HostDef>;
      if (typeof r.id !== "string" || typeof r.url !== "string" || !/^wss?:\/\//.test(r.url)) return [];
      return [{ id: r.id.slice(0, 40), label: String(r.label ?? r.id).slice(0, 80), url: r.url, ...(typeof r.password === "string" && r.password ? { password: r.password } : {}) }];
    });
    return hosts.length ? hosts.slice(0, 8) : DEFAULT_HOSTS;
  } catch {
    return DEFAULT_HOSTS;
  }
}

// ── What the office sees ──

export interface PaseoPermission {
  id: string;
  /** The tool or request name (Write, Bash, ExitPlanMode…). */
  name: string;
  kind: string;
  /** One line: what it wants to do. */
  summary: string;
  /** More of it (the command, the plan, the new file's start), when there is more to show. */
  detail: string;
  /** Buttons the provider offers instead of plain allow/deny (a plan's "implement", say). */
  actions: { id: string; label: string; behavior: "allow" | "deny" }[];
  /** True when the provider offers "allow edits for the rest of this session". */
  canAcceptEdits: boolean;
}

export interface PaseoAgentRow {
  id: string;
  provider: string;
  model: string;
  title: string;
  cwd: string;
  project: string;
  status: string;
  mode: string;
  updatedAt: number;
  /** The provider's own session id (Claude Code's JSONL name), to match it with the logs the office reads. */
  sessionId: string;
  attention: string;
  lastError: string;
  permissions: PaseoPermission[];
}

export interface PaseoHostReading { id: string; label: string; connected: boolean; error: string; agents: PaseoAgentRow[] }

export interface PaseoTimelineItem { kind: "user" | "assistant" | "reasoning" | "tool" | "todo" | "error" | "note"; text: string; at: number; status: string }

// ── Connections ──

interface Conn { def: HostDef; client: DaemonClient; ready: Promise<void> | null; error: string }
const conns = new Map<string, Conn>();

function conn(def: HostDef): Conn {
  const key = `${def.id}|${def.url}|${def.password ?? ""}`;
  const found = conns.get(def.id);
  if (found && `${found.def.id}|${found.def.url}|${found.def.password ?? ""}` === key) return found;
  if (found) void found.client.close().catch(() => undefined);
  const client = new DaemonClient({
    url: def.url,
    clientId: `claw-office-${def.id}`,
    clientType: "cli",
    appVersion: "claw-office/0.2.0",
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    reconnect: { enabled: true, baseDelayMs: 1_000, maxDelayMs: 30_000 },
    ...(def.password ? { password: def.password } : {}),
  });
  const c: Conn = { def, client, ready: null, error: "" };
  conns.set(def.id, c);
  return c;
}

async function connected(def: HostDef): Promise<DaemonClient> {
  const c = conn(def);
  if (c.client.getConnectionState().status === "connected") return c.client;
  c.ready ??= c.client.connect().then(() => { c.error = ""; }, (e: unknown) => {
    c.error = message(e);
    throw e;
  }).finally(() => (c.ready = null));
  await c.ready;
  return c.client;
}

function message(e: unknown): string {
  const text = String((e as Error)?.message ?? e);
  if (/ECONNREFUSED|connect|timed? ?out/i.test(text)) return "Paseo 데몬에 연결하지 못했어요 (paseo daemon start)";
  if (/password/i.test(text)) return "Paseo 데몬 비밀번호가 맞지 않아요";
  return text.slice(0, 200);
}

function hostDef(hostId: string): HostDef {
  const def = hostsFromConfig().find((h) => h.id === hostId);
  if (!def) throw new Error(`Paseo 호스트 ${hostId}를 찾지 못했어요`);
  return def;
}

/** Closes every daemon connection (the plugin is being unloaded; its reconnect timers would otherwise keep it alive). */
export async function closePaseo(): Promise<void> {
  const all = [...conns.values()];
  conns.clear();
  cached = null;
  await Promise.allSettled(all.map((c) => c.client.close()));
}

// ── Reading ──

const one = (text: unknown, max = 160) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");
const short = (path: unknown) => (typeof path === "string" ? basename(path) : "");

type Detail = { type?: string; command?: string; filePath?: string; query?: string; url?: string; description?: string; text?: string; content?: string; oldString?: string; newString?: string; plan?: string } | undefined;

/** One line for a tool call or request, the way scan.ts writes the session logs' tool calls. */
function describe(name: string, detail: Detail, input: Record<string, unknown> | undefined): { summary: string; more: string } {
  switch (detail?.type) {
    case "shell": return { summary: `$ ${one(detail.command)}`, more: String(detail.command ?? "").slice(0, 2000) };
    case "write": return { summary: `✎ ${short(detail.filePath)} (새로 쓰기)`, more: `${detail.filePath ?? ""}\n\n${String(detail.content ?? "").slice(0, 1200)}` };
    case "edit": return { summary: `✎ ${short(detail.filePath)}`, more: String(detail.filePath ?? "") };
    case "read": return { summary: `▸ ${short(detail.filePath)}`, more: String(detail.filePath ?? "") };
    case "search": return { summary: `⌕ ${one(detail.query)}`, more: "" };
    case "fetch": return { summary: `🌐 ${one(detail.url)}`, more: String(detail.url ?? "") };
    case "sub_agent": return { summary: `🤝 ${one(detail.description)}`, more: "" };
    case "plan": return { summary: "📝 계획 승인 요청", more: String(detail.plan ?? detail.text ?? "").slice(0, 4000) };
    case "plain_text": return { summary: `• ${name}`, more: String(detail.text ?? "").slice(0, 2000) };
  }
  const json = input ? JSON.stringify(input) : "";
  return { summary: `• ${name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name}${json ? ` ${one(json, 100)}` : ""}`, more: json.slice(0, 2000) };
}

type RawPermission = { id: string; name: string; kind: string; title?: string; description?: string; input?: Record<string, unknown>; detail?: Detail; suggestions?: { type?: string; mode?: string }[]; actions?: { id: string; label: string; behavior: "allow" | "deny" }[] };

function permissionRow(p: RawPermission): PaseoPermission {
  const d = describe(p.name, p.detail, p.input);
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    summary: (p.title ? `${p.title} — ${d.summary}` : d.summary).slice(0, 240),
    detail: [p.description && p.description !== "-" ? p.description : "", d.more].filter(Boolean).join("\n\n").slice(0, 4000),
    actions: (p.actions ?? []).slice(0, 4).map((a) => ({ id: a.id, label: a.label.slice(0, 60), behavior: a.behavior })),
    canAcceptEdits: (p.suggestions ?? []).some((s) => s.type === "setMode" && s.mode === "acceptEdits"),
  };
}

type RawAgent = { id: string; provider: string; model?: string | null; cwd: string; title?: string | null; status: string; currentModeId?: string | null; updatedAt: string; archivedAt?: string | null; pendingPermissions?: RawPermission[]; persistence?: { sessionId?: string } | null; runtimeInfo?: { sessionId?: string | null } | null; requiresAttention?: boolean; attentionReason?: string | null; lastError?: string | null };

function agentRow(a: RawAgent): PaseoAgentRow {
  return {
    id: a.id,
    provider: a.provider,
    model: a.model ?? "",
    title: one(a.title, 200),
    cwd: a.cwd.slice(0, 400),
    project: (basename(a.cwd) || a.cwd).slice(0, 200),
    status: a.status,
    mode: a.currentModeId ?? "",
    updatedAt: Date.parse(a.updatedAt) || 0,
    sessionId: a.persistence?.sessionId ?? a.runtimeInfo?.sessionId ?? "",
    attention: a.requiresAttention ? a.attentionReason ?? "attention" : "",
    lastError: one(a.lastError, 240),
    permissions: (a.pendingPermissions ?? []).map(permissionRow),
  };
}

async function readHost(def: HostDef): Promise<PaseoHostReading> {
  try {
    const client = await connected(def);
    const r = await client.fetchAgents({ sort: [{ key: "updated_at", direction: "desc" }], page: { limit: AGENT_LIMIT } });
    const agents = r.entries.map((e) => e.agent as unknown as RawAgent).filter((a) => !a.archivedAt && a.status !== "closed").map(agentRow);
    return { id: def.id, label: def.label, connected: true, error: "", agents };
  } catch (e) {
    return { id: def.id, label: def.label, connected: false, error: conns.get(def.id)?.error || message(e), agents: [] };
  }
}

let cached: { at: number; hosts: PaseoHostReading[] } | null = null;
let reading: Promise<PaseoHostReading[]> | null = null;

/** Every configured daemon's agents (archived and closed ones left out), newest first. */
export async function paseoAgents(now = Date.now()): Promise<PaseoHostReading[]> {
  if (cached && now - cached.at <= CACHE_MS) return cached.hosts;
  reading ??= Promise.all(hostsFromConfig().map(readHost)).then((hosts) => {
    cached = { at: Date.now(), hosts };
    return hosts;
  }).finally(() => (reading = null));
  return reading;
}

const forget = () => (cached = null);

type RawTimelineEntry = { item: { type: string; text?: string; name?: string; detail?: Detail; status?: string; error?: unknown; message?: string; items?: { text?: string; content?: string; status?: string; completed?: boolean }[] }; timestamp: string };

function timelineItem(e: RawTimelineEntry): PaseoTimelineItem | null {
  const at = Date.parse(e.timestamp) || 0;
  const it = e.item;
  switch (it.type) {
    case "user_message": return { kind: "user", text: String(it.text ?? "").slice(0, 4000), at, status: "" };
    case "assistant_message": return { kind: "assistant", text: String(it.text ?? "").slice(0, 8000), at, status: "" };
    case "reasoning": return { kind: "reasoning", text: one(it.text, 400), at, status: "" };
    case "tool_call": {
      const d = describe(String(it.name ?? "tool"), it.detail, undefined);
      return { kind: "tool", text: d.summary, at, status: String(it.status ?? "") };
    }
    case "todo": return { kind: "todo", text: (it.items ?? []).map((t) => `${t.completed || t.status === "completed" ? "☑" : "☐"} ${one(t.text ?? t.content, 120)}`).join("\n"), at, status: "" };
    case "error": return { kind: "error", text: one(it.message, 600), at, status: "" };
    case "notification": return { kind: "note", text: one(it.message, 400), at, status: "" };
    default: return null;
  }
}

/** The agent's latest conversation, oldest first: what was asked, what it said, and one line per tool call. */
export async function paseoTimeline(hostId: string, agentId: string, limit = 60): Promise<{ items: PaseoTimelineItem[]; agent: PaseoAgentRow | null }> {
  const client = await connected(hostDef(hostId));
  const r = await client.fetchAgentTimeline(agentId, { direction: "tail", limit, projection: "projected" });
  const items = (r.entries as unknown as RawTimelineEntry[]).map(timelineItem).filter((x): x is PaseoTimelineItem => x !== null);
  const agent = r.agent ? agentRow(r.agent as unknown as RawAgent) : null;
  return { items, agent };
}

// ── Acting ──

/** Goes into the running session. Mid-turn it steers the turn (like typing while Claude works) unless told to interrupt. */
export async function paseoSend(hostId: string, agentId: string, text: string, interrupt = false): Promise<void> {
  const client = await connected(hostDef(hostId));
  await client.sendMessage(agentId, text, { activeTurnBehavior: interrupt ? "interrupt" : "steer" });
  forget();
}

export async function paseoPermit(hostId: string, agentId: string, requestId: string, answer: { allow: boolean; actionId?: string; message?: string; acceptEdits?: boolean }): Promise<void> {
  const client = await connected(hostDef(hostId));
  const response = answer.allow
    ? { behavior: "allow" as const, ...(answer.actionId ? { selectedActionId: answer.actionId } : {}), ...(answer.acceptEdits ? { updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } : {}) }
    : { behavior: "deny" as const, ...(answer.actionId ? { selectedActionId: answer.actionId } : {}), message: answer.message || "사용자가 거절했어요." };
  await client.respondToPermission(agentId, requestId, response as never);
  forget();
}

export async function paseoStop(hostId: string, agentId: string): Promise<void> {
  const client = await connected(hostDef(hostId));
  await client.cancelAgent(agentId);
  forget();
}

export async function paseoCreate(input: { hostId: string; provider: "claude" | "codex"; cwd: string; prompt: string; title?: string; mode?: string }): Promise<string> {
  const client = await connected(hostDef(input.hostId));
  const snap = await client.createAgent({
    provider: input.provider,
    cwd: input.cwd,
    initialPrompt: input.prompt,
    ...(input.title ? { title: input.title } : {}),
    ...(input.mode ? { modeId: input.mode } : {}),
    labels: { "claw-office": "1" },
  });
  forget();
  return snap.id;
}

/** Brings a session started outside Paseo (in a terminal, say) under Paseo, so the office can drive it. */
export async function paseoImport(input: { hostId: string; provider: "claude" | "codex"; sessionId: string; cwd?: string }): Promise<string> {
  const client = await connected(hostDef(input.hostId));
  const snap = await client.importAgent({ provider: input.provider, sessionId: input.sessionId, ...(input.cwd ? { cwd: input.cwd } : {}), labels: { "claw-office": "1" } });
  forget();
  return snap.id;
}
