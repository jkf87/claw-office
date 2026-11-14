import { execFile } from "node:child_process";
import { trustFolder } from "./trust.js";

// Herdr (herdr.dev) runs Claude Code and Codex in terminal panes on this computer and, over its saved SSH
// machines, on the others. The office reads each one's agents with the herdr CLI (one short process per
// call, ~40 ms here and ~0.3 s remote), sends prompts and key presses to them, and starts new ones in a new tab.
// It's far lighter than a Paseo daemon (34 MB vs 303 MB measured 2026-11-06), but it only sees agents inside
// its own panes and knows "blocked" without the structured permission request.

const LOCAL = { id: "m5", label: "M5" };
const TIMEOUT_MS = 8_000;
const CACHE_MS = 2_000;

export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export interface HerdrAgentRow {
  /** Its live name if it has one, else its pane id: what `herdr agent …` takes as the target. */
  target: string;
  name: string;
  agent: string;
  status: HerdrStatus;
  cwd: string;
  title: string;
}
export interface HerdrHostReading { id: string; label: string; machine: string; connected: boolean; error: string; agents: HerdrAgentRow[] }

function herdr(args: string[], timeout = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    // Our own deadline too: execFile's callback waits for "close", which may never come after the Mac sleeps.
    const guard = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("herdr timed out")); }, timeout + 2_000);
    const child = execFile("herdr", args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(guard);
      if (err) reject(new Error((stderr || err.message).trim().split("\n").pop() || "herdr failed"));
      else resolve(stdout);
    });
  });
}

/** `--machine <label>` for another computer; nothing for this one. */
const on = (machine: string) => (machine ? ["--machine", machine] : []);

/** This computer plus every enabled saved machine; its office id is its label in lower case (M2Max → m2max). */
async function hosts(): Promise<{ id: string; label: string; machine: string }[]> {
  const rows = (await herdr(["machine", "list"]).catch(() => "")).split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 5 && c[4] === "enabled");
  return [{ ...LOCAL, machine: "" }, ...rows.map((c) => ({ id: c[1].toLowerCase(), label: c[1], machine: c[1] }))];
}

const STATUSES: readonly HerdrStatus[] = ["idle", "working", "blocked", "done", "unknown"];

async function readHost(h: { id: string; label: string; machine: string }): Promise<HerdrHostReading> {
  try {
    const out = JSON.parse(await herdr([...on(h.machine), "agent", "list"]));
    const agents = (out?.result?.agents ?? []).map((a: any): HerdrAgentRow => ({
      target: String(a.name || a.pane_id).slice(0, 120),
      name: String(a.name ?? "").slice(0, 120),
      agent: String(a.agent ?? "").slice(0, 40),
      status: STATUSES.includes(a.agent_status) ? a.agent_status : "unknown",
      cwd: String(a.foreground_cwd || a.cwd || "").slice(0, 400),
      title: String(a.terminal_title_stripped ?? "").slice(0, 200),
    }));
    return { ...h, connected: true, error: "", agents };
  } catch (e) {
    return { ...h, connected: false, error: String((e as Error)?.message ?? e).slice(0, 240), agents: [] };
  }
}

let cached: { at: number; hosts: HerdrHostReading[] } | null = null;
let reading: Promise<HerdrHostReading[]> | null = null;

export async function herdrAgents(now = Date.now()): Promise<HerdrHostReading[]> {
  if (cached && now - cached.at <= CACHE_MS) return cached.hosts;
  reading ??= hosts().then((hs) => Promise.all(hs.map(readHost))).then((r) => {
    cached = { at: Date.now(), hosts: r };
    return r;
  }).finally(() => (reading = null));
  return reading;
}

function machineOf(hostId: string): string {
  if (hostId === LOCAL.id) return "";
  const h = cached?.hosts.find((x) => x.id === hostId);
  if (!h) throw new Error(`herdr에 ${hostId} 컴퓨터가 없어요`);
  return h.machine;
}

export async function herdrPrompt(hostId: string, target: string, text: string): Promise<void> {
  await herdr([...on(machineOf(hostId)), "agent", "prompt", target, text]);
  cached = null;
}

/** Key presses for an agent waiting at a question or approval dialog (e.g. "1", "enter", "esc"). */
export async function herdrKeys(hostId: string, target: string, keys: string[]): Promise<void> {
  await herdr([...on(machineOf(hostId)), "agent", "send-keys", target, ...keys]);
  cached = null;
}

export async function herdrRead(hostId: string, target: string, lines = 40): Promise<string> {
  return (await herdr([...on(machineOf(hostId)), "agent", "read", target, "--source", "recent", "--lines", String(lines)])).slice(-16_000);
}

/** A new tab in the folder with the CLI started in it under a fresh name (extra args go to the CLI). */
async function startInTab(hostId: string, provider: "claude" | "codex", cwd: string, title: string | undefined, args: string[]): Promise<{ m: string[]; name: string }> {
  if (!cached) await herdrAgents();
  const m = on(machineOf(hostId));
  // A folder the CLI hasn't opened before asks "Do you trust this folder?" and the start waits on it: on this
  // computer the office answers it first, as it does before opening a terminal (another computer's own CLI asks there).
  if (!m.length) await trustFolder(provider, cwd).catch(() => false);
  const label = (title || cwd.split("/").pop() || provider).slice(0, 40);
  const tab = JSON.parse(await herdr([...m, "tab", "create", "--cwd", cwd, "--label", label]));
  const pane = tab?.result?.root_pane?.pane_id;
  if (!pane) throw new Error("herdr가 새 탭을 만들지 못했어요");
  // Herdr names: a lowercase letter first, then lowercase letters, digits, '-' or '_' (32 at most).
  const slug = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 24) || provider;
  const name = `${slug}-${Date.now().toString(36).slice(-4)}`;
  await herdr([...m, "agent", "start", name, "--kind", provider, "--pane", pane, ...(args.length ? ["--", ...args] : [])], 60_000);
  cached = null;
  return { m, name };
}

/** A new tab in the folder, the CLI started in it, then the first prompt. */
export async function herdrCreate(input: { hostId: string; provider: "claude" | "codex"; cwd: string; prompt: string; title?: string }): Promise<string> {
  const { m, name } = await startInTab(input.hostId, input.provider, input.cwd, input.title, []);
  if (input.prompt.trim()) await herdr([...m, "agent", "prompt", name, input.prompt]);
  return name;
}

/** An existing Claude Code / Codex session (from its log) continued in a new Herdr tab, so it shows and attaches like any Herdr agent. */
export async function herdrResume(input: { hostId: string; provider: "claude" | "codex"; cwd: string; sessionId: string; title?: string }): Promise<string> {
  const args = input.provider === "claude" ? ["--resume", input.sessionId] : ["resume", input.sessionId];
  return (await startInTab(input.hostId, input.provider, input.cwd, input.title, args)).name;
}
