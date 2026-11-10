import type { Seat } from "./office/scene";
import type { WorkerStatus } from "../vendor/agent-office/shared/protocol";

// Each worker's status over the last hour, for the session flow on its computer's board: what the office saw
// at every refresh, merged into spans (working, waiting on you, resting). The office keeps it in this browser so
// a reload doesn't wipe the picture; before it first saw a session, it only knows that session's last activity.

export const FLOW_MS = 60 * 60_000;
/** A refresh gap longer than this ends a span (a hidden tab refreshes about once a minute, so allow a few). */
const GAP_MS = 3 * 60_000;
const STORE = "claw-office:flow";
const PER_MACHINE = 6;

export type FlowSpan = { from: number; to: number; status: WorkerStatus };
export type FlowRow = { key: string; name: string; color: string; live: boolean; status: WorkerStatus; at: number; spans: FlowSpan[]; brief: string; actions: string[] };
type Track = { name: string; color: string; machine: string; live: boolean; status: WorkerStatus; at: number; spans: FlowSpan[]; brief: string; actions: string[] };

export class SessionFlow {
  private tracks = new Map<string, Track>();
  private savedAt = 0;

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, Track>;
      const cut = Date.now() - FLOW_MS;
      for (const [k, t] of Object.entries(raw)) {
        const spans = (t.spans ?? []).filter((s) => s.to >= cut);
        if (spans.length) this.tracks.set(k, { ...t, live: false, spans });
      }
    } catch { /* storage blocked or bad: start empty */ }
  }

  record(seats: readonly Seat[], now = Date.now()) {
    const seen = new Set<string>();
    for (const s of seats) {
      seen.add(s.key);
      let t = this.tracks.get(s.key);
      if (!t) {
        t = { name: s.name, color: s.color, machine: s.machine, live: !!s.live, status: s.status, at: s.at ?? 0, spans: [], brief: "", actions: [] };
        // First sight: all we know of its past is when it last did something.
        if (s.at && s.at > now - FLOW_MS && s.at < now - GAP_MS) t.spans.push({ from: s.at - 20_000, to: s.at, status: "working" });
        this.tracks.set(s.key, t);
      }
      Object.assign(t, { name: s.name, color: s.color, machine: s.machine, live: !!s.live, status: s.status, at: Math.max(t.at, s.at ?? 0), brief: String(s.brief ?? "").slice(0, 80), actions: (s.actions ?? []).slice(-8).map(String) });
      const last = t.spans.at(-1);
      if (last && last.status === s.status && now - last.to < GAP_MS) last.to = now;
      else t.spans.push({ from: last && now - last.to < GAP_MS ? last.to : now, to: now, status: s.status });
    }
    const cut = now - FLOW_MS;
    for (const [k, t] of this.tracks) {
      if (!seen.has(k)) t.live = false;
      t.spans = t.spans.filter((x) => x.to >= cut);
      if (!t.spans.length) this.tracks.delete(k);
    }
    if (now - this.savedAt > 30_000) {
      this.savedAt = now;
      try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(this.tracks))); } catch { /* this visit only */ }
    }
  }

  /** One computer's rows: live ones first, then whoever was busy most recently. */
  rows(machine: string, limit = PER_MACHINE): FlowRow[] {
    const busy = (t: Track) => t.spans.filter((x) => x.status === "working" || x.status === "needs_input").at(-1)?.to ?? t.at;
    return [...this.tracks.entries()]
      .filter(([, t]) => t.machine === machine && t.spans.some((x) => x.status !== "idle" && x.status !== "offline"))
      .sort(([, a], [, b]) => Number(b.live) - Number(a.live) || busy(b) - busy(a))
      .slice(0, limit)
      .map(([key, t]) => ({ key, name: t.name, color: t.color, live: t.live, status: t.status, at: t.at, spans: t.spans, brief: t.brief ?? "", actions: t.actions ?? [] }));
  }
}
