import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scanSessions } from "./scan.js";

// Runs on another computer, piped over SSH into `node -` (see machines.ts): prints that computer's
// OpenClaw agents and recent sessions, and its Claude Code and Codex session logs, as one line of JSON.
// The OpenClaw CLI gives no message text in these listings, only ids, models and times.
//
// On Windows (the A4000, reached through its WSL and run by Windows' own node) the agents belong to
// whichever Windows account runs them, not the one SSH lands in: every profile beside this one with a
// .claude, .codex or .openclaw folder is read too. Without the OpenClaw CLI on the PATH there, its agents
// come from their folders: the name of each, and when its sessions folder last changed.

function json(args: string[]): unknown {
  try {
    return JSON.parse(execFileSync("openclaw", args, { encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

/** The homes to read: this account's, and on Windows every profile that has agents in it. */
function homes(): string[] {
  if (process.platform !== "win32") return [homedir()];
  const root = join(homedir(), "..");
  const found = new Set([homedir()]);
  try {
    for (const name of readdirSync(root)) {
      const h = join(root, name);
      if ([".claude", ".codex", ".openclaw"].some((d) => existsSync(join(h, d)))) found.add(h);
    }
  } catch { /* this account's own only */ }
  return [...found];
}

const mtime = (p: string) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** OpenClaw agents read from their folders, for a computer whose OpenClaw CLI isn't on the PATH. */
function agentsFromFolders(list: string[]) {
  const agents: { id: string }[] = [];
  const sessions: { agentId: string; updatedAt: number; key: string }[] = [];
  for (const h of list) {
    const dir = join(h, ".openclaw", "agents");
    let ids: string[] = [];
    try {
      ids = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
    } catch {
      continue;
    }
    for (const id of ids) {
      if (agents.some((a) => a.id === id)) continue;
      agents.push({ id });
      const s = join(dir, id, "sessions");
      let last = mtime(s);
      try {
        for (const f of readdirSync(s)) if (!f.includes(".deleted.")) last = Math.max(last, mtime(join(s, f)));
      } catch { /* no sessions yet */ }
      // Only the last day's activity counts, as the CLI's --active 1440 does.
      if (last > Date.now() - 86_400_000) sessions.push({ agentId: id, updatedAt: last, key: `${id}:folder` });
    }
  }
  return { agents, sessions };
}

const list = homes();
const cliAgents = json(["agents", "list", "--json"]);
const fromCli = Array.isArray(cliAgents);
const listed = fromCli ? (json(["sessions", "list", "--all-agents", "--active", "1440", "--json", "--limit", "300"]) as { sessions?: unknown[] } | null) : null;
const folders = fromCli ? null : agentsFromFolders(list);
const sessions = folders
  ? folders.sessions
  : (listed?.sessions ?? []).map((s) => {
      const r = s as { agentId?: string; updatedAt?: number; key?: string };
      return { agentId: r.agentId ?? "", updatedAt: r.updatedAt ?? 0, key: r.key ?? "" };
    });
void Promise.all(list.map((h) => scanSessions(h, 6).catch(() => []))).then((each) => {
  const local = each.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  process.stdout.write(JSON.stringify({ agents: fromCli ? cliAgents : (folders?.agents ?? []), sessions, local }));
});
