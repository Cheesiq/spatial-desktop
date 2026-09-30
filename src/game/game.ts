import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  createSystem,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Euler,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix3,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  OctahedronGeometry,
  type PerspectiveCamera,
  Quaternion,
  ShaderMaterial,
  CircleGeometry,
  type Sprite,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import { cosmos } from '../environment.js';
import { GameAudio } from './audio.js';
import { animateBot, type Bot, type BotKind, buildBot, buildNode } from './bots.js';
import { Beam, type Bolt, BoltRenderer, COLORS, glowSprite, Particles, Transients, Warp } from './fx.js';
import { type Blip, type HudState, type Phase, ScreenHud, XrHud } from './hud.js';

/**
 * ROGUE PROTOCOL — a wave shooter played from Spatial Desktop's platform.
 *
 * Rogue bots warp in from every direction; you hold the platform with twin
 * blasters, a deflector shield that parries bolts back at them, and nova
 * charges that clear the sky. Clear a wave and the platform jumps to the next
 * sector of the universe (the sky turns and re-tints under a hyperspace warp).
 *
 * The same game runs flat (mouse look with pointer lock, WASD, touch) and in
 * VR (a blaster in each hand, grip for the shield, stick to move).
 */

export interface GameHost {
  audio: AudioContext;
  /** Hide the desktop (panels, dock, control bar) and pause the ambient score. */
  enter(): void;
  /** Bring it all back. */
  exit(): void;
  /** UI sounds and music settings from the app. */
  sounds(): boolean;
  music(): boolean;
}

interface Pickup {
  kind: 'repair' | 'overdrive' | 'nova';
  group: Group;
  velocity: Vector3;
  age: number;
}

interface Gun {
  group: Group;
  muzzle: Object3D;
  flash: Sprite;
  cooldown: number;
}

interface Shield {
  mesh: Mesh;
  material: ShaderMaterial;
  radius: number;
  on: number;
}

const SECTORS = [
  'Orion Drift',
  'Veil of Cygnus',
  'Hydra Expanse',
  'Magellan Reach',
  'Andromeda Gate',
  'Boötes Void',
  'Carina Forge',
  'Sagittarius Deep',
  'Perseus Arm',
  'The Great Attractor',
];

const PLATFORM_RADIUS = 4.5;
const BEST_KEY = 'rogue-protocol.best';
const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const q1 = new Quaternion();
const Z = new Vector3(0, 0, -1);

/** Closest distance between segments p1-q1 and p2-q2. */
function segmentDistance(p1: Vector3, e1: Vector3, p2: Vector3, e2: Vector3): number {
  const d1 = v1.subVectors(e1, p1);
  const d2 = v2.subVectors(e2, p2);
  const r = v3.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s = 0;
  let t = 0;
  if (a <= 1e-8 && e <= 1e-8) return r.length();
  if (a <= 1e-8) {
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= 1e-8) {
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const cx = p1.x + d1.x * s - (p2.x + d2.x * t);
  const cy = p1.y + d1.y * s - (p2.y + d2.y * t);
  const cz = p1.z + d1.z * s - (p2.z + d2.z * t);
  return Math.hypot(cx, cy, cz);
}

/** Distance from point p to segment a-b. */
function pointSegment(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = v1.subVectors(b, a);
  const t = Math.min(1, Math.max(0, v2.subVectors(p, a).dot(ab) / Math.max(ab.lengthSq(), 1e-8)));
  return v3.copy(a).addScaledVector(ab, t).distanceTo(p);
}

/** A luminance-preserving hue rotation, for tinting each sector's nebula. */
function hueMatrix(degrees: number, out = new Matrix3()): Matrix3 {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return out.set(
    0.213 + 0.787 * c - 0.213 * s, 0.715 - 0.715 * c - 0.715 * s, 0.072 - 0.072 * c + 0.928 * s,
    0.213 - 0.213 * c + 0.143 * s, 0.715 + 0.285 * c + 0.14 * s, 0.072 - 0.072 * c - 0.283 * s,
    0.213 - 0.213 * c - 0.787 * s, 0.715 - 0.715 * c + 0.715 * s, 0.072 + 0.928 * c + 0.072 * s,
  );
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export class GameSystem extends createSystem({}) {
  /** True while the game has taken over the scene. */
  active = false;
  /** Plays itself (attract mode, trailers); `god` makes it invincible. */
  autopilot = false;
  god = false;

  private host: GameHost | null = null;
  private audio!: GameAudio;
  private readonly root = new Group();
  private readonly particles = new Particles();
  private readonly transients = new Transients();
  private readonly friendlyBolts = new BoltRenderer(COLORS.player, 2.6);
  private readonly hostileBolts = new BoltRenderer(COLORS.enemyHot, 1.1);
  private readonly warp = new Warp();
  private readonly xrHud = new XrHud();
  private hud!: ScreenHud;
  private readonly light = new DirectionalLight(0xbfd8ff, 2.2);
  /** From behind you, so the faces bots turn toward you aren't black. */
  private readonly fill = new DirectionalLight(0xffb8d8, 1.4);

  private phase: Phase = 'title';
  private bots: Bot[] = [];
  private bolts: Bolt[] = [];
  private pickups: Pickup[] = [];
  private score = 0;
  private best = Number(stored(BEST_KEY) ?? 0) || 0;
  private newBest = false;
  private streak = 0;
  private kills = 0;
  private hull = 100;
  private energy = 100;
  private shieldRest = 0;
  private novas = 1;
  private overdrive = 0;
  private invulnerable = 0;
  private damageFlash = 0;
  private hitmarker = -1;
  private shake = 0;
  private wave = 0;
  private sector = 0;
  private queue: Array<{ at: number; kind: Exclude<BotKind, 'node'> }> = [];
  private waveClock = 0;
  private between: { t: number; warped: boolean } | null = null;
  private banner: { title: string; sub: string; age: number } | null = null;
  private nova: { radius: number; hit: Set<Bot> } | null = null;
  private jump: { t: number; from: Quaternion; to: Quaternion; fromTint: Matrix3; toTint: Matrix3; facing: Quaternion } | null = null;
  private clock = 0;
  private lowAlarm = 0;

  // Viewer and input.
  private readonly head = new Vector3();
  private readonly headForward = new Vector3();
  private readonly chest = new Vector3();
  private yaw = 0;
  private pitch = 0;
  private locked = false;
  private wasLocked = false;
  private touch = false;
  private readonly keys = new Set<string>();
  private firing = false;
  private shielding = false;
  private readonly cursor = new Vector2();
  private cursorSeen = false;
  private touchPoint: { id: number; x: number; y: number } | null = null;
  private saved: { position: Vector3; quaternion: Quaternion; fov: number; player: Vector3; playerQuat: Quaternion } | null = null;
  private readonly baseFov = { value: 50 };
  private readonly listeners: Array<() => void> = [];
  private snapReady = true;

  // Weapons.
  private readonly screenGuns: Gun[] = [];
  private readonly handGuns: Record<'left' | 'right', Gun> = {} as never;
  private screenShield!: Shield;
  private readonly handShields: Record<'left' | 'right', Shield> = {} as never;
  private nextScreenGun = 0;
  private readonly aimDir = new Vector3();
  private readonly aimFrom = new Vector3();
  private autopilotAim = new Vector3(0, 0, -1);
  private autopilotTarget: Bot | null = null;

  init(): void {
    this.root.name = 'rogue-protocol';
    this.light.position.set(-20, 30, 10);
    this.fill.position.set(12, 4, 30);
    this.root.add(this.light, this.fill, this.particles.points, this.transients.group, this.friendlyBolts.group, this.hostileBolts.group, this.warp.lines);
    for (const side of [-1, 1]) {
      // Low in the corners of the view, toed in toward the crosshair.
      const gun = this.makeGun(side);
      gun.group.position.set(side * 0.27, -0.24, -0.5);
      gun.group.rotation.set(0.1, -side * 0.12, 0);
      gun.group.scale.setScalar(0.6);
      this.screenGuns.push(gun);
    }
    for (const hand of ['left', 'right'] as const) {
      this.handGuns[hand] = this.makeGun(hand === 'left' ? -1 : 1);
      this.handShields[hand] = this.makeShield(0.28);
    }
    this.screenShield = this.makeShield(0.42);
  }

  // ---- lifecycle ------------------------------------------------------------------

  /** Take over the scene with the title screen. */
  open(host: GameHost): void {
    if (this.active) return;
    this.host = host;
    this.audio ??= new GameAudio(host.audio);
    this.hud ??= new ScreenHud({
      engage: () => this.engage(),
      resume: () => this.resume(),
      restart: () => this.engage(),
      quit: () => this.close(),
      nova: () => this.fireNova(),
    });
    this.active = true;
    host.enter();
    this.audio.enabled = host.sounds();
    this.audio.musicEnabled = host.music();

    const camera = this.camera as PerspectiveCamera;
    this.saved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      fov: camera.fov,
      player: this.player.position.clone(),
      playerQuat: this.player.quaternion.clone(),
    };
    this.baseFov.value = Math.max(camera.fov, 62);
    const euler = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = euler.y;
    this.pitch = 0.08;

    this.scene.add(this.root);
    for (const gun of this.screenGuns) camera.add(gun.group);
    camera.add(this.screenShield.mesh);
    this.screenShield.mesh.position.set(0, -0.02, -0.8);
    for (const hand of ['left', 'right'] as const) {
      this.player.raySpaces[hand].add(this.handGuns[hand].group);
      this.player.raySpaces[hand].add(this.handShields[hand].mesh);
      this.handShields[hand].mesh.position.set(0, 0, -0.22);
    }
    this.scene.add(this.xrHud.mesh);
    this.attachInput();
    this.hud.visible = true;
    this.xrHud.place(this.head, this.headForward, 0, true);
    this.toTitle();
  }

  /** Leave the game and give the desktop back. */
  close(): void {
    if (!this.active) return;
    this.active = false;
    this.clearArena();
    for (const off of this.listeners.splice(0)) off();
    if (document.pointerLockElement) document.exitPointerLock();
    this.audio.stopMusic(0.4);
    this.scene.remove(this.root, this.xrHud.mesh);
    for (const gun of [...this.screenGuns, this.handGuns.left, this.handGuns.right]) gun.group.removeFromParent();
    for (const shield of [this.screenShield, this.handShields.left, this.handShields.right]) shield.mesh.removeFromParent();
    const camera = this.camera as PerspectiveCamera;
    if (this.saved) {
      camera.position.copy(this.saved.position);
      camera.quaternion.copy(this.saved.quaternion);
      camera.fov = this.saved.fov;
      camera.updateProjectionMatrix();
      this.player.position.copy(this.saved.player);
      this.player.quaternion.copy(this.saved.playerQuat);
    }
    cosmos.universe.quaternion.identity();
    cosmos.tint.value.identity();
    this.jump = null;
    this.hud.visible = false;
    this.host?.exit();
  }

  private toTitle(): void {
    this.phase = 'title';
    this.clearArena();
    this.resetRun();
    this.audio.startMusic(0);
    // A patrol circling far out, so the title screen has something to look at.
    for (let i = 0; i < 6; i++) {
      const bot = this.spawn(i < 2 ? 'gunner' : i < 3 ? 'lancer' : 'drone', undefined, false);
      bot.passive = true;
      bot.orbit.radius = 22 + Math.random() * 16;
      bot.orbit.height = 3 + Math.random() * 10;
    }
  }

  private resetRun(): void {
    this.score = 0;
    this.newBest = false;
    this.streak = 0;
    this.kills = 0;
    this.hull = 100;
    this.energy = 100;
    this.novas = 1;
    this.overdrive = 0;
    this.wave = 0;
    this.sector = 0;
    this.queue = [];
    this.between = null;
    this.banner = null;
    this.nova = null;
    this.damageFlash = 0;
    cosmos.universe.quaternion.identity();
    cosmos.tint.value.identity();
    this.jump = null;
  }

  /** Start a run: from the title, after a game over, or restarting from pause. */
  engage(): void {
    if (!this.active) return;
    this.requestLock();
    for (const bot of this.bots) this.explode(bot, false);
    this.clearArena();
    this.resetRun();
    this.phase = 'playing';
    this.audio.startMusic(1);
    this.startWave(1);
  }

  private resume(): void {
    if (this.phase !== 'paused') return;
    this.requestLock();
    this.phase = 'playing';
  }

  private pause(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.firing = this.shielding = false;
  }

  private requestLock(): void {
    if (this.renderer.xr.isPresenting || this.touch || this.autopilot) return;
    const canvas = this.renderer.domElement;
    try {
      const request = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      request?.catch?.(() => {});
    } catch {
      // No pointer lock here (some webviews): aim with the cursor instead.
    }
  }

  private clearArena(): void {
    for (const bot of this.bots) this.removeBot(bot);
    this.bots = [];
    this.bolts = [];
    for (const pickup of this.pickups) pickup.group.removeFromParent();
    this.pickups = [];
    this.particles.clear();
    this.transients.clear();
  }

  // ---- input ----------------------------------------------------------------------

  private attachInput(): void {
    const canvas = this.renderer.domElement;
    type AnyEvent = KeyboardEvent & PointerEvent;
    const on = (target: EventTarget, type: string, handler: (event: AnyEvent) => void, capture = false) => {
      target.addEventListener(type, handler as EventListener, capture);
      this.listeners.push(() => target.removeEventListener(type, handler as EventListener, capture));
    };
    on(window, 'keydown', (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      this.keys.add(event.code);
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) this.fireNova();
      }
      if (event.code === 'Escape' && !event.repeat) {
        if (this.phase === 'playing' && !this.locked) this.pause();
        else if (this.phase === 'paused' && !this.wasLocked) this.resume();
        else if (this.phase === 'title' || this.phase === 'over') this.close();
      }
      if ((event.code === 'Enter' || event.code === 'KeyF') && (this.phase === 'title' || this.phase === 'over') && !event.repeat) this.engage();
      if (event.code === 'KeyP' && !event.repeat) this.phase === 'paused' ? this.resume() : this.pause();
    }, true);
    on(window, 'keyup', (event) => this.keys.delete(event.code), true);
    on(window, 'blur', () => {
      this.keys.clear();
      this.firing = this.shielding = false;
    });
    on(canvas, 'mousedown', (event) => {
      if (this.phase !== 'playing') return;
      if (!this.locked && !this.cursorSeen) this.requestLock();
      if (event.button === 0) this.firing = true;
      if (event.button === 2) this.shielding = true;
    });
    on(window, 'mouseup', (event) => {
      if (event.button === 0) this.firing = false;
      if (event.button === 2) this.shielding = false;
    });
    on(window, 'mousemove', (event) => {
      if (this.locked) {
        this.yaw -= event.movementX * 0.0022;
        this.pitch = Math.min(1.45, Math.max(-1.2, this.pitch - event.movementY * 0.0022));
      } else if (event.target === canvas) {
        const rect = canvas.getBoundingClientRect();
        this.cursor.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        this.cursorSeen = true;
      }
    });
    on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) this.wasLocked = true;
      if (!this.locked && this.wasLocked && this.phase === 'playing') this.pause();
      if (!this.locked) this.wasLocked = this.phase === 'paused' ? this.wasLocked : false;
    });
    on(canvas, 'pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      this.touch = true;
      if (this.phase !== 'playing') return;
      this.touchPoint = { id: event.pointerId, x: event.clientX, y: event.clientY };
      this.firing = true;
    });
    on(canvas, 'pointermove', (event) => {
      const t = this.touchPoint;
      if (!t || t.id !== event.pointerId) return;
      this.yaw += (event.clientX - t.x) * 0.005;
      this.pitch = Math.min(1.45, Math.max(-1.2, this.pitch + (event.clientY - t.y) * 0.005));
      t.x = event.clientX;
      t.y = event.clientY;
    });
    const endTouch = (event: AnyEvent) => {
      if (this.touchPoint?.id !== event.pointerId) return;
      this.touchPoint = null;
      this.firing = false;
    };
    on(window, 'pointerup', endTouch);
    on(window, 'pointercancel', endTouch);
  }

  // ---- building ---------------------------------------------------------------------

  private makeGun(side: number): Gun {
    const group = new Group();
    const body = new Mesh(new BoxGeometry(0.045, 0.05, 0.2), new MeshStandardMaterial({ color: 0x1c2233, metalness: 0.8, roughness: 0.3 }));
    body.position.z = 0.02;
    const edges = new LineSegments(new EdgesGeometry(body.geometry), new LineBasicMaterial({ color: COLORS.player, toneMapped: false }));
    body.add(edges);
    const barrel = new Mesh(new CylinderGeometry(0.012, 0.016, 0.14, 8), new MeshBasicMaterial({ color: COLORS.player, toneMapped: false }));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.008, -0.13);
    const muzzle = new Group();
    muzzle.position.set(0, 0.008, -0.21);
    const flash = glowSprite(COLORS.player, 0.12, 0);
    muzzle.add(flash);
    group.add(body, barrel, muzzle);
    group.userData.side = side;
    return { group, muzzle, flash, cooldown: 0 };
  }

  private makeShield(radius: number): Shield {
    const material = new ShaderMaterial({
      uniforms: { uOn: { value: 0 }, uHit: { value: 0 }, uTime: { value: 0 }, uColor: { value: COLORS.player.clone() } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uOn, uHit, uTime;
        uniform vec3 uColor;
        varying vec2 vUv;
        // Distance to the nearest hexagon edge.
        float hex(vec2 p) {
          p *= 7.0;
          vec2 r = vec2(1.0, 1.732);
          vec2 h = r * 0.5;
          vec2 a = mod(p, r) - h;
          vec2 b = mod(p - h, r) - h;
          vec2 g = dot(a, a) < dot(b, b) ? a : b;
          vec2 q = abs(g);
          return 0.5 - max(dot(q, normalize(vec2(1.0, 1.732))), q.x);
        }
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float rim = smoothstep(0.82, 1.0, r);
          float cells = smoothstep(0.06, 0.0, hex(vUv + vec2(0.0, uTime * 0.05)));
          float a = (0.03 + 0.14 * cells + 0.8 * rim) * uOn + uHit * (0.45 - 0.35 * r);
          gl_FragColor = vec4(mix(uColor, vec3(1.0), uHit * 0.6) * a, 1.0);
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    const mesh = new Mesh(new CircleGeometry(radius, 48), material);
    mesh.renderOrder = 5;
    mesh.visible = false;
    return { mesh, material, radius, on: 0 };
  }

  private spawn(kind: Exclude<BotKind, 'node'>, at?: Vector3, effects = true): Bot {
    const bot = buildBot(kind);
    // Bigger than life so they read at 50 m; the Overseer is already huge.
    if (kind !== 'overseer') {
      bot.group.scale.setScalar(1.5);
      bot.radius *= 1.5;
    }
    if (at) {
      bot.group.position.copy(at);
    } else {
      // Anywhere around you, above the horizon, far out.
      const azimuth = Math.random() * Math.PI * 2;
      const elevation = 0.08 + Math.random() * 0.55;
      const distance = kind === 'overseer' ? 42 : 48 + Math.random() * 10;
      bot.group.position.set(
        this.head.x + Math.cos(azimuth) * Math.cos(elevation) * distance,
        this.head.y + Math.sin(elevation) * distance,
        this.head.z + Math.sin(azimuth) * Math.cos(elevation) * distance,
      );
    }
    const offset = v1.subVectors(bot.group.position, this.head);
    bot.orbit = {
      radius: kind === 'gunner' ? 13 + Math.random() * 9 : kind === 'lancer' ? 26 + Math.random() * 8 : kind === 'overseer' ? 30 : 20,
      height: kind === 'overseer' ? 9 : 1 + Math.random() * (kind === 'lancer' ? 14 : 9),
      dir: Math.random() < 0.5 ? -1 : 1,
      angle: Math.atan2(offset.z, offset.x),
    };
    bot.timer = 1.5 + Math.random() * 2;
    bot.state = kind === 'lancer' ? 'move' : bot.state;
    bot.velocity.copy(offset).normalize().multiplyScalar(-4);
    this.root.add(bot.group);
    this.bots.push(bot);
    if (kind === 'lancer') {
      const beam = new Beam(COLORS.lancer);
      bot.group.userData.beam = beam;
      this.root.add(beam.mesh);
    }
    if (kind === 'overseer') {
      for (let i = 0; i < 4; i++) {
        const node = buildNode();
        node.group.scale.setScalar(1.3);
        node.radius *= 1.3;
        node.parent = bot;
        node.orbit.angle = (i * Math.PI) / 2;
        node.group.position.copy(bot.group.position);
        bot.children.push(node);
        this.root.add(node.group);
        this.bots.push(node);
        const tether = new Beam(COLORS.enemyHot);
        node.group.userData.beam = tether;
        this.root.add(tether.mesh);
      }
    }
    if (effects) {
      const size = kind === 'overseer' ? 14 : kind === 'drone' ? 2 : 4;
      this.transients.ring(bot.group.position, kind === 'lancer' ? COLORS.lancer : COLORS.enemy, 0.2, size, 0.6);
      this.transients.flash(bot.group.position, COLORS.white, size * 2, size * 0.5, 0.35);
      this.audio.warpIn(bot.group.position);
    }
    return bot;
  }

  private removeBot(bot: Bot): void {
    bot.dead = true;
    bot.group.removeFromParent();
    (bot.group.userData.beam as Beam | undefined)?.mesh.removeFromParent();
  }

  // ---- waves ------------------------------------------------------------------------

  private startWave(n: number): void {
    this.wave = n;
    const boss = n % 5 === 0;
    const drones = Math.min(26, (boss ? 2 : 3) + n * 2);
    const gunners = n >= 2 ? Math.min(9, Math.floor(n / 2) + (boss ? 0 : 1)) : 0;
    const lancers = n >= 3 ? Math.min(5, Math.floor((n - 1) / 2) - (boss ? 1 : 0)) : 0;
    const list: Array<Exclude<BotKind, 'node'>> = [];
    for (let i = 0; i < drones; i++) list.push('drone');
    for (let i = 0; i < gunners; i++) list.push('gunner');
    for (let i = 0; i < lancers; i++) list.push('lancer');
    list.sort(() => Math.random() - 0.5);
    // Squads of three every couple of seconds, after a short breather.
    this.queue = list.map((kind, i) => ({ at: 1.6 + Math.floor(i / 3) * (boss ? 3.2 : 2.2) + (i % 3) * 0.25, kind }));
    if (boss) this.queue.unshift({ at: 2, kind: 'overseer' });
    this.waveClock = 0;
    this.banner = {
      title: boss ? `WAVE ${n} · OVERSEER` : `WAVE ${n}`,
      sub: `Sector ${this.sector + 1}: ${SECTORS[this.sector % SECTORS.length]}`,
      age: 0,
    };
    this.audio.setIntensity(boss ? 2 : 1);
    this.audio.waveStart();
  }

  private waveCleared(): void {
    const bonus = 500 * this.wave + Math.round(this.hull) * 10;
    this.score += bonus;
    this.banner = { title: 'SECTOR CLEAR', sub: `+${bonus.toLocaleString('en-US')} · jumping to the next sector`, age: 0 };
    this.between = { t: 0, warped: false };
    this.audio.setIntensity(0);
  }

  /** Hyperspace to the next sector: streaks, a turning sky and a new nebula tint. */
  private startJump(): void {
    this.sector++;
    const to = new Quaternion().setFromEuler(new Euler((Math.random() - 0.5) * 1.6, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 1.2));
    const facing = new Quaternion().setFromEuler(new Euler(0, this.renderer.xr.isPresenting ? Math.atan2(-this.headForward.x, -this.headForward.z) : this.yaw, 0));
    this.jump = {
      t: 0,
      from: cosmos.universe.quaternion.clone(),
      to,
      fromTint: cosmos.tint.value.clone(),
      toTint: hueMatrix((this.sector * 67) % 360),
      facing,
    };
    this.audio.warp();
  }

  // ---- the frame ----------------------------------------------------------------------

  update(delta: number): void {
    if (!this.active) return;
    const dt = Math.min(delta, 0.05);
    this.clock += dt;
    const xr = this.renderer.xr.isPresenting;
    const camera = this.camera as PerspectiveCamera;

    this.readHead(xr);
    if (!xr) this.driveScreenCamera(dt, camera);
    else this.driveXr(dt);
    this.readHead(xr);

    const playing = this.phase === 'playing';
    const simulate = playing || this.phase === 'title' || this.phase === 'over';
    if (simulate) {
      this.updateWeapons(dt, xr, playing);
      this.updateBots(dt);
      this.updateBolts(dt);
      this.updatePickups(dt);
      this.updateNova(dt);
      if (playing) this.updateWave(dt);
      if (this.hull < 30 && playing) this.audio.lowHull();
    }
    this.updateJump(dt, camera, xr);
    this.particles.setViewport(this.renderer);
    this.particles.update(simulate ? dt : 0);
    this.transients.update(simulate ? dt : 0, this.head);
    this.friendlyBolts.update(this.bolts, (b) => b.friendly, this.head);
    this.hostileBolts.update(this.bolts, (b) => !b.friendly, this.head);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
    this.shake = Math.max(0, this.shake - dt * 3);
    if (this.banner) {
      this.banner.age += dt;
      if (this.banner.age > 3.2) this.banner = null;
    }

    const state = this.hudState();
    this.hud.root.hidden = xr;
    if (!xr) this.hud.update(state, camera, this.clock);
    this.xrHud.mesh.visible = xr;
    if (xr) {
      this.xrHud.place(this.head, this.headForward, dt);
      this.xrHud.update(state, this.clock);
    }
  }

  private readHead(xr: boolean): void {
    const node = xr ? this.player.head : this.camera;
    node.getWorldPosition(this.head);
    node.getWorldQuaternion(q1);
    this.headForward.copy(Z).applyQuaternion(q1);
    this.chest.copy(this.head).y -= 0.45;
  }

  private driveScreenCamera(dt: number, camera: PerspectiveCamera): void {
    if (!this.saved) return;
    // Cursor aim (no pointer lock): turn when the cursor nears the edge.
    if (!this.locked && !this.touch && this.cursorSeen && this.phase === 'playing' && !this.autopilot) {
      const edge = (v: number) => Math.sign(v) * Math.max(0, Math.abs(v) - 0.7) / 0.3;
      this.yaw -= edge(this.cursor.x) * dt * 1.8;
      this.pitch = Math.min(1.45, Math.max(-1.2, this.pitch + edge(this.cursor.y) * dt * 1.2));
    }
    if (this.autopilot && this.phase !== 'paused') this.steerAutopilot(dt);
    else if (this.phase === 'title' || this.phase === 'over') this.yaw += dt * 0.05;

    // Walk the platform.
    if (this.phase === 'playing') {
      const move = v1.set(0, 0, 0);
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.z -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.z += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.x -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.x += 1;
      if (this.autopilot) move.x = Math.sin(this.clock * 0.9) * 0.8;
      if (move.lengthSq() > 0) {
        move.normalize().applyAxisAngle(new Vector3(0, 1, 0), this.yaw).multiplyScalar(4.2 * dt);
        this.player.position.add(move);
        this.clampToPlatform();
      }
    }

    camera.quaternion.setFromEuler(new Euler(this.pitch, this.yaw, 0, 'YXZ'));
    camera.position.copy(this.saved.position);
    if (this.shake > 0) {
      const s = this.shake * this.shake * 0.06;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
    }
    const strength = this.jump ? this.jumpStrength(this.jump.t) : 0;
    const fov = this.baseFov.value + strength * 28;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  private clampToPlatform(): void {
    const p = this.player.position;
    const r = Math.hypot(p.x, p.z);
    if (r > PLATFORM_RADIUS) p.multiplyScalar(PLATFORM_RADIUS / r).setY(0);
  }

  private driveXr(dt: number): void {
    const pads = this.input.xr.gamepads;
    const left = pads.left;
    const right = pads.right;
    const pressed = (id: string) => (left?.getButtonDown(id) ?? false) || (right?.getButtonDown(id) ?? false);
    const trigger = pressed('xr-standard-trigger');
    if (pressed('b-button') || pressed('y-button')) {
      if (this.phase === 'playing') this.pause();
      else this.close();
      return;
    }
    if (trigger && (this.phase === 'title' || this.phase === 'over')) this.engage();
    else if (trigger && this.phase === 'paused') this.resume();
    if ((pressed('a-button') || pressed('x-button')) && this.phase === 'playing') this.fireNova();

    // Left stick walks the platform; right stick snap-turns.
    const stick = left?.getAxesValues('xr-standard-thumbstick');
    if (stick && this.phase === 'playing' && Math.hypot(stick.x, stick.y) > 0.15) {
      const yaw = Math.atan2(-this.headForward.x, -this.headForward.z);
      const move = v1.set(stick.x, 0, stick.y).applyAxisAngle(new Vector3(0, 1, 0), yaw).multiplyScalar(2.6 * dt);
      this.player.position.add(move);
      this.clampToPlatform();
    }
    const turn = right?.getAxesValues('xr-standard-thumbstick')?.x ?? 0;
    if (Math.abs(turn) < 0.3) this.snapReady = true;
    else if (this.snapReady && Math.abs(turn) > 0.75) {
      this.snapReady = false;
      const angle = -Math.sign(turn) * (Math.PI / 6);
      // Turn about the head, not the play-space origin.
      const pivot = v2.copy(this.head);
      this.player.position.sub(pivot).applyAxisAngle(new Vector3(0, 1, 0), angle).add(pivot);
      this.player.rotateY(angle);
    }
  }

  // ---- weapons ----------------------------------------------------------------------

  private updateWeapons(dt: number, xr: boolean, playing: boolean): void {
    this.overdrive = Math.max(0, this.overdrive - dt);
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    for (const gun of this.screenGuns) gun.group.visible = !xr;
    for (const hand of ['left', 'right'] as const) this.handGuns[hand].group.visible = xr;
    const rate = this.overdrive > 0 ? 0.075 : 0.13;

    // Shields.
    const shieldWanted = {
      screen: !xr && playing && (this.shielding || this.keys.has('ShiftLeft') || (this.autopilot && this.threatened())),
      left: xr && playing && (this.input.xr.gamepads.left?.getButtonPressed('xr-standard-squeeze') ?? false),
      right: xr && playing && (this.input.xr.gamepads.right?.getButtonPressed('xr-standard-squeeze') ?? false),
    };
    const anyShield = shieldWanted.screen || shieldWanted.left || shieldWanted.right;
    if (anyShield && this.energy > 2) {
      this.energy = Math.max(0, this.energy - dt * 28);
      this.shieldRest = 0.8;
      this.audio.shieldHum(true);
    } else {
      this.shieldRest -= dt;
      if (this.shieldRest <= 0) this.energy = Math.min(100, this.energy + dt * 20);
    }
    const setShield = (shield: Shield, wanted: boolean) => {
      shield.on += ((wanted && this.energy > 2 ? 1 : 0) - shield.on) * Math.min(1, dt * 14);
      shield.mesh.visible = shield.on > 0.02 || shield.material.uniforms.uHit.value > 0.02;
      shield.material.uniforms.uOn.value = shield.on;
      shield.material.uniforms.uTime.value = this.clock;
      shield.material.uniforms.uHit.value = Math.max(0, shield.material.uniforms.uHit.value - dt * 4);
    };
    setShield(this.screenShield, shieldWanted.screen);
    setShield(this.handShields.left, shieldWanted.left);
    setShield(this.handShields.right, shieldWanted.right);

    for (const gun of [...this.screenGuns, this.handGuns.left, this.handGuns.right]) {
      gun.cooldown -= dt;
      gun.flash.material.opacity = Math.max(0, gun.flash.material.opacity - dt * 14);
    }
    if (!playing) return;

    if (xr) {
      for (const hand of ['left', 'right'] as const) {
        const gun = this.handGuns[hand];
        if (!(this.input.xr.gamepads[hand]?.getButtonPressed('xr-standard-trigger') ?? false) || gun.cooldown > 0) continue;
        gun.cooldown = rate * 1.3;
        const space = this.player.raySpaces[hand];
        space.getWorldQuaternion(q1);
        this.fireFrom(gun, v1.copy(Z).applyQuaternion(q1));
      }
      return;
    }

    // Flat screen: aim through the crosshair (or the cursor), guns alternate.
    const camera = this.camera as PerspectiveCamera;
    camera.updateMatrixWorld();
    if (this.locked || this.touch || this.autopilot || !this.cursorSeen) {
      this.aimDir.copy(this.headForward);
      this.aimFrom.copy(this.head);
    } else {
      this.aimFrom.copy(this.head);
      this.aimDir.set(this.cursor.x, this.cursor.y, 0.5).unproject(camera).sub(this.head).normalize();
    }
    const wantsFire = this.firing || this.keys.has('KeyJ') || (this.autopilot && this.autopilotWantsFire());
    const gun = this.screenGuns[this.nextScreenGun];
    if (!wantsFire || gun.cooldown > 0) return;
    this.nextScreenGun = (this.nextScreenGun + 1) % this.screenGuns.length;
    gun.cooldown = rate * 2;
    this.screenGuns[this.nextScreenGun].cooldown = Math.max(this.screenGuns[this.nextScreenGun].cooldown, rate);
    // Converge on whatever the crosshair is over, else far away.
    let range = 60;
    for (const bot of this.bots) {
      const to = v2.subVectors(bot.group.position, this.aimFrom);
      const along = to.dot(this.aimDir);
      if (along <= 0 || along > range) continue;
      if (to.lengthSq() - along * along < bot.radius * bot.radius) range = along;
    }
    const target = v3.copy(this.aimFrom).addScaledVector(this.aimDir, range);
    gun.muzzle.getWorldPosition(v1);
    this.fireFrom(gun, target.sub(v1).normalize());
  }

  private fireFrom(gun: Gun, dir: Vector3): void {
    const from = gun.muzzle.getWorldPosition(new Vector3());
    const spread = this.overdrive > 0 ? [-0.035, 0, 0.035] : [0];
    const side = v2.crossVectors(dir, new Vector3(0, 1, 0)).normalize();
    for (const angle of spread) {
      const d = dir.clone().applyAxisAngle(side.lengthSq() ? v3.crossVectors(side, dir).normalize() : new Vector3(0, 1, 0), angle);
      this.bolts.push({ position: from.clone(), previous: from.clone(), velocity: d.multiplyScalar(95), life: 0.8, friendly: true, damage: 1, travelled: 0 });
    }
    gun.flash.material.opacity = 1;
    this.audio.laser();
  }

  private fireNova(): void {
    if (this.phase !== 'playing' || this.novas <= 0 || this.nova) return;
    this.novas--;
    this.nova = { radius: 0, hit: new Set() };
    this.transients.sphere(this.head, COLORS.nova, 0.5, 45, 1.1, 0.4);
    this.transients.ring(this.chest, COLORS.nova, 0.5, 40, 1.0, new Vector3(0, 1, 0), 1);
    this.transients.ring(this.chest, COLORS.player, 0.5, 30, 0.8, new Vector3(0, 1, 0), 0.8);
    this.shake = 1;
    this.audio.nova();
  }

  private updateNova(dt: number): void {
    const nova = this.nova;
    if (!nova) return;
    nova.radius += dt * 42;
    for (const bot of this.bots) {
      if (bot.dead || nova.hit.has(bot) || bot.group.position.distanceTo(this.head) > nova.radius) continue;
      nova.hit.add(bot);
      if (bot.kind === 'overseer' && bot.state === 'shielded') continue;
      this.damage(bot, bot.kind === 'overseer' ? 10 : 6, bot.group.position);
    }
    this.bolts = this.bolts.filter((bolt) => {
      if (bolt.friendly || bolt.position.distanceTo(this.head) > nova.radius) return true;
      this.particles.burst(bolt.position, COLORS.nova, 6, 4, 0.12, 0.4);
      return false;
    });
    if (nova.radius > 45) this.nova = null;
  }

  // ---- bots -----------------------------------------------------------------------------

  private updateBots(dt: number): void {
    const wave = Math.max(1, this.wave);
    const passiveWorld = this.phase !== 'playing';
    for (const bot of this.bots) {
      if (bot.dead) continue;
      bot.age += dt;
      bot.timer -= dt;
      animateBot(bot, dt);
      const p = bot.group.position;
      const passive = bot.passive || passiveWorld;

      // Thruster trails, so movement reads at a distance.
      if ((bot.kind === 'drone' || bot.kind === 'gunner') && bot.velocity.lengthSq() > 4 && Math.random() < dt * 40) {
        const back = v2.copy(bot.velocity).normalize().multiplyScalar(-bot.radius * 0.8).add(p);
        this.particles.emit(back, v3.copy(bot.velocity).multiplyScalar(-0.15), bot.kind === 'drone' ? COLORS.enemy : COLORS.enemyHot, bot.kind === 'drone' ? 0.22 : 0.35, 0.45, 2);
      }

      switch (bot.kind) {
        case 'drone': {
          if (passive) {
            this.orbitSteer(bot, dt, 5, 0.25);
          } else {
            // Weave in on your chest.
            const speed = Math.min(13, 6.5 + wave * 0.35);
            const weave = v2.set(Math.sin(bot.age * 3.1 + bot.orbit.angle * 5), Math.cos(bot.age * 2.3 + bot.orbit.angle * 3), 0).multiplyScalar(Math.min(1, p.distanceTo(this.chest) / 12) * 3);
            const desired = v1.subVectors(this.chest, p).normalize().multiplyScalar(speed).add(weave);
            bot.velocity.lerp(desired, Math.min(1, dt * 2.2));
            if (pointSegment(p, this.head, this.chest) < bot.radius + 0.35) {
              this.hurt(14, p);
              this.explode(bot, false);
              continue;
            }
          }
          p.addScaledVector(bot.velocity, dt);
          bot.group.lookAt(v1.copy(p).add(bot.velocity));
          break;
        }
        case 'gunner': {
          this.orbitSteer(bot, dt, passive ? 3 : 4.5, passive ? 0.12 : 0.22);
          p.addScaledVector(bot.velocity, dt);
          bot.group.lookAt(this.head);
          if (!passive && bot.timer <= 0 && p.distanceTo(this.head) < 40) {
            bot.timer = Math.max(1.3, 3.1 - wave * 0.12) * (0.8 + Math.random() * 0.4);
            this.enemyFire(bot, 1, 0.05);
          }
          break;
        }
        case 'lancer':
          this.updateLancer(bot, dt, passive, wave);
          break;
        case 'overseer':
          this.updateOverseer(bot, dt, passive, wave);
          break;
        case 'node': {
          const boss = bot.parent!;
          bot.orbit.angle += dt * 0.7;
          const a = bot.orbit.angle;
          const target = v1.set(Math.cos(a) * 6.5, Math.sin(a * 2) * 1.5, Math.sin(a) * 6.5).add(boss.group.position);
          p.lerp(target, Math.min(1, dt * 4));
          bot.group.lookAt(this.head);
          (bot.group.userData.beam as Beam).set(p, boss.group.position, 0.05 + 0.02 * Math.sin(bot.age * 12), 0.55);
          break;
        }
      }
    }
    this.bots = this.bots.filter((bot) => !bot.dead);
  }

  /** Circle the player at the bot's orbit radius and height, drifting around. */
  private orbitSteer(bot: Bot, dt: number, speed: number, angular: number): void {
    const o = bot.orbit;
    o.angle += o.dir * angular * dt;
    const target = v1.set(this.head.x + Math.cos(o.angle) * o.radius, this.head.y + o.height + Math.sin(bot.age * 0.7) * 1.5, this.head.z + Math.sin(o.angle) * o.radius);
    const to = target.sub(bot.group.position);
    const d = to.length();
    const desired = to.normalize().multiplyScalar(Math.min(speed * 2.5, d * 0.9 + speed * 0.3));
    bot.velocity.lerp(desired, Math.min(1, dt * 1.6));
  }

  private enemyFire(bot: Bot, count: number, spread: number, speedScale = 1): void {
    const from = v3.copy(bot.group.position).addScaledVector(v2.subVectors(this.head, bot.group.position).normalize(), bot.radius);
    const speed = Math.min(21, 12 + this.wave * 0.45) * speedScale;
    for (let i = 0; i < count; i++) {
      // Aim a little ahead of where you're moving and scatter.
      const dir = v1.subVectors(this.head, from).normalize();
      dir.x += (Math.random() - 0.5) * spread * 2 + (count > 1 ? (i - (count - 1) / 2) * spread : 0);
      dir.y += (Math.random() - 0.5) * spread * 2 - 0.02;
      dir.z += (Math.random() - 0.5) * spread * 2;
      dir.normalize();
      this.bolts.push({ position: from.clone(), previous: from.clone(), velocity: dir.clone().multiplyScalar(speed), life: 6, friendly: false, damage: 9, travelled: 0 });
    }
    this.transients.flash(from, COLORS.enemyHot, 1.8, 0.4, 0.2);
    this.audio.enemyShot(from);
  }

  private updateLancer(bot: Bot, dt: number, passive: boolean, wave: number): void {
    const p = bot.group.position;
    const beam = bot.group.userData.beam as Beam;
    if (bot.state === 'move' || passive) {
      this.orbitSteer(bot, dt, 2.5, 0.08);
      p.addScaledVector(bot.velocity, dt);
      bot.group.lookAt(this.head);
      beam.set(p, p, 0, 0);
      if (!passive && bot.timer <= 0 && p.distanceTo(this.head) < 50) {
        bot.state = 'charge';
        bot.timer = Math.max(1.1, 1.8 - wave * 0.04);
        bot.aim.copy(this.head);
        this.audio.charge(p, bot.timer);
      }
      return;
    }
    // Charging: hold still, track you, then lock for the last half second.
    bot.velocity.multiplyScalar(Math.max(0, 1 - dt * 4));
    p.addScaledVector(bot.velocity, dt);
    if (bot.timer > 0.5) bot.aim.lerp(this.head, Math.min(1, dt * 6));
    bot.group.lookAt(bot.aim);
    const tip = v2.set(0, 0, 1.35).applyMatrix4(bot.group.matrixWorld);
    const far = v3.subVectors(bot.aim, tip).normalize().multiplyScalar(90).add(tip);
    if (bot.timer > 0) {
      const locked = bot.timer <= 0.5;
      // The aim line stops short of you, so it doesn't smear across the view.
      const reach = Math.max(1, tip.distanceTo(bot.aim) - 1.5);
      const aimEnd = v1.subVectors(bot.aim, tip).normalize().multiplyScalar(reach).add(tip);
      beam.set(tip, aimEnd, locked ? 0.03 : 0.012, locked ? 0.5 + 0.5 * Math.sin(bot.age * 60) : 0.35);
      if (Math.random() < 0.5) this.particles.emit(tip, new Vector3().randomDirection().multiplyScalar(1.5), COLORS.lancer, 0.12, 0.3);
      return;
    }
    // Fire.
    bot.state = 'move';
    bot.timer = 4 + Math.random() * 2.5;
    const start = tip.clone();
    const end = far.clone();
    let blocked = false;
    for (const shield of this.liveShields()) {
      const hit = this.segmentShield(start, end, shield);
      if (hit) {
        blocked = true;
        end.copy(hit);
        this.shieldHit(shield, hit, 22);
      }
    }
    if (!blocked && segmentDistance(start, end, this.head, this.chest) < 0.5) this.hurt(22, start);
    // Drawn only up to where it passes you (it still hits all the way through).
    const along = v1.subVectors(end, start).normalize();
    const pass = Math.max(1, v2.subVectors(this.head, start).dot(along) - 1.5);
    if (pass < start.distanceTo(end)) end.copy(start).addScaledVector(along, pass);
    beam.set(start, end, 0.12, 1);
    setTimeout(() => !bot.dead && bot.state === 'move' && beam.set(start, end, 0.05, 0.4), 90);
    setTimeout(() => !bot.dead && bot.state === 'move' && beam.set(start, start, 0, 0), 220);
    this.particles.burst(end, COLORS.lancer, 16, 6, 0.15, 0.4);
    this.audio.beam(start);
  }

  private updateOverseer(bot: Bot, dt: number, passive: boolean, wave: number): void {
    const p = bot.group.position;
    this.orbitSteer(bot, dt, 2.2, 0.05);
    p.addScaledVector(bot.velocity, dt);
    bot.group.lookAt(this.head);
    const exposed = bot.children.every((node) => node.dead);
    if (exposed && bot.state === 'shielded') {
      bot.state = 'exposed';
      const shield = bot.group.getObjectByName('shield');
      if (shield) shield.visible = false;
      this.transients.sphere(p, COLORS.enemyHot, 4, 9, 0.6, 0.5);
      this.particles.burst(p, COLORS.enemyHot, 80, 16, 0.3, 0.9);
      this.audio.explosion(p, 4);
      this.banner = { title: 'CORE EXPOSED', sub: 'Hit the Overseer', age: 0 };
    }
    if (passive || bot.timer > 0) return;
    bot.timer = exposed ? 2.2 : 3.2;
    this.enemyFire(bot, exposed ? 7 : 5, 0.07, 0.9);
    if (bot.age % 2 < 1.1 && this.bots.filter((b) => b.kind === 'drone' && !b.dead).length < 10) {
      for (let i = 0; i < (exposed ? 3 : 2); i++) this.spawn('drone', v1.copy(p).add(new Vector3().randomDirection().multiplyScalar(4)));
    }
    void wave;
  }

  // ---- bolts ------------------------------------------------------------------------------

  private liveShields(): Shield[] {
    return [this.screenShield, this.handShields.left, this.handShields.right].filter((s) => s.on > 0.5 && s.mesh.parent && s.mesh.visible);
  }

  /** Where segment a-b crosses the shield disc, if it does. */
  private segmentShield(a: Vector3, b: Vector3, shield: Shield): Vector3 | null {
    const center = shield.mesh.getWorldPosition(new Vector3());
    const normal = new Vector3(0, 0, 1).applyQuaternion(shield.mesh.getWorldQuaternion(q1));
    const da = v1.subVectors(a, center).dot(normal);
    const db = v2.subVectors(b, center).dot(normal);
    if (da * db > 0) return null;
    const t = da / (da - db);
    const hit = new Vector3().lerpVectors(a, b, t);
    // A little generous at the rim.
    return hit.distanceTo(center) <= shield.radius * 1.15 ? hit : null;
  }

  private shieldHit(shield: Shield, at: Vector3, cost: number): void {
    shield.material.uniforms.uHit.value = 1;
    this.energy = Math.max(0, this.energy - cost);
    this.particles.burst(at, COLORS.player, 14, 3, 0.05, 0.35);
    this.audio.shieldBlock(at);
  }

  private updateBolts(dt: number): void {
    const survivors: Bolt[] = [];
    for (const bolt of this.bolts) {
      bolt.previous.copy(bolt.position);
      bolt.position.addScaledVector(bolt.velocity, dt);
      bolt.travelled += bolt.velocity.length() * dt;
      bolt.life -= dt;
      if (bolt.life <= 0) continue;
      if (bolt.friendly ? this.friendlyHit(bolt) : this.hostileHit(bolt)) continue;
      survivors.push(bolt);
    }
    this.bolts = survivors;
  }

  /** Your bolt against bots, enemy bolts and pickups. True if it's spent. */
  private friendlyHit(bolt: Bolt): boolean {
    for (const bot of this.bots) {
      if (bot.dead) continue;
      if (pointSegment(bot.group.position, bolt.previous, bolt.position) > bot.radius) continue;
      if (bot.kind === 'overseer' && bot.state === 'shielded') {
        this.particles.burst(bolt.position, COLORS.enemyHot, 5, 5, 0.08, 0.25);
        this.audio.hit(bolt.position);
        return true;
      }
      this.damage(bot, bolt.damage, bolt.position);
      return true;
    }
    for (const other of this.bolts) {
      if (other.friendly || other.life <= 0) continue;
      if (pointSegment(other.position, bolt.previous, bolt.position) > 0.4) continue;
      other.life = 0;
      this.addScore(25);
      this.particles.burst(other.position, COLORS.enemyHot, 10, 5, 0.08, 0.35);
      this.audio.hit(other.position);
      return true;
    }
    for (const pickup of this.pickups) {
      if (pointSegment(pickup.group.position, bolt.previous, bolt.position) > 0.7) continue;
      this.collect(pickup);
      return true;
    }
    return false;
  }

  /** An enemy bolt against your shields and you. True if it's spent. */
  private hostileHit(bolt: Bolt): boolean {
    if (bolt.life <= 0) return true;
    for (const shield of this.liveShields()) {
      const hit = this.segmentShield(bolt.previous, bolt.position, shield);
      if (!hit) continue;
      // Parry: the bolt flies back out as yours.
      const normal = new Vector3(0, 0, 1).applyQuaternion(shield.mesh.getWorldQuaternion(q1));
      bolt.velocity.reflect(normal).multiplyScalar(2.2);
      // Nudge it toward the nearest bot so parries feel good.
      const target = this.nearestBot(hit, bolt.velocity);
      if (target) bolt.velocity.lerp(v1.subVectors(target.group.position, hit).normalize().multiplyScalar(bolt.velocity.length()), 0.6);
      bolt.position.copy(hit);
      bolt.friendly = true;
      bolt.travelled = 0;
      bolt.damage = 2;
      bolt.life = 1.5;
      this.shieldHit(shield, hit, 6);
      this.addScore(50);
      return false;
    }
    if (segmentDistance(bolt.previous, bolt.position, this.head, this.chest) < 0.3) {
      this.hurt(bolt.damage, bolt.previous);
      this.particles.burst(bolt.position, COLORS.enemyHot, 12, 4, 0.08, 0.3);
      return true;
    }
    return false;
  }

  private nearestBot(from: Vector3, heading: Vector3): Bot | null {
    let best: Bot | null = null;
    let score = -Infinity;
    const dir = v2.copy(heading).normalize();
    for (const bot of this.bots) {
      if (bot.dead || (bot.kind === 'overseer' && bot.state === 'shielded')) continue;
      const to = v3.subVectors(bot.group.position, from);
      const d = to.length();
      const s = to.normalize().dot(dir) * 2 - d / 40;
      if (s > score) {
        score = s;
        best = bot;
      }
    }
    return best;
  }

  // ---- damage and score ----------------------------------------------------------------------

  private damage(bot: Bot, amount: number, at: Vector3): void {
    bot.hp -= amount;
    bot.flash = 0.07;
    this.hitmarker = this.clock;
    this.particles.burst(at, COLORS.white, 5, 6, 0.06, 0.25);
    this.audio.hit(at);
    if (bot.hp <= 0) this.explode(bot, true);
  }

  private explode(bot: Bot, byPlayer: boolean): void {
    if (bot.dead) return;
    const p = bot.group.position.clone();
    const size = bot.kind === 'overseer' ? 8 : bot.kind === 'drone' ? 1 : bot.kind === 'node' ? 2.5 : 3;
    const color = bot.kind === 'lancer' ? COLORS.lancer : bot.kind === 'drone' ? COLORS.enemy : COLORS.enemyHot;
    this.removeBot(bot);
    this.particles.burst(p, COLORS.white, 10 * size, 7 * size ** 0.6, 0.12, 0.35);
    this.particles.burst(p, color, 28 * size, 5 * size ** 0.6, 0.25 * size ** 0.4, 1.1);
    this.particles.burst(p, COLORS.enemyHot, 12 * size, 2.5 * size ** 0.6, 0.45 * size ** 0.4, 1.4);
    this.transients.flash(p, COLORS.white, size * 1.5, size * 4, 0.3);
    this.transients.flash(p, color, size * 2, size * 6, 0.6, 0.8);
    this.transients.ring(p, color, size * 0.4, size * 4, 0.7);
    this.audio.explosion(p, size);
    if (bot.kind === 'overseer') {
      this.shake = 1;
      for (const node of bot.children) if (!node.dead) this.explode(node, byPlayer);
      for (let i = 0; i < 6; i++) {
        setTimeout(() => {
          if (!this.active) return;
          const q = p.clone().add(new Vector3().randomDirection().multiplyScalar(3));
          this.particles.burst(q, COLORS.enemyHot, 120, 10, 0.4, 1.2);
          this.transients.flash(q, COLORS.white, 4, 14, 0.5);
          this.audio.explosion(q, 5);
        }, 150 + i * 160);
      }
    }
    if (!byPlayer || this.phase !== 'playing') return;
    this.kills++;
    this.streak++;
    this.addScore(bot.score);
    const chance = { drone: 0.07, gunner: 0.2, lancer: 0.35, node: 0.3, overseer: 1 }[bot.kind];
    const drops = bot.kind === 'overseer' ? 3 : Math.random() < chance ? 1 : 0;
    for (let i = 0; i < drops; i++) this.drop(p, bot.kind === 'overseer' ? (['repair', 'nova', 'overdrive'] as const)[i] : undefined);
  }

  private get multiplier(): number {
    return Math.min(8, 1 + Math.floor(this.streak / 6));
  }

  private addScore(points: number): void {
    this.score += points * this.multiplier;
  }

  private hurt(amount: number, from: Vector3): void {
    if (this.phase !== 'playing' || this.invulnerable > 0 || this.god) return;
    this.hull = Math.max(0, this.hull - amount);
    this.streak = 0;
    this.damageFlash = Math.min(1.2, this.damageFlash + 0.6 + amount / 40);
    this.shake = Math.min(1, this.shake + 0.5);
    this.invulnerable = 0.2;
    this.audio.hurt();
    void from;
    if (this.hull <= 0) this.gameOver();
  }

  private gameOver(): void {
    this.phase = 'over';
    this.firing = this.shielding = false;
    this.nova = null;
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
      try {
        localStorage.setItem(BEST_KEY, String(this.best));
      } catch {
        // Not persisted; fine.
      }
    }
    this.particles.burst(this.chest, COLORS.player, 200, 6, 0.1, 1.5);
    this.transients.sphere(this.head, COLORS.enemy, 0.5, 12, 1.2, 0.5);
    this.audio.stopMusic(1.5);
    this.audio.gameOver();
    if (document.pointerLockElement) document.exitPointerLock();
    this.bolts = this.bolts.filter((b) => b.friendly);
  }

  // ---- pickups -------------------------------------------------------------------------------

  private drop(at: Vector3, kind?: Pickup['kind']): void {
    kind ??= this.hull < 50 && Math.random() < 0.5 ? 'repair' : (['repair', 'overdrive', 'nova'] as const)[Math.floor(Math.random() * 3)];
    const color = COLORS[kind];
    const group = new Group();
    const shape = new OctahedronGeometry(0.28, 0);
    const lines = new LineSegments(new EdgesGeometry(shape), new LineBasicMaterial({ color, toneMapped: false }));
    const heart = new Mesh(new OctahedronGeometry(0.12, 0), new MeshBasicMaterial({ color, toneMapped: false }));
    group.add(lines, heart, glowSprite(color, 1.6, 0.8));
    group.position.copy(at);
    this.root.add(group);
    this.pickups.push({ kind, group, velocity: new Vector3().randomDirection().multiplyScalar(2), age: 0 });
  }

  private updatePickups(dt: number): void {
    for (const pickup of this.pickups) {
      pickup.age += dt;
      const p = pickup.group.position;
      pickup.group.rotation.y += dt * 2.5;
      pickup.group.rotation.x += dt * 1.1;
      // Drift in to you after a moment.
      if (pickup.age > 1) pickup.velocity.lerp(v1.subVectors(this.chest, p).normalize().multiplyScalar(2.2), Math.min(1, dt));
      else pickup.velocity.multiplyScalar(1 - dt * 2);
      p.addScaledVector(pickup.velocity, dt);
      if (this.phase === 'playing' && p.distanceTo(this.chest) < 1.1) this.collect(pickup);
      if (pickup.age > 16) pickup.age = Infinity;
    }
    this.pickups = this.pickups.filter((pickup) => {
      if (pickup.age !== Infinity) return true;
      pickup.group.removeFromParent();
      return false;
    });
  }

  private collect(pickup: Pickup): void {
    if (pickup.age === Infinity) return;
    pickup.age = Infinity;
    if (pickup.kind === 'repair') this.hull = Math.min(100, this.hull + 30);
    if (pickup.kind === 'overdrive') this.overdrive = 10;
    if (pickup.kind === 'nova') this.novas = Math.min(3, this.novas + 1);
    this.addScore(100);
    const label = { repair: 'HULL REPAIRED', overdrive: 'OVERDRIVE', nova: 'NOVA CHARGE' }[pickup.kind];
    this.banner = { title: label, sub: { repair: '+30 hull', overdrive: 'Triple fire for 10 seconds', nova: 'Space / A to unleash' }[pickup.kind], age: 0.4 };
    this.particles.burst(pickup.group.position, COLORS[pickup.kind], 40, 5, 0.12, 0.6);
    this.transients.ring(pickup.group.position, COLORS[pickup.kind], 0.2, 2.5, 0.5);
    this.audio.pickup();
  }

  // ---- waves, jumps -------------------------------------------------------------------------------

  private updateWave(dt: number): void {
    if (this.between) {
      const b = this.between;
      b.t += dt;
      if (b.t > 1.6 && !b.warped) {
        b.warped = true;
        this.startJump();
      }
      if (b.t > 5.2) {
        this.between = null;
        this.startWave(this.wave + 1);
      }
      return;
    }
    this.waveClock += dt;
    while (this.queue.length && this.queue[0].at <= this.waveClock) {
      const next = this.queue.shift()!;
      this.spawn(next.kind);
    }
    this.queue.sort((a, b) => a.at - b.at);
    if (!this.queue.length && !this.bots.some((bot) => !bot.dead)) this.waveCleared();
  }

  private jumpStrength(t: number): number {
    return Math.min(1, t / 0.8) * Math.min(1, Math.max(0, (3.2 - t) / 0.9));
  }

  private updateJump(dt: number, camera: PerspectiveCamera, xr: boolean): void {
    const jump = this.jump;
    if (!jump) {
      this.warp.update(dt, 0);
      return;
    }
    jump.t += dt;
    const strength = this.jumpStrength(jump.t);
    const k = Math.min(1, Math.max(0, (jump.t - 0.6) / 1.8));
    const eased = k * k * (3 - 2 * k);
    cosmos.universe.quaternion.slerpQuaternions(jump.from, jump.to, eased);
    const tint = cosmos.tint.value.elements;
    for (let i = 0; i < 9; i++) tint[i] = jump.fromTint.elements[i] + (jump.toTint.elements[i] - jump.fromTint.elements[i]) * eased;
    this.warp.lines.position.copy(this.head);
    this.warp.lines.quaternion.copy(jump.facing);
    this.warp.update(dt, strength);
    if (!xr) this.shake = Math.max(this.shake, strength * 0.35);
    void camera;
    if (jump.t > 3.3) {
      this.jump = null;
      this.warp.update(dt, 0);
    }
  }

  // ---- autopilot --------------------------------------------------------------------------------------

  /** The most pressing target: charging lancers, then whatever's closest to you. */
  private pickTarget(): Bot | null {
    let best: Bot | null = null;
    let bestScore = Infinity;
    for (const bot of this.bots) {
      if (bot.dead || (bot.kind === 'overseer' && bot.state === 'shielded')) continue;
      const d = bot.group.position.distanceTo(this.head);
      const facing = v1.subVectors(bot.group.position, this.head).normalize().dot(this.headForward);
      const urgency = bot.kind === 'lancer' && bot.state === 'charge' ? -25 : bot.kind === 'node' ? -8 : bot.kind === 'drone' ? -4 : 0;
      const score = d + urgency - facing * 10 + (bot === this.autopilotTarget ? -6 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = bot;
      }
    }
    return best;
  }

  private steerAutopilot(dt: number): void {
    const target = this.phase === 'playing' ? this.pickTarget() : null;
    this.autopilotTarget = target;
    if (target) {
      // Lead the target a little.
      const to = v1.subVectors(target.group.position, this.head);
      const lead = to.length() / 95;
      const aim = v2.copy(target.group.position).addScaledVector(target.velocity, lead).sub(this.head).normalize();
      this.autopilotAim.lerp(aim, Math.min(1, dt * 7)).normalize();
    } else {
      this.autopilotAim.lerp(v2.set(Math.sin(-this.clock * 0.1), 0.1, -Math.cos(this.clock * 0.1)), dt * 0.5).normalize();
    }
    const yaw = Math.atan2(-this.autopilotAim.x, -this.autopilotAim.z);
    const pitch = Math.asin(Math.min(1, Math.max(-1, this.autopilotAim.y)));
    let dy = yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt * 9);
    this.pitch += (pitch - this.pitch) * Math.min(1, dt * 9);
    if (this.phase === 'playing' && this.novas > 0 && !this.nova && this.bots.filter((b) => !b.dead && b.group.position.distanceTo(this.head) < 16).length >= 6) this.fireNova();
  }

  private autopilotWantsFire(): boolean {
    const target = this.autopilotTarget;
    if (!target || target.dead) return false;
    const to = v1.subVectors(target.group.position, this.head);
    const d = to.length();
    return to.normalize().dot(this.headForward) > Math.cos(Math.max(0.03, Math.atan2(target.radius * 1.6, d)));
  }

  private threatened(): boolean {
    return this.bolts.some((bolt) => !bolt.friendly && bolt.position.distanceTo(this.head) < 6 && v1.subVectors(this.head, bolt.position).dot(bolt.velocity) > 0 && v2.subVectors(bolt.position, this.head).normalize().dot(this.headForward) > 0.6);
  }

  // ---- HUD ----------------------------------------------------------------------------------------------

  private hudState(): HudState {
    const blips: Blip[] = [];
    for (const bot of this.bots) {
      if (bot.dead) continue;
      blips.push({ position: bot.group.position, kind: bot.kind, urgent: bot.kind === 'lancer' && bot.state === 'charge' });
    }
    for (const pickup of this.pickups) blips.push({ position: pickup.group.position, kind: 'pickup', urgent: false });
    for (const bolt of this.bolts) {
      if (bolt.friendly || bolt.position.distanceTo(this.head) > 14) continue;
      blips.push({ position: bolt.position, kind: 'bolt', urgent: true });
    }
    const boss = this.bots.find((bot) => bot.kind === 'overseer' && !bot.dead);
    const xr = this.renderer.xr.isPresenting;
    return {
      phase: this.phase,
      score: this.score,
      best: this.best,
      multiplier: this.multiplier,
      wave: this.wave,
      sector: SECTORS[this.sector % SECTORS.length],
      hull: this.hull / 100,
      shield: this.energy / 100,
      novas: this.novas,
      overdrive: this.overdrive,
      boss: boss ? { hp: Math.max(0, boss.hp), max: boss.maxHp, shielded: boss.state === 'shielded' } : null,
      banner: this.banner,
      blips,
      origin: this.head,
      yaw: xr ? Math.atan2(-this.headForward.x, -this.headForward.z) : this.yaw,
      hitmarker: this.hitmarker,
      damage: this.damageFlash,
      kills: this.kills,
      newBest: this.newBest,
      locked: this.locked,
      touch: this.touch,
      autopilot: this.autopilot,
    };
  }

  /** For tests and capture: a snapshot of the run. */
  debug() {
    return {
      phase: this.phase,
      wave: this.wave,
      sector: this.sector,
      score: this.score,
      hull: this.hull,
      energy: this.energy,
      novas: this.novas,
      bots: this.bots.map((bot) => ({ kind: bot.kind, hp: bot.hp, d: +bot.group.position.distanceTo(this.head).toFixed(1) })),
      bolts: this.bolts.length,
      pickups: this.pickups.length,
      jumping: this.jump != null,
      locked: this.locked,
    };
  }

  /** Skip ahead to a wave (tests, capture). */
  skipTo(wave: number): void {
    if (this.phase !== 'playing') this.engage();
    for (const bot of this.bots) this.removeBot(bot);
    this.bots = [];
    this.bolts = [];
    this.between = null;
    this.sector = wave - 1;
    cosmos.tint.value.copy(hueMatrix((this.sector * 67) % 360));
    this.startWave(wave);
  }
}
