import { execFile, spawn } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, loadavg, totalmem, uptime } from "node:os";

// How each computer is doing, for the boards on the office's north wall: CPU, memory, disk and, on the
// A4000, its GPU. This computer reads its own; the M2 Max and the A4000's Windows side answer over SSH
// with stock tools only (sysctl, vm_stat, top, df; PowerShell and nvidia-smi). Readings refresh in the
// background every REFRESH_MS, and the query answers from the latest at once.

export interface Gpu { name: string; util: number; memUsed: number; memTotal: number; temp: number }
export interface MachineStats {
  id: string;
  label: string;
  ok: boolean;
  error: string;
  at: number;
  cores: number;
  /** Busy share of all cores, 0–100, or -1 when unknown. */
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  /** Seconds since boot, or -1. */
  uptime: number;
  gpu: Gpu | null;
}

const REFRESH_MS = 20_000;
const TIMEOUT_MS = 30_000;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });
}

function ssh(host: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, command], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").pop() || `ssh exited ${code}`));
    });
  });
}

/** macOS memory in use: everything but free, inactive, speculative and purgeable pages (what Activity Monitor calls available). */
function macMemUsed(vmStat: string, total: number): number {
  const page = Number(/page size of (\d+)/.exec(vmStat)?.[1] ?? 16384);
  const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0);
  return Math.max(0, total - (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page);
}

/** `top -l 1` prints "CPU usage: 12.3% user, 4.5% sys, 83.2% idle". */
function macCpu(top: string): number {
  const idle = /([\d.]+)% idle/.exec(top);
  return idle ? Math.round(100 - Number(idle[1])) : -1;
}

/** `df -k <path>`'s last line: blocks, used, available in KiB. */
function dfUsage(df: string): { used: number; total: number } {
  const f = df.trim().split("\n").pop()?.trim().split(/\s+/) ?? [];
  const total = Number(f[1]) * 1024;
  const avail = Number(f[3]) * 1024;
  return Number.isFinite(total) && Number.isFinite(avail) ? { used: total - avail, total } : { used: 0, total: 0 };
}

async function readHome(): Promise<Omit<MachineStats, "id" | "label">> {
  const total = totalmem();
  const [vm, top, disk] = await Promise.all([run("vm_stat", []), run("top", ["-l", "1", "-n", "0"]), statfs("/System/Volumes/Data")]);
  const diskTotal = disk.blocks * disk.bsize;
  return {
    ok: true, error: "", at: Date.now(), cores: cpus().length, cpu: macCpu(top),
    memUsed: macMemUsed(vm, total), memTotal: total,
    diskUsed: diskTotal - disk.bavail * disk.bsize, diskTotal, uptime: Math.round(uptime()), gpu: null,
  };
}

const MAC_REMOTE = "sysctl -n hw.ncpu hw.memsize kern.boottime; echo '@@VM'; vm_stat; echo '@@TOP'; top -l 1 -n 0 | grep 'CPU usage'; echo '@@DF'; df -k /System/Volumes/Data";

async function readMac(host: string): Promise<Omit<MachineStats, "id" | "label">> {
  const out = await ssh(host, MAC_REMOTE);
  const [head, rest = ""] = out.split("@@VM");
  const [vm, rest2 = ""] = rest.split("@@TOP");
  const [top, df = ""] = rest2.split("@@DF");
  const [cores, mem, boot] = head.trim().split("\n");
  const total = Number(mem);
  const bootSec = Number(/sec = (\d+)/.exec(boot ?? "")?.[1] ?? 0);
  const d = dfUsage(df);
  return {
    ok: true, error: "", at: Date.now(), cores: Number(cores), cpu: macCpu(top),
    memUsed: macMemUsed(vm, total), memTotal: total, diskUsed: d.used, diskTotal: d.total,
    uptime: bootSec ? Math.round(Date.now() / 1000 - bootSec) : -1, gpu: null,
  };
}

// One line from nvidia-smi, then one line of JSON from PowerShell (CPU load, memory, the C: drive, boot time).
const WIN_REMOTE = [
  "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits",
  "&",
  'powershell -NoProfile -Command "$c=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $o=Get-CimInstance Win32_OperatingSystem; $d=Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID=\'C:\'\\"; [pscustomobject]@{cpu=$c; cores=[Environment]::ProcessorCount; memTotal=$o.TotalVisibleMemorySize*1024; memFree=$o.FreePhysicalMemory*1024; diskTotal=$d.Size; diskFree=$d.FreeSpace; up=[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds} | ConvertTo-Json -Compress"',
].join(" ");

async function readWindows(host: string): Promise<Omit<MachineStats, "id" | "label">> {
  const out = await ssh(host, WIN_REMOTE);
  const lines = out.trim().split(/\r?\n/);
  const json = lines.find((l) => l.trim().startsWith("{"));
  if (!json) throw new Error("PowerShell가 답하지 않았어요");
  const w = JSON.parse(json) as { cpu: number; cores: number; memTotal: number; memFree: number; diskTotal: number; diskFree: number; up: number };
  const g = lines.find((l) => /,/.test(l) && !l.trim().startsWith("{"))?.split(",").map((s) => s.trim());
  return {
    ok: true, error: "", at: Date.now(), cores: w.cores, cpu: Math.round(w.cpu ?? -1),
    memUsed: w.memTotal - w.memFree, memTotal: w.memTotal, diskUsed: w.diskTotal - w.diskFree, diskTotal: w.diskTotal, uptime: w.up,
    gpu: g && g.length >= 5 ? { name: g[0], util: Number(g[1]), memUsed: Number(g[2]) * 1048576, memTotal: Number(g[3]) * 1048576, temp: Number(g[4]) } : null,
  };
}

const SOURCES: { id: string; label: string; read: () => Promise<Omit<MachineStats, "id" | "label">> }[] = [
  { id: "m5", label: "M5", read: readHome },
  { id: "m2max", label: "M2 Max", read: () => readMac("computer-c") },
  { id: "a4000", label: "A4000", read: () => readWindows("computer-a") },
];

const latest = new Map<string, MachineStats>();
const busy = new Set<string>();

async function refresh(src: (typeof SOURCES)[number]) {
  if (busy.has(src.id)) return;
  busy.add(src.id);
  try {
    latest.set(src.id, { id: src.id, label: src.label, ...(await src.read()) });
  } catch (e) {
    const prev = latest.get(src.id);
    latest.set(src.id, { ...(prev ?? { cores: 0, cpu: -1, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0, uptime: -1, gpu: null }), id: src.id, label: src.label, ok: false, at: Date.now(), error: String((e as Error).message ?? e).slice(0, 200) });
  } finally {
    busy.delete(src.id);
  }
}

/** The latest reading of every computer, starting a fresh one for any older than REFRESH_MS. */
export function machineStats(now = Date.now()): MachineStats[] {
  return SOURCES.map((src) => {
    const r = latest.get(src.id);
    if (!r || now - r.at > REFRESH_MS) void refresh(src);
    return r ?? { id: src.id, label: src.label, ok: false, error: "읽는 중", at: 0, cores: 0, cpu: -1, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0, uptime: -1, gpu: null };
  });
}
