import * as THREE from 'three';

// The three boards on the north wall (Agent Office's Issues, Task queue and Pull Requests, which Claw
// Office never fills) show each computer's health instead: one board per computer, west to east M5,
// M2 Max, A4000, with bars for CPU, memory and disk, and the A4000's GPU. Each board's face gets a canvas
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
const W = 1200;
const H = 600;
const GB = 1073741824;

const level = (pct: number) => (pct >= 90 ? '#ef476f' : pct >= 70 ? '#f4a261' : '#2a9d8f');
const font = (weight: number, px: number) => `${weight} ${px}px "Pretendard", "Apple SD Gothic Neo", system-ui, sans-serif`;

function paint(ctx: CanvasRenderingContext2D, s: BoardStats, now: number) {
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
  if (s.cpu >= 0) rows.push(['CPU', s.cpu, `${s.cpu}% · ${s.cores}코어`]);
  if (s.memTotal) rows.push(['메모리', (s.memUsed / s.memTotal) * 100, `${(s.memUsed / GB).toFixed(1)} / ${(s.memTotal / GB).toFixed(0)} GB`]);
  if (s.diskTotal) rows.push(['디스크', (s.diskUsed / s.diskTotal) * 100, `${Math.round((s.diskTotal - s.diskUsed) / GB)} GB 남음`]);
  if (s.gpu) {
    rows.push(['GPU', s.gpu.util, `${s.gpu.util}% · ${s.gpu.temp}°C`]);
    rows.push(['VRAM', (s.gpu.memUsed / s.gpu.memTotal) * 100, `${(s.gpu.memUsed / GB).toFixed(1)} / ${(s.gpu.memTotal / GB).toFixed(0)} GB`]);
  }
  const top = 150;
  const gap = Math.min(92, (H - top - 20) / Math.max(1, rows.length));
  rows.forEach(([name, pct, text], i) => {
    const y = top + i * gap;
    const p = Math.max(0, Math.min(100, pct));
    ctx.fillStyle = '#2b2d42';
    ctx.font = font(700, 38);
    ctx.fillText(name, 40, y + 22);
    ctx.fillStyle = '#e9e4da';
    ctx.beginPath();
    ctx.roundRect(240, y, 560, 44, 22);
    ctx.fill();
    ctx.fillStyle = level(p);
    ctx.beginPath();
    ctx.roundRect(240, y, Math.max(44, (560 * p) / 100), 44, 22);
    ctx.fill();
    ctx.fillStyle = '#2b2d42';
    ctx.font = font(600, 32);
    ctx.fillText(text, 830, y + 22, W - 860);
  });
  if (!rows.length) {
    ctx.fillStyle = '#6c6f85';
    ctx.font = font(600, 40);
    ctx.fillText(s.ok ? '읽는 중…' : '이 컴퓨터에 닿지 않아요', 40, 260);
  }
}

export class StatusBoards {
  private faces = new Map<string, { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; key: string }>();

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

  update(stats: readonly BoardStats[], now = Date.now()) {
    for (const s of stats) {
      const f = this.faces.get(BOARD_FOR[s.id] ?? '');
      if (!f) continue;
      const key = JSON.stringify(s) + Math.floor(now / 15000);
      if (key === f.key) continue;
      f.key = key;
      paint(f.ctx, s, now);
      f.tex.needsUpdate = true;
    }
  }
}
