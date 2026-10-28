import * as THREE from 'three';
import { buildBeanbag, buildDesk } from '../../vendor/agent-office/client/world/office/seats';
import { plant } from '../../vendor/agent-office/client/world/office/props';
import { disposeSprite, mesh, roundedBox, textSprite, toon, toonUnique } from '../../vendor/agent-office/client/world/toon';
import type { DeskView } from '../../vendor/agent-office/client/world/types';
import type { DeskDef } from '../../vendor/agent-office/shared/layout';

// Claw Office's own desk floor, laid over Agent Office's room: its sixteen desks and nine bean bags (with
// their rugs, lamps, plants and whiteboard) give way to one team area per computer, side by side in the same
// room with a row of plants between them: M5 to the west, M2 Max to the east of the plants. An area puts
// out only as many pods (four desks each) as it has people, so the floor never fills with empty tables;
// in it, each kind of agent sits together, its kind shown on the desks' panels.

export type ZoneTool = 'openclaw' | 'claude' | 'codex' | 'agy' | 'gjc';

/** Two desks side by side, back to back with two more: the far row faces +z (rotY = PI), as in shared/layout.ts. */
const HALF_W = 1.1;
const HALF_D = 0.55;
export const PER_POD = 4;
const ROWS = [-7.6, -2.6, 2.4, 7.4];

export interface AreaDef {
  id: string;
  label: string;
  /** Pod columns (x of their centers), west to east; pods fill row by row from the north. */
  columns: readonly number[];
  rug: string;
  sign: string;
}

export const AREAS: readonly AreaDef[] = [
  { id: 'm5', label: 'M5', columns: [-14.2, -9.2, -4.2], rug: '#d9f0ea', sign: '#1f7a6b' },
  { id: 'm2max', label: 'M2 Max', columns: [1.8, 6.8], rug: '#e8e0fa', sign: '#6a4fb3' },
];

/** The plants between the two areas, where M5's last column ends and M2 Max's first begins. */
const DIVIDER_X = -1.2;

/** What gives way to the areas: the room west of the lounge, short of the loft's posts. */
const CLEAR: readonly { minX: number; maxX: number; minZ: number; maxZ: number }[] = [
  { minX: -17.1, maxX: 9.4, minZ: -10.2, maxZ: 7.6 },
  { minX: -17.1, maxX: 8.8, minZ: 7.6, maxZ: 10.2 },
];

export const TOOL_TRIM: Record<ZoneTool, string> = { openclaw: '#ef476f', claude: '#d97757', codex: '#3a86ff', agy: '#2a9d8f', gjc: '#8338ec' };

/** Hides everything of the room's own that stands where the areas go; the floor itself (wider than any of them) stays. */
export function clearForPods(root: THREE.Object3D) {
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  const hide: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh && !(o as THREE.Sprite).isSprite) return;
    box.setFromObject(o);
    if (box.isEmpty() || box.max.x - box.min.x > 12 || box.max.z - box.min.z > 12) return;
    box.getCenter(c);
    if (CLEAR.some((r) => c.x > r.minX && c.x < r.maxX && c.z > r.minZ && c.z < r.maxZ)) hide.push(o);
  });
  for (const o of hide) o.visible = false;
}

export interface Pod {
  area: string;
  group: THREE.Group;
  center: THREE.Vector3;
  /** Back left, back right, front left, front right. */
  desks: DeskView[];
}

export interface Zone { area: string; tool: ZoneTool; pods: Pod[]; count: number }
export interface AreaSign { area: string; text: string }

export interface Floor {
  group: THREE.Group;
  /** Every pod each area can put out, in the order it puts them out. */
  pods: ReadonlyMap<string, readonly Pod[]>;
  /** Shows the pods in use (the rest are put away), paints each desk's panel in its kind's color, and puts up each area's sign. */
  setLayout(zones: readonly Zone[], signs: readonly AreaSign[]): void;
}

export function buildFloor(): Floor {
  const group = new THREE.Group();
  const trims = new Map<ZoneTool | 'free', THREE.MeshToonMaterial>();
  const trim = (t: ZoneTool | 'free') => {
    let m = trims.get(t);
    if (!m) trims.set(t, (m = toon(t === 'free' ? '#c9ccd6' : TOOL_TRIM[t])));
    return m;
  };
  const rugGeo = roundedBox(HALF_W * 4 + 0.9, 0.02, HALF_D * 4 + 2.5, 0.5);
  const pods = new Map<string, Pod[]>();
  let n = 0;
  for (const area of AREAS) {
    const list: Pod[] = [];
    for (const z of ROWS)
      for (const x of area.columns) {
        const g = new THREE.Group();
        g.visible = false;
        const rug = mesh(rugGeo, toonUnique(area.rug), x, 0.012, z, false);
        rug.receiveShadow = true;
        g.add(rug);
        const desks: DeskView[] = [];
        for (const [dz, rotY] of [[-HALF_D, Math.PI], [HALF_D, 0]] as const)
          for (const dx of [-HALF_W, HALF_W]) {
            n++;
            const def: DeskDef = { id: `claw-desk-${n}`, x: x + dx, z: z + dz, rotY, label: `Desk ${n}` };
            const desk = buildDesk(def, n - 1, trim('free'));
            desk.vacancy.visible = false;
            g.add(desk.group);
            desks.push(desk);
          }
        group.add(g);
        list.push({ area: area.id, group: g, center: new THREE.Vector3(x, 0, z), desks });
      }
    pods.set(area.id, list);
  }
  for (const [i, z] of [-8.4, -3.4, 1.6, 6.6].entries()) {
    const p = plant((['monstera', 'snake_plant', 'ficus'] as const)[i % 3], 1.1);
    p.position.set(DIVIDER_X, 0, z);
    group.add(p);
  }

  // The modesty panel is the one mesh on a desk in the trim material: repainting it shows whose desk it is.
  const paintDesk = (d: DeskView, mat: THREE.Material) =>
    d.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && [...trims.values()].includes(m.material as THREE.MeshToonMaterial)) m.material = mat;
    });

  const signs: THREE.Sprite[] = [];
  const setLayout: Floor['setLayout'] = (zones, areaSigns) => {
    for (const s of signs.splice(0)) {
      group.remove(s);
      disposeSprite(s);
    }
    const owner = new Map<Pod, ZoneTool>();
    for (const z of zones) for (const p of z.pods) owner.set(p, z.tool);
    for (const list of pods.values())
      for (const p of list) {
        const t = owner.get(p);
        p.group.visible = !!t;
        if (t) for (const d of p.desks) paintDesk(d, trim(t));
      }
    for (const s of areaSigns) {
      const area = AREAS.find((a) => a.id === s.area);
      if (!area) continue;
      const shown = (pods.get(area.id) ?? []).filter((p) => p.group.visible);
      // Over the middle of its first row in use, or of where its first row would be when it has no one.
      const x = (area.columns[0] + area.columns[area.columns.length - 1]) / 2;
      const z = (shown.length ? Math.min(...shown.map((p) => p.center.z)) : ROWS[0]) - 2.4;
      const sign = textSprite(s.text, { bg: area.sign, color: '#fffaf3', size: 72, border: '#fffaf3' });
      sign.position.set(x, 3.6, z);
      group.add(sign);
      signs.push(sign);
    }
  };

  return { group, pods, setLayout };
}

/** An area's pods for `count` people of each kind, in the order given and in the area's own fill order; none beyond it. */
export function allotPods(area: string, available: readonly Pod[], counts: readonly { tool: ZoneTool; count: number }[]): Zone[] {
  let next = 0;
  return counts.map(({ tool, count }) => {
    const want = Math.ceil(count / PER_POD);
    const pods: Pod[] = [];
    while (pods.length < want && next < available.length) pods.push(available[next++]);
    return { area, tool, pods, count };
  });
}

/**
 * The lounge (the couch, coffee table and poufs east of the desks): where agents with nothing to do go and
 * sit until there's work again. Its places fill in order: the couch facing the TV, the two poufs, bean bags
 * round it (two rows north, one south, one by the east wall, each turned to the middle), then spots on the
 * rug to stand about in. Each place is an anchor a worker sits in, sized and turned like a desk's seat.
 */
const LOUNGE_CENTER = { x: 13.4, z: 0 };
/** The couch and the poufs Agent Office already puts there (SEATING in its shared/layout.ts): where to sit, how high. */
const COUCH = { x: 10.45, hips: 0.5, places: [-1.2, 0, 1.2] };
const POUFS: readonly [number, number][] = [[12.5, 3.5], [14.5, -3.4]];
const POUF_HIPS = 0.42;
const BEANBAG_SPOTS: readonly [number, number][] = [
  [11, -6], [13.2, -6.4], [15.4, -6], [17, -4.6],
  [11, -8.6], [13.2, -9], [15.4, -8.6], [17, -7.2],
  [11, 5.8], [13.2, 6.2], [15.4, 5.8],
  [16.6, -1.3], [16.6, 1.5], [17, 3.8], [17.2, -3.2],
];
const STANDING_SPOTS: readonly [number, number][] = [
  [14.6, -1.6], [14.6, 0], [14.6, 1.6], [15.6, -0.8], [15.6, 0.8],
  [12.4, -1.8], [13.6, -1.8], [12.4, 1.8], [13.6, 1.8], [16.2, 3],
];
const SEAT_SCALE = 0.82;

/** An anchor at (x, y, z) facing the lounge's middle (a worker faces its +z). */
function facingMiddle(x: number, y: number, z: number): THREE.Object3D {
  const a = new THREE.Object3D();
  a.position.set(x, y, z);
  a.rotation.y = Math.atan2(LOUNGE_CENTER.x - x, LOUNGE_CENTER.z - z);
  a.scale.setScalar(SEAT_SCALE);
  return a;
}

export function buildLounge(): { group: THREE.Group; spots: THREE.Object3D[] } {
  const group = new THREE.Group();
  const spots: THREE.Object3D[] = [];
  for (const dz of COUCH.places) {
    const a = new THREE.Object3D();
    a.position.set(COUCH.x, COUCH.hips, dz);
    a.rotation.y = Math.PI / 2; // facing the TV on the east wall, as the couch does
    a.scale.setScalar(SEAT_SCALE);
    spots.push(a);
  }
  for (const [x, z] of POUFS) spots.push(facingMiddle(x, POUF_HIPS, z));
  BEANBAG_SPOTS.forEach(([x, z], i) => {
    // A bean bag's sitter faces its -z: turn it so that points at the middle of the lounge.
    const rotY = Math.atan2(-(LOUNGE_CENTER.x - x), -(LOUNGE_CENTER.z - z));
    const def: DeskDef = { id: `claw-lounge-${i + 1}`, x, z, rotY, label: `Lounge ${i + 1}`, beanbag: true };
    const bag = buildBeanbag(def, i);
    bag.vacancy.visible = false;
    group.add(bag.group);
    spots.push(bag.seatAnchor);
  });
  for (const [x, z] of STANDING_SPOTS) spots.push(facingMiddle(x, 0, z));
  for (const s of spots) if (!s.parent) group.add(s);
  return { group, spots };
}
