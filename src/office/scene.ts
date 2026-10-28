import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { buildOffice } from '../../vendor/agent-office/client/world/office/build';
import { preloadModels } from '../../vendor/agent-office/client/world/models';
import { Worker } from '../../vendor/agent-office/client/world/character/worker';
import { Laptop } from '../../vendor/agent-office/client/features/workers/laptop';
import { noOutline } from '../../vendor/agent-office/client/core/outline';
import { GLASS } from '../../vendor/agent-office/client/world/office/materials';
import { FLOOR } from '../../vendor/agent-office/shared/layout';
import { StatusBoards, type BoardStats } from './boards';
import { AREAS, PER_POD, allotPods, buildFloor, buildLounge, clearForPods, type Floor, type Zone, type ZoneTool } from './floorplan';
import type { DeskView, Office } from '../../vendor/agent-office/client/world/types';
import type { WorkerAction, WorkerStatus } from '../../vendor/agent-office/shared/protocol';

// The office itself is Agent Office's own floor (vendor/agent-office, MIT): its lounge, kitchen, loft,
// boards and the street outside, built by its buildOffice(), with its walls taken down and its desks
// swapped for one team area per computer (floorplan.ts). This file lights it the way Agent Office does,
// looks down on it, and seats one of its workers at a desk for each agent, with its computer's team.

export type SeatTool = 'openclaw' | 'claude' | 'codex' | 'agy' | 'gjc';

export interface Seat {
  key: string;
  /** The computer it runs on (an area of floorplan.ts AREAS): each computer's agents sit together. */
  machine: string;
  tool: SeatTool;
  name: string;
  color: string;
  status: WorkerStatus;
  /** The card over its head. */
  card: string;
  /** What its laptop screen says, a line each. */
  screen: string[];
  /** What it is working on, in a line (the session's title): its card over its head and the briefing. */
  brief: string;
  /** Its latest tool calls, oldest first, shown on its laptop like a terminal. */
  actions: string[];
}

/** A worker on its way home: packing up at its desk, then walking off, then gone. */
interface Leaving { p: Placed; t: number }
/** Seconds to pack, then to walk away before it's gone. */
const PACK_S = 2.4;
const WALK_OFF_S = 3.2;

interface Placed {
  seat: Seat;
  desk: DeskView;
  worker: Worker;
  laptop: Laptop;
  painted: string;
  frames: number;
  /** Where its worker is: at its desk, resting in the lounge, on its way between them, or unseated. */
  where: 'desk' | 'lounge' | 'walking' | 'gone';
  /** Its bean bag in the lounge while it rests (its desk stays its own meanwhile). */
  away?: THREE.Object3D;
  walk?: { to: THREE.Object3D; from: THREE.Vector3; target: THREE.Vector3; t: number; dur: number };
}

/** How fast a worker crosses the floor, and the shortest and longest such walk. */
const STROLL = 2.6;
const STROLL_MIN_S = 0.8;
const STROLL_MAX_S = 7;

/** The top of this floor's walls (WALL_HEIGHT in shared/layout.ts): anything wholly above it belongs to the floors over it. */
const ROOF_Y = 6.7;

/**
 * Takes the walls away, so the desks show from any side: every piece of wall (both wall builders mark
 * them userData.wall), the skirting along their feet, the windows (merged into one group across the
 * floor, found by their glass), and whatever hugs the south, east and west walls (doors, rain on the
 * panes, the exit sign). The boards on the north wall stay, standing on their own.
 */
function hideWalls(root: THREE.Object3D) {
  const box = new THREE.Box3();
  const hide = new Set<THREE.Object3D>();
  const near = (lo: number, hi: number, edge: number, out: 1 | -1) =>
    out > 0 ? lo > edge - HUG && hi < edge + HUG + WALL_OUT : hi < edge + HUG && lo > edge - HUG - WALL_OUT;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (m.userData.wall) return void hide.add(m);
    box.setFromObject(m);
    if (m.material === GLASS && m.parent && m.parent !== root) {
      // One mesh per material for every window on the floor: the group is as wide as the room.
      const g = new THREE.Box3().setFromObject(m.parent);
      if (g.max.x - g.min.x > 20 || g.max.z - g.min.z > 20) hide.add(m.parent);
    }
    if (box.max.y < 0.3) return;
    const skirting = box.max.y - box.min.y < 0.3 && box.min.y < 0.01;
    if (skirting && (box.max.x - box.min.x > 1 || box.max.z - box.min.z > 1) && (near(box.min.z, box.max.z, FLOOR.maxZ, 1) || near(box.min.z, box.max.z, FLOOR.minZ, -1) || near(box.min.x, box.max.x, FLOOR.maxX, 1) || near(box.min.x, box.max.x, FLOOR.minX, -1))) return void hide.add(m);
    if (near(box.min.z, box.max.z, FLOOR.maxZ, 1) || near(box.min.x, box.max.x, FLOOR.maxX, 1) || near(box.min.x, box.max.x, FLOOR.minX, -1)) hide.add(m);
  });
  for (const o of hide) o.visible = false;
}

/** How far into the room, and out past the wall, something can reach and still count as hugging it. */
const HUG = 0.6;
const WALL_OUT = 0.8;

/** WASD walks the view over the floor (the way the camera faces), Q and E turn it; Shift doubles the pace. */
const KEYS: Record<string, [forward: number, right: number, turn: number]> = { w: [1, 0, 0], s: [-1, 0, 0], a: [0, -1, 0], d: [0, 1, 0], q: [0, 0, 1], e: [0, 0, -1] };
const WALK = 14; // meters a second
/** One tap of a key moves the view as far as holding it this long. */
const TAP_S = 0.12;
const TURN = 1.4; // radians a second
/** How far from the middle of the floor the view may wander. */
const ROAM = { minX: -26, maxX: 26, minZ: -22, maxZ: 22 };

/**
 * What a worker acts out while it works, from its latest tool call (the line scan.ts writes for it): reading
 * a file or searching, editing one, running a command (the test pose), or browsing the web.
 */
function actionOf(seat: Seat): WorkerAction | undefined {
  if (seat.status !== 'working') return undefined;
  const last = seat.actions.at(-1) ?? '';
  if (last.startsWith('✎')) return 'edit';
  if (last.startsWith('▸') || last.startsWith('⌕')) return 'read';
  if (last.startsWith('🌐')) return 'web';
  if (last.startsWith('$')) return 'test';
  return undefined;
}

const TOOL_BADGE: Record<SeatTool, string> = { openclaw: '🦞 OpenClaw', claude: '✳️ Claude Code', codex: '◎ Codex', agy: '🛸 AGY', gjc: '🐉 GJC' };
const STATUS_TEXT: Partial<Record<WorkerStatus, string>> = { working: '일하는 중', done: '방금 끝남', idle: '대기', needs_input: '확인 필요', offline: '꺼짐', starting: '시작 중' };

export class OfficeScene {
  readonly ready: Promise<void>;
  onPick: ((seat: Seat) => void) | null = null;
  onHover: ((seat: Seat | null) => void) | null = null;
  private renderer: THREE.WebGLRenderer;
  private effect: OutlineEffect;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
  private controls: OrbitControls;
  private office: Office | null = null;
  private pods: Floor | null = null;
  private boards: StatusBoards | null = null;
  private pendingStats: readonly BoardStats[] = [];
  private zoneKey = '';
  private placed = new Map<string, Placed>();
  private leaving: Leaving[] = [];
  private lounge: THREE.Object3D[] = [];
  private pending: Seat[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private resize: ResizeObserver;
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hovered: Placed | null = null;
  /** Movement keys held down (see KEYS). */
  private held = new Set<string>();
  private onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (!(k in KEYS)) return;
    if (e.type === 'keyup') return void this.held.delete(k);
    // Typing somewhere (a terminal, the assign window, the inbox) keeps its keys; so does any shortcut.
    const t = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
    if (!this.host.isConnected || !this.running) return;
    // A tap is a step of its own (a held key then keeps walking frame by frame).
    if (!e.repeat && !this.held.has(k)) this.step(k, TAP_S);
    this.held.add(k);
    e.preventDefault();
  };
  private shift = false;
  private onShift = (e: KeyboardEvent) => (this.shift = e.shiftKey);
  private onBlur = () => this.held.clear();

  constructor(private host: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.className = 'claw-office-canvas';
    host.append(canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.effect = new OutlineEffect(this.renderer, { defaultThickness: 0.0032, defaultColor: [0.17, 0.18, 0.26] });

    // Agent Office's daytime: its sky, fog, hemisphere, ambient and sun (core/scene.ts).
    this.scene.background = new THREE.Color('#bfe3ff');
    this.scene.fog = new THREE.Fog('#bfe3ff', 70, 160);
    this.scene.add(new THREE.HemisphereLight('#fff5e6', '#c9a27a', 1.5), new THREE.AmbientLight('#ffffff', 0.5));
    const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 30, bottom: -30, near: 1, far: 100 });
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);

    this.camera.position.set(-3.5, 24, 25);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(-3.5, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 70;
    this.controls.maxPolarAngle = 1.25;
    this.controls.update();

    canvas.addEventListener('pointermove', (e) => this.hover(e));
    // A drag that turns the camera ends in a click too: only a press that stayed put picks a desk.
    let down = { x: 0, y: 0 };
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('click', (e) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const hit = this.pick(e);
      if (hit && this.onPick) this.onPick(hit.seat);
    });
    window.addEventListener('keydown', this.onShift);
    window.addEventListener('keyup', this.onShift);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas);
    this.fit();

    this.ready = preloadModels().then(() => {
      const office = buildOffice();
      office.setLevel(0, 1, []);
      noOutline(office.group);
      this.scene.add(office.group);
      office.group.updateMatrixWorld(true);
      // Looking down from outside, the storeys and rooftop bar over this floor stand between you and the desks.
      const box = new THREE.Box3();
      office.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && box.setFromObject(o).min.y > ROOF_Y) o.visible = false;
      });
      hideWalls(office.group);
      clearForPods(office.group);
      const pods = buildFloor();
      noOutline(pods.group);
      this.scene.add(pods.group);
      this.pods = pods;
      const lounge = buildLounge();
      noOutline(lounge.group);
      this.scene.add(lounge.group);
      this.lounge = lounge.spots;
      this.office = office;
      this.boards = new StatusBoards(office as unknown as ConstructorParameters<typeof StatusBoards>[0]);
      this.boards.update(this.pendingStats);
      this.setSeats(this.pending);
    });
  }

  /** Desks an area can put out for one computer, or across all of them. */
  capacity(machine?: string) {
    if (!this.pods) return 0;
    return machine ? (this.pods.pods.get(machine)?.length ?? 0) * PER_POD : [...this.pods.pods.values()].reduce((n, l) => n + l.length * PER_POD, 0);
  }

  /**
   * Seats everyone in `seats` with their computer's team, each kind of agent together in it (OpenClaw, then
   * Claude Code, then Codex), each at the desk it had while that desk is still its kind's, newcomers at the
   * first free one. Whoever is no longer listed goes home; whoever doesn't fit isn't seated.
   */
  setSeats(seats: Seat[]) {
    this.pending = seats;
    const pods = this.pods;
    if (!pods) return;
    const order: ZoneTool[] = ['openclaw', 'claude', 'codex', 'gjc', 'agy'];
    const zones: Zone[] = AREAS.flatMap((a) => {
      const mine = seats.filter((s) => s.machine === a.id);
      return allotPods(a.id, pods.pods.get(a.id) ?? [], order.map((tool) => ({ tool, count: mine.filter((s) => s.tool === tool).length })));
    });
    const signs = AREAS.map((a) => {
      const mine = seats.filter((s) => s.machine === a.id);
      const working = mine.filter((s) => s.status === 'working').length;
      return { area: a.id, text: `🖥 ${a.label} · ${mine.length}명${working ? ` · 일하는 중 ${working}` : ''}` };
    });
    const key = zones.map((z) => `${z.area}:${z.tool}:${z.pods.length}:${z.count}`).join('|') + signs.map((x) => x.text).join('|');
    if (key !== this.zoneKey) {
      this.zoneKey = key;
      pods.setLayout(zones, signs);
    }
    const slot = (machine: string, tool: string) => `${machine}:${tool}`;
    const slots = new Map(zones.map((z) => [slot(z.area, z.tool), z.pods.flatMap((p) => p.desks)]));
    const wanted = new Map<string, Seat>();
    for (const z of zones) seats.filter((s) => s.machine === z.area && s.tool === z.tool).slice(0, slots.get(slot(z.area, z.tool))!.length).forEach((s) => wanted.set(s.key, s));

    for (const [k, p] of this.placed) {
      if (wanted.has(k)) continue;
      // Gone home: it packs up and walks off (see tick), and its desk stays taken until it has.
      p.worker.leave('퇴근 👋');
      this.leaving.push({ p, t: 0 });
      this.placed.delete(k);
    }
    // Who keeps their desk: still in their own zone, and nobody before them took it.
    const taken = new Set<DeskView>(this.leaving.map((l) => l.p.desk));
    for (const p of this.placed.values()) {
      if (slots.get(slot(p.seat.machine, p.seat.tool))?.includes(p.desk) && !taken.has(p.desk)) taken.add(p.desk);
      else this.unseat(p);
    }
    for (const seat of wanted.values()) {
      let p = this.placed.get(seat.key);
      if (!p || p.where === 'gone') {
        const desk = slots.get(slot(seat.machine, seat.tool))?.find((d) => !taken.has(d));
        if (!desk) continue;
        taken.add(desk);
        if (!p) {
          p = { seat, desk, worker: new Worker(seat.name, seat.color), laptop: new Laptop(), painted: '', frames: 0, where: 'gone' };
          this.placed.set(seat.key, p);
          p.worker.setStatus(seat.status, seat.status === 'needs_input');
        }
        this.seatAt(p, desk);
      }
      const was = p.seat.status;
      p.seat = seat;
      if (was !== seat.status) {
        p.worker.setStatus(seat.status, seat.status === 'needs_input');
        if (seat.status === 'done' && was === 'working') p.worker.celebrate();
      }
      p.worker.setTask({ name: `${TOOL_BADGE[seat.tool]} · ${seat.name}`, summary: seat.brief || seat.card });
      p.worker.setAction(actionOf(seat));
      noOutline(p.worker.root);
      this.restOrReturn(p);
    }
  }

  /** An agent with nothing to do goes and sits in the lounge (while a bean bag is free); with work again, back to its desk. */
  private restOrReturn(p: Placed) {
    const resting = p.seat.status === 'idle';
    if (resting && !p.away && p.where === 'desk') {
      const taken = new Set([...this.placed.values()].map((q) => q.away));
      const spot = this.lounge.find((b) => !taken.has(b));
      if (!spot) return;
      p.away = spot;
      this.walkTo(p, spot);
    } else if (!resting && p.away) {
      p.away = undefined;
      this.walkTo(p, p.desk.seatAnchor);
    }
  }

  /** Lifts the worker out of where it sits and sets it walking, in the room's own space, to `to`. */
  private walkTo(p: Placed, to: THREE.Object3D) {
    const root = p.worker.root;
    this.scene.attach(root);
    const target = to.getWorldPosition(new THREE.Vector3());
    const from = root.position.clone();
    const dur = Math.max(STROLL_MIN_S, Math.min(STROLL_MAX_S, from.distanceTo(target) / STROLL));
    p.walk = { to, from, target, t: 0, dur };
    p.where = 'walking';
    p.worker.walking = true;
  }

  /** Moves each walking worker along, facing the way it goes, and sits it down when it arrives. */
  private stroll(dt: number) {
    for (const p of this.placed.values()) {
      const w = p.walk;
      if (!w) continue;
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const root = p.worker.root;
      root.position.lerpVectors(w.from, w.target, k);
      root.rotation.set(0, Math.atan2(w.target.x - w.from.x, w.target.z - w.from.z), 0);
      if (k < 1) continue;
      w.to.attach(root);
      root.position.set(0, 0, 0);
      root.rotation.set(0, 0, 0);
      root.scale.setScalar(1);
      p.walk = undefined;
      p.worker.walking = false;
      p.where = w.to === p.desk.seatAnchor ? 'desk' : 'lounge';
    }
  }

  private seatAt(p: Placed, desk: DeskView) {
    p.desk = desk;
    p.away = undefined;
    p.walk = undefined;
    p.where = 'desk';
    p.worker.walking = false;
    desk.seatAnchor.add(p.worker.root);
    p.worker.root.position.set(0, 0, 0);
    p.worker.root.rotation.set(0, 0, 0);
    p.worker.root.scale.setScalar(1);
    p.worker.setPropSpot(p.worker.root.worldToLocal(desk.laptopAnchor.localToWorld(new THREE.Vector3(0.64, 0.5, -0.1))));
    desk.laptopAnchor.add(p.laptop.root);
    desk.chair.rotation.y = 0;
    noOutline(desk.group);
  }

  private unseat(p: Placed) {
    p.worker.root.removeFromParent();
    p.desk.laptopAnchor.remove(p.laptop.root);
    p.away = undefined;
    p.walk = undefined;
    p.where = 'gone';
  }

  /** Each computer's health, on its board on the north wall. */
  setStats(stats: readonly BoardStats[]) {
    this.pendingStats = stats;
    this.boards?.update(stats);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.getDelta();
    const frame = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      this.tick();
    };
    frame();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    window.removeEventListener('keydown', this.onShift);
    window.removeEventListener('keyup', this.onShift);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.resize.disconnect();
    this.controls.dispose();
    for (const p of [...this.placed.values(), ...this.leaving.map((l) => l.p)]) {
      p.worker.dispose();
      p.laptop.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private tick() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    this.walk(dt);
    this.stroll(dt);
    this.controls.update();
    const people: { x: number; y: number; z: number }[] = [];
    for (const p of this.placed.values()) {
      p.worker.update(dt, t);
      p.laptop.update(dt, undefined, 30);
      // Its own screen over the laptop's placeholder, once the laptop has painted that.
      if (++p.frames > 2) this.paintScreen(p);
    }
    this.goHome(dt, t);
    this.office?.update(t, dt, people);
    this.effect.render(this.scene, this.camera);
  }

  /** Moves the camera and what it looks at together, so the view slides over the floor without tilting. */
  private walk(dt: number) {
    if (this.held.size) this.move([...this.held], dt);
  }

  private step(key: string, seconds: number) {
    this.move([key], seconds);
  }

  private move(keys: string[], dt: number) {
    let fwd = 0, right = 0, turn = 0;
    for (const k of keys) {
      const [f, r, q] = KEYS[k];
      fwd += f;
      right += r;
      turn += q;
    }
    const fast = this.shift ? 2 : 1;
    const cam = this.camera.position;
    const target = this.controls.target;
    if (turn) {
      // Turning swings the camera round what it looks at.
      const off = cam.clone().sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn * TURN * dt * fast);
      cam.copy(target).add(off);
    }
    if (fwd || right) {
      const ahead = target.clone().sub(cam).setY(0).normalize();
      const side = new THREE.Vector3().crossVectors(ahead, new THREE.Vector3(0, 1, 0));
      const step = ahead.multiplyScalar(fwd).add(side.multiplyScalar(right)).normalize().multiplyScalar(WALK * dt * fast);
      const next = target.clone().add(step);
      next.x = Math.max(ROAM.minX, Math.min(ROAM.maxX, next.x));
      next.z = Math.max(ROAM.minZ, Math.min(ROAM.maxZ, next.z));
      const moved = next.sub(target);
      target.add(moved);
      cam.add(moved);
    }
  }

  /** Each leaving worker: packs up and shuts its laptop, turns its back on the desk and walks off, then goes. */
  private goHome(dt: number, t: number) {
    if (!this.leaving.length) return;
    for (const l of this.leaving) {
      l.t += dt;
      const { worker, laptop } = l.p;
      laptop.shut(dt);
      if (l.t > PACK_S) {
        worker.walking = true;
        worker.root.rotation.y = Math.PI;
        // The seat faces the desk: its -z leads away from it.
        worker.root.position.z -= 1.3 * dt;
      }
      worker.update(dt, t);
    }
    const gone = this.leaving.filter((l) => l.t > PACK_S + WALK_OFF_S);
    if (!gone.length) return;
    this.leaving = this.leaving.filter((l) => !gone.includes(l));
    for (const { p } of gone) {
      this.unseat(p);
      p.worker.dispose();
      p.laptop.dispose();
    }
  }

  private paintScreen(p: Placed) {
    const key = [...p.seat.screen, ...p.seat.actions, p.seat.brief, p.seat.status].join('\n');
    if (key === p.painted) return;
    p.painted = key;
    const l = p.laptop as unknown as { ctx: CanvasRenderingContext2D; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture };
    const { ctx, canvas } = l;
    const w = canvas.width;
    const h = canvas.height;
    const pad = 40;
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, w, h);
    // A terminal's title bar: its traffic lights, then who this is and what it's on.
    ctx.fillStyle = '#313244';
    ctx.fillRect(0, 0, w, 76);
    ['#f38ba8', '#f9e2af', '#a6e3a1'].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(34 + i * 34, 38, 11, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#cdd6f4';
    ctx.font = '700 34px "Pretendard", "Apple SD Gothic Neo", system-ui, sans-serif';
    ctx.fillText(`${p.seat.name}${p.seat.brief ? ` — ${p.seat.brief}` : ''}`, 150, 40, w - 190);
    ctx.textBaseline = 'top';
    const rows = p.seat.actions.length ? p.seat.actions.slice(-9) : p.seat.screen;
    ctx.font = '500 34px ui-monospace, Menlo, "Apple SD Gothic Neo", monospace';
    rows.forEach((line, i) => {
      const last = i === rows.length - 1;
      ctx.fillStyle = line.startsWith('$') ? (last ? '#a6e3a1' : '#94e2d5') : line.startsWith('✎') ? '#f9e2af' : last ? '#f5e0dc' : '#bac2de';
      ctx.fillText(line, pad, 100 + i * 52, w - pad * 2);
    });
    const state = STATUS_TEXT[p.seat.status] ?? p.seat.status;
    ctx.font = '700 38px "Apple SD Gothic Neo", system-ui, sans-serif';
    ctx.fillStyle = p.seat.status === 'working' ? '#f9e2af' : p.seat.status === 'done' ? '#a6e3a1' : p.seat.status === 'needs_input' ? '#f38ba8' : '#89b4fa';
    ctx.fillText(`● ${state}`, pad, h - 70);
    l.texture.needsUpdate = true;
  }


  private fit() {
    // The canvas's own box: the terminal panel beside it takes part of the page.
    const w = Math.max(1, this.renderer.domElement.clientWidth);
    const h = Math.max(1, this.renderer.domElement.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private pick(e: PointerEvent | MouseEvent): Placed | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    let best: Placed | null = null;
    let bestD = Infinity;
    for (const p of this.placed.values()) {
      for (const obj of [p.worker.root, p.desk.group]) {
        const hit = this.ray.intersectObject(obj, true)[0];
        if (hit && hit.distance < bestD) {
          bestD = hit.distance;
          best = p;
        }
      }
    }
    return best;
  }

  private hover(e: PointerEvent) {
    const hit = this.pick(e);
    if (hit === this.hovered) return;
    this.hovered = hit;
    this.renderer.domElement.style.cursor = hit ? 'pointer' : '';
    this.onHover?.(hit ? hit.seat : null);
  }
}
