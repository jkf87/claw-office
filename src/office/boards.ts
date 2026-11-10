import * as THREE from 'three';
import type { FlowRow } from '../flow';
import { FLOW_MS } from '../flow';

// The three boards on the north wall (Agent Office's Issues, Task queue and Pull Requests, which Claw
// Office never fills) show each computer instead: one board per computer, west to east M5, M2 Max, A4000.
// A strip of small bars (CPU, memory, disk, and the A4000's GPU) heads its session flow: the last hour of
// each of its busiest sessions as a lane, yellow while working, red while waiting on you, pale while resting. Each board's face gets a canvas
// of its own; its old title above it is put away (the computer's name heads the canvas instead).

export interface BoardStats {
  id: string;
  label: string;
  ok: boolean;
  error: string;
  at: number;
  cores: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  uptime: number;
  gpu: { name: string; util: number; memUsed: number; memTotal: number; temp: number } | null;
}

/** Which board shows which computer. */
const BOARD_FOR: Record<string, string> = { m5: 'issues', m2max: 'queue', a4000: 'pulls' };
const LABELS: Record<string, string> = { m5: 'M5', m2max: 'M2 Max', a4000: 'A4000' };
const W = 1200;
const H = 600;
const GB = 1073741824;

const level = (pct: number) => (pct >= 90 ? '#ef476f' : pct >= 70 ? '#f4a261' : '#2a9d8f');
const font = (weight: number, px: number) => `${weight} ${px}px "Pretendard", "Apple SD Gothic Neo", system-ui, sans-serif`;

export function paint(ctx: CanvasRenderingContext2D, s: BoardStats, flow: readonly FlowRow[], now: number) {
  ctx.fillStyle = '#fffaf3';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2b2d42';
  ctx.fillRect(0, 0, W, 110);
  ctx.fillStyle = '#fffaf3';
  ctx.font = font(800, 64);
  ctx.textBaseline = 'middle';
  ctx.fillText(`🖥 ${s.label}`, 40, 56);
  ctx.textAlign = 'right';
  ctx.font = font(600, 30);
  ctx.fillStyle = s.ok ? '#a6e3a1' : '#f38ba8';
  const age = s.at ? Math.round((now - s.at) / 1000) : -1;
  ctx.fillText(s.ok ? `● ${age < 60 ? `${age}초 전` : `${Math.round(age / 60)}분 전`}${s.uptime > 0 ? ` · 켜진 지 ${Math.round(s.uptime / 3600)}시간` : ''}` : `● ${s.error || '연결 안 됨'}`.slice(0, 40), W - 40, 56);
  ctx.textAlign = 'left';

  const rows: [string, number, string][] = [];
  if (s.cpu >= 0) rows.push(['CPU', s.cpu, `${s.cpu}%`]);
  if (s.memTotal) rows.push(['메모리', (s.memUsed / s.memTotal) * 100, `${(s.memUsed / GB).toFixed(0)}/${(s.memTotal / GB).toFixed(0)}G`]);
  if (s.diskTotal) rows.push(['디스크', (s.diskUsed / s.diskTotal) * 100, `${Math.round((s.diskTotal - s.diskUsed) / GB)}G 남음`]);
  if (s.gpu) {
    rows.push(['GPU', s.gpu.util, `${s.gpu.util}% ${s.gpu.temp}°`]);
    rows.push(['VRAM', (s.gpu.memUsed / s.gpu.memTotal) * 100, `${(s.gpu.memUsed / GB).toFixed(0)}/${(s.gpu.memTotal / GB).toFixed(0)}G`]);
  }
  const cell = (W - 60) / Math.max(1, rows.length);
  rows.forEach(([name, pct, text], i) => {
    const x = 40 + i * cell;
    const p = Math.max(0, Math.min(100, pct));
    ctx.fillStyle = '#2b2d42';
    ctx.font = font(700, 24);
    ctx.fillText(name, x, 140);
    ctx.fillStyle = '#5c5f77';
    ctx.font = font(600, 22);
    ctx.textAlign = 'right';
    ctx.fillText(text, x + cell - 20, 140, cell - 110);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e9e4da';
    ctx.beginPath();
    ctx.roundRect(x, 160, cell - 20, 16, 8);
    ctx.fill();
    ctx.fillStyle = level(p);
    ctx.beginPath();
    ctx.roundRect(x, 160, Math.max(16, ((cell - 20) * p) / 100), 16, 8);
    ctx.fill();
  });
  if (!rows.length) {
    ctx.fillStyle = '#6c6f85';
    ctx.font = font(600, 26);
    ctx.fillText(s.ok ? '상태 읽는 중…' : '이 컴퓨터에 닿지 않아요', 40, 150);
  }
  paintFlow(ctx, flow, now);
}

export const SPAN_COLOR: Record<string, string> = { working: '#ffd166', needs_input: '#ef476f', done: '#06d6a0', starting: '#ffd166' };
export const STEP_KIND: [RegExp, string, string][] = [
  [/^\$/, '#2b2d42', '#fffaf3'],
  [/^\u270E/, '#f4a261', '#2b2d42'],
  [/^\u25B8/, '#8ecae6', '#2b2d42'],
  [/^\u2315/, '#a8dadc', '#2b2d42'],
  [/^\u{1F310}/u, '#cdb4db', '#2b2d42'],
  [/^\u{1F91D}/u, '#f0b49a', '#2b2d42'],
];
export const STATUS_NODE: Record<string, [string, string]> = { working: ['일하는 중', '#ffd166'], needs_input: ['확인 필요', '#ef476f'], done: ['끝남', '#06d6a0'], idle: ['대기', '#c9d6e3'], offline: ['꺼짐', '#adb5bd'], starting: ['시작 중', '#ffd166'] };
const NAME_W = 250;
const FLOW_X = 40 + NAME_W + 16;
const FLOW_END = W - 40;

const ago = (ms: number) => (ms < 60_000 ? '방금' : ms < 3_600_000 ? `${Math.round(ms / 60_000)}분 전` : `${Math.round(ms / 3_600_000)}시간 전`);

/** One rounded chip with its text; returns its width. */
function chip(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, text: string, bg: string, fg: string, measureOnly = false): number {
  ctx.font = font(600, 19);
  const w = Math.ceil(ctx.measureText(text).width) + 22;
  if (measureOnly) return w;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, x + 11, y + h / 2 + 1);
  return w;
}

const stepText = (a: string) => {
  const t = a.replace(/\s+/g, ' ').trim();
  return t.length > 18 ? `${t.slice(0, 17)}…` : t;
};

/** Each busy session as a flow: its latest steps (tool calls), oldest to newest, into where it is now; a thin
 *  strip under it is its last hour (yellow working, red waiting on you, green just finished). */
function paintFlow(ctx: CanvasRenderingContext2D, rows: readonly FlowRow[], now: number) {
  const top = 200;
  ctx.fillStyle = '#2b2d42';
  ctx.fillRect(40, top, W - 80, 2);
  ctx.textBaseline = 'middle';
  ctx.font = font(800, 26);
  ctx.fillText('작업 흐름', 40, top + 30);
  ctx.font = font(600, 19);
  ctx.fillStyle = '#6c6f85';
  ctx.textAlign = 'right';
  ctx.fillText('최근 단계 → 지금 · 아래 줄은 지난 1시간', W - 40, top + 30);
  ctx.textAlign = 'left';
  const laneTop = top + 54;
  const lane = Math.min(62, (H - laneTop - 8) / Math.max(1, rows.length));
  if (!rows.length) {
    ctx.fillStyle = '#6c6f85';
    ctx.font = font(600, 24);
    ctx.fillText('최근 1시간 동안 일한 세션이 없어요', 40, laneTop + 24);
    return;
  }
  const x0 = now - FLOW_MS;
  const xOf = (t: number) => FLOW_X + Math.max(0, Math.min(1, (t - x0) / FLOW_MS)) * (FLOW_END - FLOW_X);
  rows.forEach((r, i) => {
    const y = laneTop + i * lane;
    const ch = Math.min(32, lane - 18);
    const mid = y + ch / 2;
    // Who: dot, name, LIVE.
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(50, mid, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = r.live ? '#2b2d42' : '#8a8ca0';
    ctx.font = font(r.live ? 700 : 600, 22);
    ctx.fillText(r.name, 66, mid, NAME_W - 30 - (r.live ? 50 : 0));
    if (r.live) {
      ctx.fillStyle = '#ef476f';
      ctx.beginPath();
      ctx.roundRect(40 + NAME_W - 48, mid - 11, 48, 22, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = font(800, 14);
      ctx.fillText('LIVE', 40 + NAME_W - 41, mid + 1);
    }
    // Where it is now: the last node, at the right edge.
    const [label, bg] = STATUS_NODE[r.status] ?? [r.status, '#c9d6e3'];
    const nodeText = `● ${label}${r.status === 'working' ? '' : ` · ${ago(now - r.at)}`}`;
    const nodeW = chip(ctx, 0, 0, ch, nodeText, bg, '#2b2d42', true);
    let x = FLOW_END - nodeW;
    chip(ctx, x, y, ch, nodeText, bg, r.status === 'needs_input' ? '#fff' : '#2b2d42');
    // Its steps, newest nearest the node, as many as fit; "…" where older ones were left out.
    const ARROW = 26;
    const steps = r.actions.length ? r.actions.map(stepText) : [r.brief ? stepText(r.brief) : '기록된 단계 없음'];
    let shown = 0;
    for (let k = steps.length - 1; k >= 0; k--) {
      const kind = STEP_KIND.find(([re]) => re.test(steps[k]));
      const w = chip(ctx, 0, 0, ch, steps[k], '', '', true);
      if (x - ARROW - w < FLOW_X + (k > 0 ? 30 : 0)) break;
      // Arrow into what came next.
      ctx.strokeStyle = '#9a9cb0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - ARROW + 4, mid);
      ctx.lineTo(x - 6, mid);
      ctx.stroke();
      ctx.fillStyle = '#9a9cb0';
      ctx.beginPath();
      ctx.moveTo(x - 4, mid);
      ctx.lineTo(x - 11, mid - 6);
      ctx.lineTo(x - 11, mid + 6);
      ctx.fill();
      x -= ARROW + w;
      chip(ctx, x, y, ch, steps[k], kind?.[1] ?? '#e9e4da', kind?.[2] ?? '#2b2d42');
      shown++;
    }
    if (shown < steps.length) {
      ctx.fillStyle = '#9a9cb0';
      ctx.font = font(700, 22);
      ctx.fillText('…', FLOW_X, mid);
    }
    // Its last hour, thin, under the flow.
    const sy = y + ch + 6;
    ctx.fillStyle = '#f1ece2';
    ctx.fillRect(FLOW_X, sy, FLOW_END - FLOW_X, 5);
    for (const sp of r.spans) {
      const c = SPAN_COLOR[sp.status];
      if (!c) continue;
      const a = xOf(sp.from);
      ctx.fillStyle = c;
      ctx.fillRect(a, sy, Math.max(3, xOf(sp.to) - a), 5);
    }
  });
}

export class StatusBoards {
  private faces = new Map<string, { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; key: string }>();
  /** Each board's face, and the computer it shows. */
  private meshes = new Map<THREE.Mesh, string>();

  /** The computer whose board `ray` lands on first, and how far off it is. */
  hit(ray: THREE.Raycaster): { machine: string; distance: number } | null {
    const h = ray.intersectObjects([...this.meshes.keys()], false)[0];
    return h ? { machine: this.meshes.get(h.object as THREE.Mesh)!, distance: h.distance } : null;
  }

  constructor(office: { group: THREE.Object3D } & { boardMeshes?: Record<string, THREE.Mesh> }) {
    const meshes = office.boardMeshes ?? {};
    const titles: THREE.Object3D[] = [];
    office.group.updateMatrixWorld(true);
    for (const board of Object.values(BOARD_FOR)) {
      const face = meshes[board];
      if (!face) continue;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      face.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      this.faces.set(board, { ctx: canvas.getContext('2d')!, tex, key: '' });
      const id = Object.entries(BOARD_FOR).find(([, b]) => b === board)?.[0];
      if (id) this.meshes.set(face, id);
      // The board's old title: the flat label hanging just above its frame.
      const at = new THREE.Vector3();
      face.getWorldPosition(at);
      office.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || m === face) return;
        const p = new THREE.Vector3();
        m.getWorldPosition(p);
        if (Math.abs(p.x - at.x) < 0.5 && p.y > at.y + 1.6 && p.y < at.y + 2.6 && Math.abs(p.z - at.z) < 0.4) titles.push(m);
      });
    }
    for (const t of titles) t.visible = false;
  }

  private stats = new Map<string, BoardStats>();
  private flows = new Map<string, readonly FlowRow[]>();

  update(stats: readonly BoardStats[], now = Date.now()) {
    for (const s of stats) this.stats.set(s.id, s);
    this.paintAll(now);
  }

  /** Each computer's session flow (see SessionFlow.rows). */
  updateFlow(flows: ReadonlyMap<string, readonly FlowRow[]>, now = Date.now()) {
    for (const [id, rows] of flows) this.flows.set(id, rows);
    this.paintAll(now);
  }

  private paintAll(now: number) {
    for (const [id, board] of Object.entries(BOARD_FOR)) {
      const f = this.faces.get(board);
      if (!f) continue;
      const s = this.stats.get(id) ?? { id, label: LABELS[id] ?? id, ok: false, error: '읽는 중', at: 0, cores: 0, cpu: -1, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0, uptime: 0, gpu: null };
      const flow = this.flows.get(id) ?? [];
      // Repaint when something changed, and at least every 15 s so the hour slides along.
      const key = JSON.stringify([s, flow.map((r) => [r.key, r.live, r.status, r.actions.at(-1), r.actions.length, r.spans.length, r.spans.at(-1)?.to])]) + Math.floor(now / 15000);
      if (key === f.key) continue;
      f.key = key;
      paint(f.ctx, s, flow, now);
      f.tex.needsUpdate = true;
    }
  }
}
