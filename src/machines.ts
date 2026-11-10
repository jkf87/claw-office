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
  /** How to start node there, reading the script from stdin, when it isn't the login shell's `node`
   * (the A4000's WSL has none: Windows' own, through WSL's interop, from a Windows folder). */
  node?: string;
}

export const MACHINES: MachineDef[] = [
  { id: "m2max", label: "M2 Max", ssh: "computer-c", shell: "zsh" },
  { id: "a4000", label: "A4000", ssh: "a4000-wsl", shell: "bash", node: `cd /mnt/c && '/mnt/c/Program Files/nodejs/node.exe' -` },
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
// SSH reads still under way, so a plugin reload can end them instead of waiting out their timeout.
const children = new Set<import("node:child_process").ChildProcess>();
let stopped = false;

function run(def: MachineDef, input: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = input === null ? "echo ok" : def.node ?? `${def.shell} -lc 'node -'`;
    if (stopped) return reject(new Error("stopped"));
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", def.ssh, cmd], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    child.on("exit", () => children.delete(child));
    let out = "";
    let err = "";
    // Settles once, on our own clock too: after the Mac sleeps an ssh can be killed yet never report "close",
    // and a read that never settles would keep this computer "being read" (so never read again) for good.
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(new Error("ssh timed out")));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => settle(() => reject(e)));
    child.on("close", (code) => settle(() => (code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").pop() || `ssh exited ${code}`)))));
    child.stdin.on("error", () => { /* the ssh died before reading its input: "close" says why */ });
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

/** Lets readings start again (the service started, or started again after a stop). */
export function startMachines() {
  stopped = false;
}

/** Ends every SSH read under way and starts no more (the plugin is being unloaded). */
export function stopMachines() {
  stopped = true;
  for (const c of children) c.kill("SIGKILL");
  children.clear();
}

/** The latest reading of each computer, starting a fresh one for any older than REFRESH_MS. */
export function machines(now = Date.now()): Reading[] {
  return MACHINES.map((def) => {
    const r = readings.get(def.id);
    if (!stopped && (!r || now - r.fetchedAt > REFRESH_MS)) void refresh(def);
    return r ?? { id: def.id, label: def.label, reachable: false, error: "읽는 중", fetchedAt: 0, agents: [], sessions: [] };
  });
}
