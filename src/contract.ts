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
  },
  events: {},
});
