import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Points,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type WebGLRenderer,
} from '@iwsdk/core';

/**
 * Rogue Protocol's effects: pooled particles, instanced bolts, shockwave
 * rings, flashes, beams and warp streaks. Everything is additive light, so
 * it glows against the nebula without a bloom pass, and every pool is sized
 * up front so a big fight never allocates.
 */

let glow: CanvasTexture | null = null;
/** A soft radial dot, for sprites (halos, flashes, pickups). */
export function glowTexture(): CanvasTexture {
  if (glow) return glow;
  const canvas = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const g = canvas.getContext('2d')!;
  const gradient = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 128, 128);
  return (glow = new CanvasTexture(canvas));
}

export function glowSprite(color: Color | string, scale: number, opacity = 1): Sprite {
  const sprite = new Sprite(
    new SpriteMaterial({
      map: glowTexture(),
      color: new Color(color),
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity,
      toneMapped: false,
    }),
  );
  sprite.scale.setScalar(scale);
  return sprite;
}

// ---- particles ----------------------------------------------------------------

const MAX_PARTICLES = 3000;

/** CPU-simulated additive points: sparks, fire, debris glints. */
export class Particles {
  readonly points: Points;
  private readonly position = new Float32Array(MAX_PARTICLES * 3);
  private readonly color = new Float32Array(MAX_PARTICLES * 3);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly alpha = new Float32Array(MAX_PARTICLES);
  private readonly velocity = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly baseSize = new Float32Array(MAX_PARTICLES);
  private readonly drag = new Float32Array(MAX_PARTICLES);
  private next = 0;
  private readonly material: ShaderMaterial;

  constructor() {
    const geometry = new BufferGeometry();
    const attr = (array: Float32Array, size: number) => new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', attr(this.position, 3));
    geometry.setAttribute('color', attr(this.color, 3));
    geometry.setAttribute('size', attr(this.size, 1));
    geometry.setAttribute('alpha', attr(this.alpha, 1));
    this.material = new ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader: /* glsl */ `
        attribute vec3 color;
        attribute float size;
        attribute float alpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = alpha > 0.0 ? size * uScale * projectionMatrix[1][1] / max(-mv.z, 0.05) : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          a *= a;
          gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  /** Point sizes are in metres; this turns them into pixels for the current view. */
  setViewport(renderer: WebGLRenderer): void {
    this.material.uniforms.uScale.value = renderer.getContext().drawingBufferHeight * 0.5;
  }

  emit(at: Vector3, velocity: Vector3, color: Color, size: number, life: number, drag = 1.5): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    this.position.set([at.x, at.y, at.z], i * 3);
    this.velocity.set([velocity.x, velocity.y, velocity.z], i * 3);
    this.color.set([color.r, color.g, color.b], i * 3);
    this.baseSize[i] = size;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = drag;
    this.alpha[i] = 1;
  }

  /** A spherical burst: `count` sparks at `speed` m/s, jittered. */
  burst(at: Vector3, color: Color, count: number, speed: number, size: number, life: number): void {
    const v = new Vector3();
    for (let n = 0; n < count; n++) {
      v.randomDirection().multiplyScalar(speed * (0.25 + Math.random() * 0.9));
      this.emit(at, v, color, size * (0.5 + Math.random()), life * (0.5 + Math.random() * 0.8));
    }
  }

  update(dt: number): void {
    const { position: p, velocity: v, life, maxLife, alpha, size, baseSize, drag } = this;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (life[i] <= 0) {
        alpha[i] = 0;
        continue;
      }
      life[i] -= dt;
      const k = Math.max(0, 1 - drag[i] * dt);
      v[i * 3] *= k;
      v[i * 3 + 1] *= k;
      v[i * 3 + 2] *= k;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      const t = Math.max(0, life[i] / maxLife[i]);
      alpha[i] = t * t;
      size[i] = baseSize[i] * (0.4 + 0.6 * t);
    }
    const geometry = this.points.geometry;
    for (const name of ['position', 'alpha', 'size', 'color']) geometry.getAttribute(name).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
  }
}

// ---- bolts ----------------------------------------------------------------------

export interface Bolt {
  position: Vector3;
  previous: Vector3;
  velocity: Vector3;
  life: number;
  friendly: boolean;
  damage: number;
  /** Metres travelled; bolts grow to full size over their first few metres. */
  travelled: number;
}

const MAX_BOLTS = 160;
const up = new Vector3(0, 1, 0);

/** Glowing capsules drawn as two instanced layers: a hot core and a coloured halo. */
export class BoltRenderer {
  readonly group = new Group();
  private readonly layers: Array<{ mesh: InstancedMesh; width: number; length: number }> = [];
  private readonly matrix = new Matrix4();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly dir = new Vector3();

  constructor(color: Color, length: number) {
    const geometry = new CylinderGeometry(1, 1, 1, 8, 1, false);
    const layer = (tint: Color, opacity: number, width: number, stretch: number) => {
      const mesh = new InstancedMesh(
        geometry,
        new MeshBasicMaterial({ color: tint, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
        MAX_BOLTS,
      );
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
      this.layers.push({ mesh, width, length: length * stretch });
    };
    layer(color.clone().lerp(new Color(1, 1, 1), 0.75), 1, 0.03, 1);
    layer(color, 0.5, 0.09, 1.2);
    layer(color, 0.1, 0.16, 1.45);
  }

  update(bolts: readonly Bolt[], filter: (bolt: Bolt) => boolean, viewer: Vector3): void {
    let count = 0;
    for (const bolt of bolts) {
      if (!filter(bolt) || count >= MAX_BOLTS) continue;
      // Right at your eye a bolt is just a smear across the view; skip it.
      const near = bolt.position.distanceTo(viewer);
      if (near < 0.9) continue;
      const grow = Math.min(1, 0.15 + bolt.travelled / 6, (near - 0.9) / 4);
      this.dir.copy(bolt.velocity).normalize();
      this.rotation.setFromUnitVectors(up, this.dir);
      for (const layer of this.layers) {
        this.scale.set(layer.width * grow, layer.length * grow, layer.width * grow);
        this.matrix.compose(bolt.position, this.rotation, this.scale);
        layer.mesh.setMatrixAt(count, this.matrix);
      }
      count++;
    }
    for (const layer of this.layers) {
      layer.mesh.count = count;
      layer.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

// ---- rings, flashes, beams -------------------------------------------------------

interface Transient {
  object: Mesh | Sprite;
  age: number;
  life: number;
  from: number;
  to: number;
  opacity: number;
  billboard?: boolean;
}

/** Short-lived expanding rings and flashes, pooled by kind. */
export class Transients {
  readonly group = new Group();
  private readonly active: Transient[] = [];
  private readonly ringGeometry = new RingGeometry(0.9, 1, 64, 1);
  private readonly sphereGeometry = new SphereGeometry(1, 32, 16);
  private readonly pool = { ring: [] as Mesh[], flash: [] as Sprite[], sphere: [] as Mesh[] };

  /** A flat ring that grows from `from` to `to` metres; faces `normal`, or the viewer if omitted. */
  ring(at: Vector3, color: Color, from: number, to: number, life: number, normal?: Vector3, opacity = 0.65): void {
    const mesh =
      this.pool.ring.pop() ??
      new Mesh(
        this.ringGeometry,
        new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false }),
      );
    (mesh.material as MeshBasicMaterial).color.copy(color);
    mesh.position.copy(at);
    if (normal) mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
    mesh.userData.kind = 'ring';
    this.start({ object: mesh, age: 0, life, from, to, opacity, billboard: !normal });
  }

  flash(at: Vector3, color: Color, from: number, to: number, life: number, opacity = 1): void {
    const sprite = this.pool.flash.pop() ?? glowSprite(color, 1);
    sprite.material.color.copy(color);
    sprite.position.copy(at);
    sprite.userData.kind = 'flash';
    this.start({ object: sprite, age: 0, life, from, to, opacity });
  }

  /** A translucent expanding shell (the nova). */
  sphere(at: Vector3, color: Color, from: number, to: number, life: number, opacity = 0.35): void {
    const mesh =
      this.pool.sphere.pop() ??
      new Mesh(
        this.sphereGeometry,
        new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false }),
      );
    (mesh.material as MeshBasicMaterial).color.copy(color);
    mesh.position.copy(at);
    mesh.userData.kind = 'sphere';
    this.start({ object: mesh, age: 0, life, from, to, opacity });
  }

  private start(item: Transient): void {
    this.group.add(item.object);
    this.active.push(item);
    this.apply(item, 0);
  }

  private apply(item: Transient, t: number): void {
    const eased = 1 - (1 - t) ** 3;
    item.object.scale.setScalar(item.from + (item.to - item.from) * eased);
    (item.object.material as MeshBasicMaterial).opacity = item.opacity * (1 - t) ** 1.5;
  }

  update(dt: number, viewer: Vector3): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const item = this.active[i];
      item.age += dt;
      const t = Math.min(1, item.age / item.life);
      this.apply(item, t);
      if (item.billboard) item.object.lookAt(viewer);
      if (t >= 1) {
        this.active.splice(i, 1);
        this.group.remove(item.object);
        const kind = item.object.userData.kind as keyof typeof this.pool;
        (this.pool[kind] as Array<Mesh | Sprite>).push(item.object);
      }
    }
  }

  clear(): void {
    for (const item of this.active) item.age = item.life;
    this.update(0, new Vector3());
  }
}

/** A straight beam between two points: a lancer's aim line or its shot. */
export class Beam {
  readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly dir = new Vector3();

  constructor(color: Color) {
    const geometry = new CylinderGeometry(1, 1, 1, 8, 1, true);
    geometry.translate(0, 0.5, 0);
    this.material = new MeshBasicMaterial({ color, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  set(from: Vector3, to: Vector3, width: number, opacity: number): void {
    this.dir.subVectors(to, from);
    const length = this.dir.length();
    this.mesh.position.copy(from);
    this.mesh.quaternion.setFromUnitVectors(up, this.dir.normalize());
    this.mesh.scale.set(width, length, width);
    this.material.opacity = opacity;
    this.mesh.visible = opacity > 0.001;
  }
}

// ---- warp streaks ----------------------------------------------------------------

const STREAKS = 500;

/** Star streaks rushing past during a jump between sectors. */
export class Warp {
  readonly lines: LineSegments;
  private readonly material: ShaderMaterial;
  private readonly seeds: Float32Array;

  constructor() {
    const positions = new Float32Array(STREAKS * 6);
    this.seeds = new Float32Array(STREAKS * 2);
    const end = new Float32Array(STREAKS * 2);
    for (let i = 0; i < STREAKS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 2 + Math.random() * 30;
      const z = Math.random();
      for (const k of [0, 1]) {
        positions.set([Math.cos(angle) * radius, Math.sin(angle) * radius, z], (i * 2 + k) * 3);
        end[i * 2 + k] = k;
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('end', new BufferAttribute(end, 1));
    this.material = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0 }, uColor: { value: new Color(0.6, 0.85, 1) } },
      vertexShader: /* glsl */ `
        attribute float end;
        uniform float uTime;
        uniform float uStrength;
        varying float vFade;
        void main() {
          // Each streak loops along the local z axis, stretched by the warp's strength.
          float phase = fract(position.z + uTime * 0.9);
          float z = -80.0 + phase * 110.0;
          z += end * (2.0 + 26.0 * uStrength);
          vFade = (1.0 - end) * uStrength * smoothstep(0.0, 0.2, phase) * smoothstep(1.0, 0.7, phase);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, z, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vFade;
        void main() { gl_FragColor = vec4(uColor * vFade, 1.0); }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.lines = new LineSegments(geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  /** 0 hides it; 1 is full hyperspace. The group should face the direction of travel along -z. */
  update(dt: number, strength: number): void {
    this.material.uniforms.uTime.value += dt * (0.4 + strength * 2.2);
    this.material.uniforms.uStrength.value = strength;
    this.lines.visible = strength > 0.01;
  }
}

export const COLORS = {
  player: new Color(0.3, 0.9, 1.0),
  enemy: new Color(1.0, 0.18, 0.32),
  enemyHot: new Color(1.0, 0.55, 0.12),
  lancer: new Color(1.0, 0.24, 0.95),
  white: new Color(1, 1, 1),
  repair: new Color(0.3, 1.0, 0.5),
  overdrive: new Color(1.0, 0.85, 0.2),
  nova: new Color(0.62, 0.45, 1.0),
};
