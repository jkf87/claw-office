import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { scanSessions } from "./scan.js";

// Runs on another computer, piped over SSH into `node -` (see machines.ts): prints that computer's
// OpenClaw agents and recent sessions, and its Claude Code and Codex session logs, as one line of JSON.
// The OpenClaw CLI gives no message text in these listings, only ids, models and times.

function json(args: string[]): unknown {
  try {
    return JSON.parse(execFileSync("openclaw", args, { encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

const agents = json(["agents", "list", "--json"]);
const listed = json(["sessions", "list", "--all-agents", "--active", "1440", "--json", "--limit", "300"]) as { sessions?: unknown[] } | null;
const sessions = (listed?.sessions ?? []).map((s) => {
  const r = s as { agentId?: string; updatedAt?: number; key?: string };
  return { agentId: r.agentId ?? "", updatedAt: r.updatedAt ?? 0, key: r.key ?? "" };
});
void scanSessions(homedir(), 6).then((local) => process.stdout.write(JSON.stringify({ agents: Array.isArray(agents) ? agents : [], sessions, local })));
