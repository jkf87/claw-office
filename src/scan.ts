import { readFile, open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// Reads this computer's Claude Code and Codex session logs: which sessions wrote lately, their titles and
// their latest tool calls. Shared by the plugin (this computer) and remote.ts (the others, over SSH).
// All of it is asynchronous file I/O: in the Gateway it runs between other requests instead of holding them up.

export type Tool = "claude" | "codex";
interface Found { id: string; tool: Tool; file: string; mtime: number }

// A log written in the last WORKING_MS is a session at work; one that went quiet in the last DONE_MS has just finished.
const WORKING_MS = 30_000;
const DONE_MS = 10 * 60_000;
const PER_TOOL = 16;
const TAIL_BYTES = 96 * 1024;
const ACTIONS = 10;

async function files(dir: string, depth: number, out: string[]) {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith(".jsonl")) out.push(path);
    else if (depth > 0 && !name.startsWith(".")) await files(path, depth - 1, out);
  }
}

async function recent(tool: Tool, root: string, depth: number, since: number): Promise<Found[]> {
  const paths: string[] = [];
  await files(root, depth, paths);
  const found: Found[] = [];
  await Promise.all(paths.map(async (file) => {
    try {
      const mtime = (await stat(file)).mtimeMs;
      if (mtime >= since) found.push({ id: basename(file, ".jsonl").slice(-36), tool, file, mtime });
    } catch { /* gone since listing */ }
  }));
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, PER_TOOL);
}

/** Scratch runs (a tool's own throwaway Codex or Claude in a temp folder) are no one to seat. */
const TEMP_CWD = /^\/(private\/)?(tmp|var\/folders)\//;

/** Reads `len` bytes of `file` from `at`, or from the end when `at` is negative; empty if it can't. */
async function slice(file: string, len: number, fromEnd: boolean): Promise<{ text: string; cut: boolean }> {
  try {
    const fh = await open(file, "r");
    try {
      const size = (await fh.stat()).size;
      const n = Math.min(size, len);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, fromEnd ? size - n : 0);
      return { text: buf.toString("utf8"), cut: size > n };
    } finally {
      await fh.close();
    }
  } catch { return { text: "", cut: false }; }
}

/** The working folder a session log names near its start: Claude writes "cwd" on its lines, Codex in its session_meta. */
async function cwdOf(file: string): Promise<string> {
  const m = /"cwd"\s*:\s*"([^"]+)"/.exec((await slice(file, 64 * 1024, false)).text);
  return m ? m[1] : "";
}

async function tail(file: string): Promise<string[]> {
  const { text, cut } = await slice(file, TAIL_BYTES, true);
  const lines = text.split("\n");
  if (cut) lines.shift();
  return lines;
}

const short = (path: unknown) => (typeof path === "string" ? basename(path) : "");
const one = (text: unknown) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 150) : "");

/** One line for a Claude Code tool call: what it ran or touched. */
function claudeAction(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return `$ ${one(input.description) || one(input.command)}`;
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return `✎ ${short(input.file_path ?? input.notebook_path)}`;
    case "Read": return `▸ ${short(input.file_path)}`;
    case "Grep": case "Glob": return `⌕ ${one(input.pattern)}`;
    case "WebFetch": case "WebSearch": return `🌐 ${one(input.url ?? input.query)}`;
    case "Agent": case "Task": return `🤝 ${one(input.description)}`;
    default: return `• ${name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name}`;
  }
}

function claudeBrief(lines: string[]): { title: string; actions: string[] } {
  let title = "";
  const actions: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "custom-title" && d.customTitle) title = String(d.customTitle);
    else if (d.type === "ai-title" && d.aiTitle && !title) title = String(d.aiTitle);
    const content = d.message?.content;
    if (d.type === "assistant" && Array.isArray(content)) for (const b of content) if (b?.type === "tool_use") actions.push(claudeAction(String(b.name), b.input ?? {}));
  }
  return { title, actions: actions.slice(-ACTIONS) };
}

/** Codex's code-mode cells call tools.exec_command({cmd:"..."}); a plain function call carries its command in its arguments. */
function codexAction(p: any): string {
  const text = typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : "";
  const cmd = /\bcmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text) ?? /"command"\s*:\s*\[?\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (cmd) return `$ ${one(cmd[1].replace(/\\n/g, " ").replace(/\\"/g, '"'))}`;
  if (/apply_patch|\*\*\* (Update|Add) File: (\S+)/.test(text)) return `✎ ${short(/File: (\S+)/.exec(text)?.[1]) || "patch"}`;
  return `• ${one(p.name) || one(text.split("\n")[0])}`;
}

function codexBrief(lines: string[]): { actions: string[] } {
  const actions: string[] = [];
  for (const line of lines) {
    if (!line.includes("_call\"")) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload;
    if (p?.type === "function_call" || p?.type === "custom_tool_call") actions.push(codexAction(p));
  }
  return { actions: actions.slice(-ACTIONS) };
}

/** Codex keeps each thread's name in one index beside its sessions. */
async function codexTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    for (const line of (await readFile(join(home, ".codex", "session_index.jsonl"), "utf8")).split("\n")) {
      try { const d = JSON.parse(line); if (d.id && d.thread_name) titles.set(d.id, String(d.thread_name)); } catch { /* partial line */ }
    }
  } catch { /* no index */ }
  return titles;
}

/** A Claude Code subagent (Agent/Task tool) its parent session started: Claude keeps each one's log and a small
 * meta file under <project>/<session id>/subagents/. Only ones at work or just finished are seated. */
export interface ScannedSubagent {
  id: string;
  type: string;
  description: string;
  model: string;
  updatedAt: number;
  state: "working" | "done" | "idle";
  actions: string[];
}

const SUBS_PER_SESSION = 12;
/** A subagent not marked finished yet whose log has been quiet this long has died with its parent: no one to seat. */
const SUB_STALE_MS = 30 * 60_000;

async function subagentsOf(sessionFile: string, now: number): Promise<ScannedSubagent[]> {
  const dir = join(sessionFile.slice(0, -".jsonl".length), "subagents");
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const rows = await Promise.all(names.filter((n) => n.endsWith(".meta.json")).map(async (n): Promise<ScannedSubagent | null> => {
    const base = n.slice(0, -".meta.json".length);
    try {
      const meta = JSON.parse(await readFile(join(dir, n), "utf8"));
      const log = join(dir, `${base}.jsonl`);
      const mtime = (await stat(log).catch(() => stat(join(dir, n)))).mtimeMs;
      const finished = meta.finished === true;
      const age = now - mtime;
      if (finished ? age >= DONE_MS : age >= SUB_STALE_MS) return null;
      return {
        id: base.replace(/^agent-/, "").slice(0, 120),
        type: String(meta.agentType ?? "").slice(0, 60),
        description: one(meta.description).slice(0, 120),
        model: String(meta.pickedEffortModel ?? meta.model ?? "").slice(0, 60),
        updatedAt: mtime,
        state: finished ? "done" : age < WORKING_MS * 4 ? "working" : "idle",
        actions: [],
      };
    } catch { return null; }
  }));
  const subs = rows.filter((r): r is ScannedSubagent => r !== null).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SUBS_PER_SESSION);
  // Only the ones at work get their latest tool calls: a finished one's laptop just says it's done.
  await Promise.all(subs.filter((x) => x.state === "working").map(async (x) => { x.actions = claudeBrief(await tail(join(dir, `agent-${x.id}.jsonl`))).actions; }));
  return subs;
}

export interface ScannedSession {
  id: string;
  /** Its working folder, in full (where a new terminal for it would start). */
  cwd: string;
  tool: Tool;
  project: string;
  updatedAt: number;
  state: "working" | "done" | "idle";
  title: string;
  actions: string[];
  /** Claude Code subagents of this session at work or just finished (none for Codex). */
  subagents: ScannedSubagent[];
}

export async function scanSessions(home: string, hours: number, now = Date.now()): Promise<ScannedSession[]> {
  const since = now - hours * 3_600_000;
  const [claude, codex, codexNames] = await Promise.all([
    recent("claude", join(home, ".claude", "projects"), 1, since),
    recent("codex", join(home, ".codex", "sessions"), 3, since),
    codexTitles(home),
  ]);
  const rows = await Promise.all([...claude, ...codex].map(async (f): Promise<ScannedSession | null> => {
    const cwd = await cwdOf(f.file);
    if (TEMP_CWD.test(cwd)) return null;
    const lines = await tail(f.file);
    const brief = f.tool === "claude" ? claudeBrief(lines) : { title: codexNames.get(f.id) ?? "", ...codexBrief(lines) };
    return {
      id: f.id,
      cwd: cwd.slice(0, 400),
      tool: f.tool,
      project: (basename(cwd) || cwd).slice(0, 200),
      updatedAt: f.mtime,
      state: now - f.mtime < WORKING_MS ? "working" : now - f.mtime < DONE_MS ? "done" : "idle",
      title: brief.title.slice(0, 200),
      actions: brief.actions,
      subagents: f.tool === "claude" ? await subagentsOf(f.file, now) : [],
    };
  }));
  return rows.filter((r): r is ScannedSession => r !== null);
}
