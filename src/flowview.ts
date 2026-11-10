import { FLOW_MS, type FlowRow } from "./flow";
import { SPAN_COLOR, STATUS_NODE, STEP_KIND } from "./office/boards";

// A computer's session flow, large: what its board on the north wall shows, opened over the office when
// the board is clicked. A row a session each (every session the office saw work there in the last hour, not
// just the board's six): its name and what it's on, its latest steps leading to where it is now, and its hour
// as a strip with the time marked under it. A row whose worker is still in the office opens it, as a click on
// the worker does.

const TICKS = [60, 45, 30, 15, 0];
const ROWS = 30;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface FlowView {
  /** Opens it on a computer. */
  show(machine: string): void;
  /** Redraws it if it's open (each refresh of the office). */
  refresh(): void;
  readonly open: boolean;
}

export function mountFlowView(host: HTMLElement, src: {
  rows(machine: string, limit: number): FlowRow[];
  label(machine: string): string;
  /** Opens a row's session, if its worker is still in the office; false when it isn't. */
  canOpen(key: string): boolean;
  openRow(key: string): void;
}): FlowView {
  const back = el("div", "claw-flow-back");
  back.hidden = true;
  const panel = el("div", "claw-flow");
  back.append(panel);
  host.append(back);
  let machine = "";
  const close = () => {
    back.hidden = true;
    machine = "";
  };
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !back.hidden) close();
  });

  const draw = () => {
    const now = Date.now();
    const rows = src.rows(machine, ROWS);
    const scroll = panel.scrollTop;
    panel.replaceChildren();
    const head = el("div", "claw-flow-head");
    const title = el("div", "claw-flow-title");
    title.append(el("b", "", `🖥 ${src.label(machine)} · 작업 흐름`), el("span", "", "최근 단계 → 지금 · 줄 막대는 지난 1시간"));
    const x = el("button", "claw-flow-close", "✕");
    x.title = "닫기 (Esc)";
    x.onclick = close;
    title.append(x);
    head.append(title);
    const axis = el("div", "claw-flow-axis");
    for (const t of TICKS) axis.append(el("span", "", t ? `${t}분 전` : "지금"));
    head.append(axis);
    panel.append(head);
    if (!rows.length) {
      panel.append(el("div", "claw-flow-empty", "지난 1시간 동안 이 컴퓨터에서 일한 세션이 없어요."));
      return;
    }
    const list = el("div", "claw-flow-list");
    for (const r of rows) {
      const row = el("div", `claw-flow-row is-${r.status}${r.live ? " is-live" : ""}`);
      const top = el("div", "claw-flow-name");
      const dot = el("i", "");
      dot.style.background = r.color;
      top.append(dot, el("b", "", r.name));
      if (r.live) top.append(el("em", "claw-office-live", "LIVE"));
      top.append(el("span", "", r.at ? ago(now - r.at) : ""));
      row.append(top);
      if (r.brief) row.append(el("div", "claw-flow-what", r.brief));

      // Its steps, oldest first, each in its kind's color, then where it is now.
      const steps = el("div", "claw-flow-steps");
      r.actions.forEach((a, i) => {
        if (i) steps.append(el("span", "claw-flow-arrow", "→"));
        const chip = el("span", "claw-flow-step", a);
        const kind = STEP_KIND.find(([re]) => re.test(a));
        if (kind) {
          chip.style.background = kind[1];
          chip.style.color = kind[2];
        }
        steps.append(chip);
      });
      const [label, bg] = STATUS_NODE[r.status] ?? [r.status, "#c9d6e3"];
      if (r.actions.length) steps.append(el("span", "claw-flow-arrow", "→"));
      const node = el("span", "claw-flow-now", label);
      node.style.background = bg;
      steps.append(node);
      row.append(steps);

      // Its hour: the spans the office saw, left = an hour ago, right = now.
      const lane = el("div", "claw-flow-lane");
      const from = now - FLOW_MS;
      for (const s of r.spans) {
        const a = Math.max(s.from, from);
        const b = Math.max(a + 15_000, s.to);
        const bar = el("i", "");
        bar.style.left = `${((a - from) / FLOW_MS) * 100}%`;
        bar.style.width = `${Math.min(100, ((b - a) / FLOW_MS) * 100)}%`;
        bar.style.background = SPAN_COLOR[s.status] ?? "#dfe5ec";
        bar.title = `${STATUS_NODE[s.status]?.[0] ?? s.status} · ${ago(now - s.to)}까지 ${Math.max(1, Math.round((s.to - s.from) / 60_000))}분`;
        lane.append(bar);
      }
      row.append(lane);

      if (src.canOpen(r.key)) {
        row.classList.add("is-link");
        row.title = "눌러서 이 세션 열기";
        row.onclick = () => {
          close();
          src.openRow(r.key);
        };
      }
      list.append(row);
    }
    panel.append(list);
    panel.scrollTop = scroll;
  };

  return {
    show(id) {
      machine = id;
      back.hidden = false;
      draw();
    },
    refresh() {
      if (!back.hidden && machine) draw();
    },
    get open() {
      return !back.hidden;
    },
  };
}
