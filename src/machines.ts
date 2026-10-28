import { spawn } from "node:child_process";
import type { ScannedSession } from "./scan.js";
import remoteScript from "virtual:remote-script";

// The other computers on the tailnet, each read over SSH every REFRESH_MS in the background: the
// query answers from the last reading at once, so a slow or sleeping computer never holds up the office.

export interface MachineDef {
  id: string;
  label: string;
  /** SSH host (from ~/.ssh/config); the login shell that puts node and openclaw on its PATH. */
  ssh: string;
  shell: "zsh" | "bash";
  /** No Node there: only whether it answers. */
  probeOnly?: boolean;
}

export const MACHINES: MachineDef[] = [
  { id: "m2max", label: "M2 Max", ssh: "computer-c", shell: "zsh" },
  { id: "a4000", label: "A4000", ssh: "a4000-wsl", shell: "bash", probeOnly: true },
];

export interface RemoteAgent { id: string; model: string; sessions: number; updatedAt: number }
export interface Reading {
  id: string;
  label: string;
  reachable: boolean;
  error: string;
  fetchedAt: number;
  agents: RemoteAgent[];
  sessions: ScannedSession[];
}

const REFRESH_MS = 30_000;
const TIMEOUT_MS = 45_000;
const readings = new Map<string, Reading>();
const busy = new Set<string>();

function run(def: MachineDef, input: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = input === null ? "echo ok" : `${def.shell} -lc 'node -'`;
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", def.ssh, cmd], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").pop() || `ssh exited ${code}`));
    });
    child.stdin.end(input ?? "");
  });
}

function agentsFrom(raw: { agents?: unknown[]; sessions?: { agentId: string; updatedAt: number }[] }): RemoteAgent[] {
  const sessions = raw.sessions ?? [];
  return (raw.agents ?? []).map((a) => {
    const r = a as { id?: string; model?: unknown };
    const id = String(r.id ?? "");
    const own = sessions.filter((s) => s.agentId === id);
    const model = typeof r.model === "string" ? r.model : r.model && typeof r.model === "object" && typeof (r.model as { primary?: unknown }).primary === "string" ? (r.model as { primary: string }).primary : "";
    return { id, model, sessions: own.length, updatedAt: own.reduce((m, s) => Math.max(m, s.updatedAt), 0) };
  }).filter((a) => a.id);
}

async function refresh(def: MachineDef) {
  if (busy.has(def.id)) return;
  busy.add(def.id);
  const prev = readings.get(def.id);
  try {
    if (def.probeOnly) {
      await run(def, null);
      readings.set(def.id, { id: def.id, label: def.label, reachable: true, error: "", fetchedAt: Date.now(), agents: [], sessions: [] });
    } else {
      const raw = JSON.parse(await run(def, remoteScript));
      readings.set(def.id, { id: def.id, label: def.label, reachable: true, error: "", fetchedAt: Date.now(), agents: agentsFrom(raw), sessions: (raw.local ?? []).slice(0, 32) });
    }
  } catch (e) {
    // Keeps what it last saw, marked unreachable, and waits a full REFRESH_MS before trying again.
    readings.set(def.id, { ...(prev ?? { id: def.id, label: def.label, agents: [], sessions: [] }), fetchedAt: Date.now(), reachable: false, error: String((e as Error).message ?? e).slice(0, 200) });
  } finally {
    busy.delete(def.id);
  }
}

/** The latest reading of each computer, starting a fresh one for any older than REFRESH_MS. */
export function machines(now = Date.now()): Reading[] {
  return MACHINES.map((def) => {
    const r = readings.get(def.id);
    if (!r || now - r.fetchedAt > REFRESH_MS) void refresh(def);
    return r ?? { id: def.id, label: def.label, reachable: false, error: "읽는 중", fetchedAt: 0, agents: [], sessions: [] };
  });
}
