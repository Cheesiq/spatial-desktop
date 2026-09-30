import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  EdgesGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  OctahedronGeometry,
  type Sprite,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { COLORS, glowSprite } from './fx.js';

/**
 * The rogue bots, all built from primitives at runtime: a dark gunmetal hull,
 * glowing edge lines in the bot's colour, and a hot core with a halo. Each
 * bot owns its line and core materials so it can flash white when hit.
 */

export type BotKind = 'drone' | 'gunner' | 'lancer' | 'overseer' | 'node';

export interface Bot {
  kind: BotKind;
  group: Group;
  hp: number;
  maxHp: number;
  /** Hit sphere, metres. */
  radius: number;
  velocity: Vector3;
  age: number;
  /** Counts down to the next attack. */
  timer: number;
  /** Lancer: 'move' | 'charge'; overseer: 'shielded' | 'exposed'. */
  state: string;
  /** Orbit around the player: radius, height, direction and phase. */
  orbit: { radius: number; height: number; dir: number; angle: number };
  /** Lancer aim point while charging. */
  aim: Vector3;
  passive: boolean;
  parent: Bot | null;
  children: Bot[];
  flash: number;
  dead: boolean;
  materials: Array<LineBasicMaterial | MeshBasicMaterial>;
  baseColors: Color[];
  spinners: Array<{ object: Object3D; axis: 'x' | 'y' | 'z'; speed: number }>;
  halo: Sprite;
  /** Score for destroying it. */
  score: number;
}

const hull = new MeshStandardMaterial({ color: 0x2a3142, metalness: 0.35, roughness: 0.45, flatShading: true, emissive: 0x0a0306 });
const hullDark = new MeshStandardMaterial({ color: 0x161a24, metalness: 0.4, roughness: 0.5, flatShading: true });
const cageMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });

const geometries = new Map<string, BufferGeometry>();
function geo<T extends BufferGeometry>(key: string, make: () => T): T {
  let g = geometries.get(key) as T | undefined;
  if (!g) geometries.set(key, (g = make()));
  return g;
}
const edges = new Map<BufferGeometry, EdgesGeometry>();
function edgesOf(geometry: BufferGeometry): EdgesGeometry {
  let e = edges.get(geometry);
  if (!e) edges.set(geometry, (e = new EdgesGeometry(geometry, 20)));
  return e;
}

function base(kind: BotKind, hp: number, radius: number, score: number, color: Color, haloScale: number): Bot {
  const halo = glowSprite(color, haloScale, 0.55);
  const group = new Group();
  group.add(halo);
  return {
    kind,
    group,
    hp,
    maxHp: hp,
    radius,
    velocity: new Vector3(),
    age: 0,
    timer: 0,
    state: '',
    orbit: { radius: 16, height: 4, dir: 1, angle: 0 },
    aim: new Vector3(),
    passive: false,
    parent: null,
    children: [],
    flash: 0,
    dead: false,
    materials: [],
    baseColors: [],
    spinners: [],
    halo,
    score,
  };
}

/** A hull mesh with glowing edges, added to `parent`. */
function plate(bot: Bot, parent: Object3D, geometry: BufferGeometry, color: Color, material: Material = hull): Mesh {
  const mesh = new Mesh(geometry, material);
  const lines = new MeshlessLines(geometry, color);
  mesh.add(lines.object);
  bot.materials.push(lines.material);
  bot.baseColors.push(color.clone());
  parent.add(mesh);
  return mesh;
}

class MeshlessLines {
  readonly material: LineBasicMaterial;
  readonly object: LineSegments;
  constructor(geometry: BufferGeometry, color: Color) {
    this.material = new LineBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.95 });
    this.object = new LineSegments(edgesOf(geometry), this.material);
    this.object.scale.setScalar(1.004);
  }
}

/** An unlit glowing part (eyes, cores, crystals). */
function core(bot: Bot, parent: Object3D, geometry: BufferGeometry, color: Color): Mesh {
  const material = new MeshBasicMaterial({ color, toneMapped: false });
  bot.materials.push(material);
  bot.baseColors.push(color.clone());
  const mesh = new Mesh(geometry, material);
  parent.add(mesh);
  return mesh;
}

/** Skitter: a small, fast kamikaze drone with spinning blades. */
export function buildDrone(): Bot {
  const bot = base('drone', 1, 0.55, 100, COLORS.enemy, 1.6);
  plate(bot, bot.group, geo('drone-body', () => new OctahedronGeometry(0.3, 0)), COLORS.enemy).scale.set(1, 0.7, 1.3);
  core(bot, bot.group, geo('drone-core', () => new IcosahedronGeometry(0.13, 0)), new Color(1, 0.45, 0.55));
  const rotor = new Group();
  for (let i = 0; i < 3; i++) {
    const blade = plate(bot, rotor, geo('drone-blade', () => new BoxGeometry(0.95, 0.025, 0.1)), COLORS.enemy, hullDark);
    blade.rotation.y = (i * Math.PI) / 3;
  }
  bot.group.add(rotor);
  bot.spinners.push({ object: rotor, axis: 'y', speed: 18 });
  return bot;
}

/** Warden: keeps its distance, circles you and fires bolts. */
export function buildGunner(): Bot {
  const bot = base('gunner', 3, 1.05, 250, COLORS.enemyHot, 3);
  const body = plate(bot, bot.group, geo('gunner-body', () => new DodecahedronGeometry(0.62, 0)), COLORS.enemyHot);
  bot.spinners.push({ object: body, axis: 'z', speed: 0.6 });
  core(bot, bot.group, geo('gunner-eye', () => new SphereGeometry(0.2, 16, 12)), new Color(1, 0.8, 0.4)).position.z = 0.55;
  const ring = plate(bot, bot.group, geo('gunner-ring', () => new TorusGeometry(0.95, 0.05, 6, 32)), COLORS.enemyHot, hullDark);
  bot.spinners.push({ object: ring, axis: 'z', speed: -1.4 });
  for (const side of [-1, 1]) {
    const barrel = plate(bot, bot.group, geo('gunner-barrel', () => new CylinderGeometry(0.07, 0.1, 0.8, 6)), COLORS.enemyHot);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(side * 0.55, -0.2, 0.35);
  }
  return bot;
}

/** Harbinger: a long-range lancer that charges a beam you have to dodge. */
export function buildLancer(): Bot {
  const bot = base('lancer', 5, 1.2, 450, COLORS.lancer, 3.2);
  const spine = plate(bot, bot.group, geo('lancer-spine', () => new ConeGeometry(0.4, 2.6, 6)), COLORS.lancer);
  spine.rotation.x = Math.PI / 2;
  const fins = new Group();
  for (let i = 0; i < 3; i++) {
    const fin = plate(bot, fins, geo('lancer-fin', () => new BoxGeometry(0.04, 1.1, 0.9)), COLORS.lancer, hullDark);
    fin.rotation.z = (i * Math.PI * 2) / 3;
    fin.position.set(Math.sin((i * Math.PI * 2) / 3) * -0.45, Math.cos((i * Math.PI * 2) / 3) * 0.45, -0.5);
  }
  bot.group.add(fins);
  bot.spinners.push({ object: fins, axis: 'z', speed: 1.2 });
  core(bot, bot.group, geo('lancer-tip', () => new OctahedronGeometry(0.2, 0)), new Color(1, 0.6, 1)).position.z = 1.35;
  bot.halo.position.z = 1.1;
  return bot;
}

/** Overseer: the boss. Invulnerable until its four shield nodes fall. */
export function buildOverseer(): Bot {
  const bot = base('overseer', 60, 3.3, 5000, COLORS.enemy, 12);
  const body = plate(bot, bot.group, geo('boss-body', () => new IcosahedronGeometry(2.6, 1)), COLORS.enemy);
  bot.spinners.push({ object: body, axis: 'y', speed: 0.25 });
  // Just the glowing edges of an outer cage, no hull.
  const cage = plate(bot, bot.group, geo('boss-cage', () => new IcosahedronGeometry(3.4, 0)), COLORS.enemyHot, cageMaterial);
  bot.spinners.push({ object: cage, axis: 'x', speed: -0.35 });
  core(bot, bot.group, geo('boss-eye', () => new SphereGeometry(0.9, 24, 16)), new Color(1, 0.3, 0.3)).position.z = 2.3;
  const halo = new Mesh(
    geo('boss-shield', () => new IcosahedronGeometry(4.2, 2)),
    new MeshBasicMaterial({ color: COLORS.enemyHot, wireframe: true, transparent: true, opacity: 0.18, toneMapped: false }),
  );
  halo.name = 'shield';
  bot.group.add(halo);
  bot.spinners.push({ object: halo, axis: 'y', speed: -0.5 });
  bot.state = 'shielded';
  return bot;
}

/** One of the Overseer's shield nodes. */
export function buildNode(): Bot {
  const bot = base('node', 8, 0.9, 600, COLORS.enemyHot, 2.6);
  const body = plate(bot, bot.group, geo('node-body', () => new OctahedronGeometry(0.75, 0)), COLORS.enemyHot);
  bot.spinners.push({ object: body, axis: 'y', speed: 2 });
  core(bot, bot.group, geo('node-core', () => new OctahedronGeometry(0.3, 0)), new Color(1, 0.85, 0.5));
  return bot;
}

export function buildBot(kind: Exclude<BotKind, 'node'>): Bot {
  switch (kind) {
    case 'drone':
      return buildDrone();
    case 'gunner':
      return buildGunner();
    case 'lancer':
      return buildLancer();
    case 'overseer':
      return buildOverseer();
  }
}

/** Per-frame cosmetics: spinning parts, hit flashes, a pulsing halo. */
export function animateBot(bot: Bot, dt: number): void {
  for (const spinner of bot.spinners) spinner.object.rotation[spinner.axis] += spinner.speed * dt;
  if (bot.flash > 0) {
    bot.flash -= dt;
    const white = bot.flash > 0;
    bot.materials.forEach((material, i) => material.color.copy(white ? COLORS.white : bot.baseColors[i]));
  }
  bot.halo.material.opacity = 0.75 + 0.2 * Math.sin(bot.age * 6);
}
