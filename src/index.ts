import { homedir } from "node:os";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";
import { machines, startMachines, stopMachines } from "./machines.js";
import { scanSessions, type ScannedSession } from "./scan.js";
import { trustFolder } from "./trust.js";
import { machineStats, startStats, stopStats } from "./stats.js";
import { closePaseo, paseoAgents, paseoCreate, paseoImport, paseoPermit, paseoSend, paseoSetMode, paseoStop, paseoTimeline } from "./paseo.js";

// Every open office tab polls this; one reading serves them all for CACHE_MS, and a reading already under
// way is shared rather than started again, so the logs are read at most once per CACHE_MS however many tabs ask.
const CACHE_MS = 9_000;
let cached: { hours: number; at: number; sessions: ScannedSession[] } | null = null;
let reading: Promise<ScannedSession[]> | null = null;

async function sessionsFor(hours: number, now: number): Promise<ScannedSession[]> {
  if (cached && cached.hours === hours && now - cached.at <= CACHE_MS) return cached.sessions;
  reading ??= scanSessions(homedir(), hours, now).then((sessions) => {
    cached = { hours, at: now, sessions };
    return sessions;
  }).finally(() => (reading = null));
  return reading;
}

export default defineFeaturePlugin({
  contract,
  name: "Claw Office",
  description: "A 3D office of this computer's and the tailnet's agents in the Control UI.",
  setup(api) {
    // Everything long-lived (SSH reads, Paseo connections) ends when the Gateway unloads or replaces the plugin,
    // so a reload doesn't wait out their timeouts ("plugin host cleanup timed out").
    api.registerService({
      id: "claw-office-background",
      start: () => {
        startMachines();
        startStats();
      },
      stop: async () => {
        stopMachines();
        stopStats();
        await closePaseo();
      },
    });
    return {
      "local-sessions": async ({ hours }) => {
        const now = Date.now();
        return { now, sessions: await sessionsFor(hours ?? 6, now) };
      },
      "remote-machines": () => ({ now: Date.now(), machines: machines() }),
      "machine-stats": () => ({ machines: machineStats() }),
      "trust-folder": async ({ tool, cwd }) => ({ changed: await trustFolder(tool, cwd) }),
      "paseo-agents": async () => ({ now: Date.now(), hosts: await paseoAgents() }),
      "paseo-timeline": ({ hostId, agentId, limit }) => paseoTimeline(hostId, agentId, limit ?? 60),
      "paseo-send": async ({ hostId, agentId, text, interrupt }) => (await paseoSend(hostId, agentId, text, interrupt ?? false), { ok: true }),
      "paseo-permit": async ({ hostId, agentId, requestId, allow, actionId, acceptEdits, message }) => (await paseoPermit(hostId, agentId, requestId, { allow, actionId, acceptEdits, message }), { ok: true }),
      "paseo-mode": async ({ hostId, agentId, mode }) => (await paseoSetMode(hostId, agentId, mode), { ok: true }),
      "paseo-stop": async ({ hostId, agentId }) => (await paseoStop(hostId, agentId), { ok: true }),
      "paseo-create": async (input) => ({ agentId: await paseoCreate(input) }),
      "paseo-import": async (input) => ({ agentId: await paseoImport(input) }),
    };
  },
});
