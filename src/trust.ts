import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Marks a folder trusted for the CLI about to open in it, so its terminal starts without the "Do you trust
// this folder?" question: Claude Code keeps that answer per folder in ~/.claude.json
// (projects[<folder>].hasTrustDialogAccepted), Codex in ~/.codex/config.toml ([projects."<folder>"]
// trust_level = "trusted"). Only the one entry is added; nothing else in either file changes, and a folder
// already trusted leaves its file untouched.

export type TrustTool = "claude" | "codex";

/** Writes next to the file and renames over it, so a reader never sees half a file. */
async function replace(file: string, text: string) {
  const tmp = `${file}.claw-office-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

async function trustClaude(folder: string): Promise<boolean> {
  const file = join(homedir(), ".claude.json");
  const data = JSON.parse(await readFile(file, "utf8")) as { projects?: Record<string, Record<string, unknown>> };
  const projects = (data.projects ??= {});
  if (projects[folder]?.hasTrustDialogAccepted === true) return false;
  projects[folder] = { ...(projects[folder] ?? {}), hasTrustDialogAccepted: true };
  await replace(file, JSON.stringify(data, null, 2));
  return true;
}

async function trustCodex(folder: string): Promise<boolean> {
  const file = join(homedir(), ".codex", "config.toml");
  let text = "";
  try { text = await readFile(file, "utf8"); } catch { /* no config yet: this entry starts it */ }
  const header = `[projects.${JSON.stringify(folder)}]`;
  const at = text.indexOf(header);
  if (at >= 0) {
    // The table exists: trusted already, or give it the trust level it lacks.
    const end = text.indexOf("\n[", at + header.length);
    const table = text.slice(at, end < 0 ? undefined : end);
    if (/^\s*trust_level\s*=\s*"trusted"/m.test(table)) return false;
    const fixed = /^\s*trust_level\s*=.*$/m.test(table) ? table.replace(/^\s*trust_level\s*=.*$/m, 'trust_level = "trusted"') : table.replace(header, `${header}\ntrust_level = "trusted"`);
    await replace(file, text.slice(0, at) + fixed + (end < 0 ? "" : text.slice(end)));
    return true;
  }
  await replace(file, `${text.replace(/\s*$/, "")}\n\n${header}\ntrust_level = "trusted"\n`);
  return true;
}

/** True when it had to record the trust (false: already trusted). */
export async function trustFolder(tool: TrustTool, folder: string): Promise<boolean> {
  if (!folder.startsWith("/") || folder.includes("\n")) throw new Error("폴더는 절대 경로여야 해요");
  return tool === "claude" ? trustClaude(folder) : trustCodex(folder);
}
