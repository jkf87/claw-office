import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

const LocalSession = Type.Object({
  id: Type.String({ maxLength: 120 }),
  cwd: Type.String({ maxLength: 400 }),
  tool: Type.Union([Type.Literal("claude"), Type.Literal("codex")]),
  project: Type.String({ maxLength: 200 }),
  updatedAt: Type.Number(),
  state: Type.Union([Type.Literal("working"), Type.Literal("done"), Type.Literal("idle")]),
  /** The session's own title (Claude's custom/ai title, Codex's thread name); empty when it has none. */
  title: Type.String({ maxLength: 200 }),
  /** Its latest tool calls, oldest first: commands it ran and files it read or changed, never message text. */
  actions: Type.Array(Type.String({ maxLength: 160 }), { maxItems: 12 }),
});

const RemoteAgent = Type.Object({
  id: Type.String({ maxLength: 120 }),
  model: Type.String({ maxLength: 200 }),
  sessions: Type.Integer(),
  updatedAt: Type.Number(),
});

const Machine = Type.Object({
  id: Type.String({ maxLength: 40 }),
  label: Type.String({ maxLength: 80 }),
  reachable: Type.Boolean(),
  error: Type.String({ maxLength: 240 }),
  fetchedAt: Type.Number(),
  agents: Type.Array(RemoteAgent, { maxItems: 64 }),
  sessions: Type.Array(LocalSession, { maxItems: 40 }),
});

const Gpu = Type.Object({ name: Type.String({ maxLength: 120 }), util: Type.Number(), memUsed: Type.Number(), memTotal: Type.Number(), temp: Type.Number() });
const MachineStats = Type.Object({
  id: Type.String({ maxLength: 40 }),
  label: Type.String({ maxLength: 80 }),
  ok: Type.Boolean(),
  error: Type.String({ maxLength: 240 }),
  at: Type.Number(),
  cores: Type.Number(),
  cpu: Type.Number(),
  memUsed: Type.Number(),
  memTotal: Type.Number(),
  diskUsed: Type.Number(),
  diskTotal: Type.Number(),
  uptime: Type.Number(),
  gpu: Type.Union([Gpu, Type.Null()]),
});

const PaseoPermission = Type.Object({
  id: Type.String({ maxLength: 200 }),
  name: Type.String({ maxLength: 200 }),
  kind: Type.String({ maxLength: 40 }),
  summary: Type.String({ maxLength: 240 }),
  detail: Type.String({ maxLength: 4000 }),
  actions: Type.Array(Type.Object({ id: Type.String({ maxLength: 120 }), label: Type.String({ maxLength: 60 }), behavior: Type.Union([Type.Literal("allow"), Type.Literal("deny")]) }), { maxItems: 4 }),
  canAcceptEdits: Type.Boolean(),
});

const PaseoAgent = Type.Object({
  id: Type.String({ maxLength: 120 }),
  provider: Type.String({ maxLength: 40 }),
  model: Type.String({ maxLength: 200 }),
  title: Type.String({ maxLength: 200 }),
  cwd: Type.String({ maxLength: 400 }),
  project: Type.String({ maxLength: 200 }),
  status: Type.String({ maxLength: 40 }),
  mode: Type.String({ maxLength: 80 }),
  updatedAt: Type.Number(),
  sessionId: Type.String({ maxLength: 120 }),
  attention: Type.String({ maxLength: 40 }),
  lastError: Type.String({ maxLength: 240 }),
  permissions: Type.Array(PaseoPermission, { maxItems: 16 }),
  modes: Type.Array(Type.Object({ id: Type.String({ maxLength: 80 }), label: Type.String({ maxLength: 80 }) }), { maxItems: 12 }),
});

const PaseoHost = Type.Object({
  id: Type.String({ maxLength: 40 }),
  label: Type.String({ maxLength: 80 }),
  connected: Type.Boolean(),
  error: Type.String({ maxLength: 240 }),
  agents: Type.Array(PaseoAgent, { maxItems: 60 }),
});

const PaseoTimelineItem = Type.Object({
  kind: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("reasoning"), Type.Literal("tool"), Type.Literal("todo"), Type.Literal("error"), Type.Literal("note")]),
  text: Type.String({ maxLength: 8000 }),
  at: Type.Number(),
  status: Type.String({ maxLength: 40 }),
});

const HostAgent = { hostId: Type.String({ minLength: 1, maxLength: 40 }), agentId: Type.String({ minLength: 1, maxLength: 120 }) };
const Cli = Type.Union([Type.Literal("claude"), Type.Literal("codex")]);
const Ok = Type.Object({ ok: Type.Boolean() });

export const contract = defineFeatureContract({
  pluginId: "claw-office",
  operations: {
    "local-sessions": {
      kind: "query",
      description: "Recent Claude Code and Codex CLI sessions on this machine, read from their session logs (titles, tool calls, timing; no message text).",
      input: Type.Object({ hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })) }, { additionalProperties: false }),
      output: Type.Object({ now: Type.Number(), sessions: Type.Array(LocalSession, { maxItems: 40 }) }),
    },
    "remote-machines": {
      kind: "query",
      description: "The other computers' OpenClaw agents and Claude Code/Codex sessions, read over SSH in the background (ids, models, titles, tool calls, timing; no message text).",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({ now: Type.Number(), machines: Type.Array(Machine, { maxItems: 8 }) }),
    },
    "machine-stats": {
      kind: "query",
      description: "CPU, memory, disk (and the A4000's GPU) of each computer, read in the background every 20 s.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({ machines: Type.Array(MachineStats, { maxItems: 8 }) }),
    },
    "trust-folder": {
      kind: "action",
      description: "Record a folder as trusted for Claude Code or Codex so a terminal opened there skips the trust question.",
      input: Type.Object({ tool: Type.Union([Type.Literal("claude"), Type.Literal("codex")]), cwd: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
      output: Type.Object({ changed: Type.Boolean() }),
    },
    "paseo-agents": {
      kind: "query",
      description: "Each computer's Paseo agents (Claude Code and Codex sessions Paseo runs): status, title, folder and the permission requests waiting on you.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({ now: Type.Number(), hosts: Type.Array(PaseoHost, { maxItems: 8 }) }),
    },
    "paseo-timeline": {
      kind: "query",
      description: "A Paseo agent's latest conversation: prompts, replies and one line per tool call.",
      input: Type.Object({ ...HostAgent, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }),
      output: Type.Object({ items: Type.Array(PaseoTimelineItem, { maxItems: 200 }), agent: Type.Union([PaseoAgent, Type.Null()]) }),
    },
    "paseo-send": {
      kind: "action",
      description: "Send a message into a running Paseo agent's own session (steers the current turn unless interrupt is set).",
      input: Type.Object({ ...HostAgent, text: Type.String({ minLength: 1, maxLength: 20000 }), interrupt: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      output: Ok,
    },
    "paseo-permit": {
      kind: "action",
      description: "Answer a Paseo agent's permission request: allow, allow and accept edits for the session, or deny.",
      input: Type.Object({
        ...HostAgent,
        requestId: Type.String({ minLength: 1, maxLength: 200 }),
        allow: Type.Boolean(),
        actionId: Type.Optional(Type.String({ maxLength: 120 })),
        acceptEdits: Type.Optional(Type.Boolean()),
        message: Type.Optional(Type.String({ maxLength: 2000 })),
      }, { additionalProperties: false }),
      output: Ok,
    },
    "paseo-stop": {
      kind: "action",
      description: "Interrupt a Paseo agent's current turn.",
      input: Type.Object(HostAgent, { additionalProperties: false }),
      output: Ok,
    },
    "paseo-create": {
      kind: "action",
      description: "Start a new Claude Code or Codex agent under Paseo in a folder on one computer, with its first prompt.",
      input: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 40 }),
        provider: Cli,
        cwd: Type.String({ minLength: 1, maxLength: 4096 }),
        prompt: Type.String({ minLength: 1, maxLength: 20000 }),
        title: Type.Optional(Type.String({ maxLength: 200 })),
        mode: Type.Optional(Type.String({ maxLength: 80 })),
      }, { additionalProperties: false }),
      output: Type.Object({ agentId: Type.String({ maxLength: 120 }) }),
    },
    "paseo-import": {
      kind: "action",
      description: "Bring a Claude Code or Codex session started outside Paseo under Paseo, so the office can drive it.",
      input: Type.Object({
        hostId: Type.String({ minLength: 1, maxLength: 40 }),
        provider: Cli,
        sessionId: Type.String({ minLength: 1, maxLength: 120 }),
        cwd: Type.Optional(Type.String({ maxLength: 4096 })),
        mode: Type.Optional(Type.String({ maxLength: 80 })),
      }, { additionalProperties: false }),
      output: Type.Object({ agentId: Type.String({ maxLength: 120 }) }),
    },
    "paseo-mode": {
      kind: "action",
      description: "Switch a Paseo agent's permission mode (default = ask every time, acceptEdits, auto, bypassPermissions, plan).",
      input: Type.Object({ ...HostAgent, mode: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false }),
      output: Ok,
    },
  },
  events: {},
});
