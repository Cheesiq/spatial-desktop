import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  CubeCamera,
  createSystem,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HalfFloatType,
  HemisphereLight,
  IcosahedronGeometry,
  LineSegments,
  Matrix3,
  Mesh,
  PlaneGeometry,
  Points,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
  type World,
} from '@iwsdk/core';
import { quality } from './quality.js';

/**
 * "Deep space neural interface": a procedural nebula sky, a distant glowing
 * neural core with an interface ring, a 3D network of neurons whose synapses
 * carry travelling signal pulses, drifting motes, and a holographic platform
 * underfoot. Everything is generated at startup and animated in shaders, in
 * a handful of draw calls; `quality.tier === 'low'` gets a smaller sky bake,
 * fewer octaves and fewer neurons.
 */

// Palette, in linear-ish shader values (the materials write colours directly).
const CYAN = new Color(0.25, 0.85, 1.0);
const VIOLET = new Color(0.55, 0.4, 1.0);
const MAGENTA = new Color(1.0, 0.35, 0.8);

/** Shared by every animated material, advanced by EnvironmentSystem. */
const time = { value: 0 };

/**
 * The distant universe (sky, core, network) as one group, and a colour matrix
 * over the nebula, so a game can "jump" to another sector by turning and
 * re-tinting it. Identity by default.
 */
export const cosmos = {
  universe: new Group(),
  tint: { value: new Matrix3() },
};

const NOISE = /* glsl */ `
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float sum = 0.0, amp = 0.5;
    for (int i = 0; i < OCTAVES; i++) {
      sum += amp * noise(p);
      p = p * 2.03 + 17.1;
      amp *= 0.5;
    }
    return sum;
  }
`;

/** Seeded PRNG so the network looks the same on every load. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The sky: a domain-warped nebula with a galactic band, baked once into a
 * cube map at startup (it's the costliest shader here and doesn't need to
 * move), plus live procedural stars that twinkle.
 */
function buildSky(renderer: WebGLRenderer, octaves: number, faceSize: number): Mesh {
  const direction = /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  const nebula = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    defines: { OCTAVES: octaves },
    vertexShader: direction,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${NOISE}
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(vec3(0.003, 0.004, 0.012), vec3(0.012, 0.01, 0.032), smoothstep(-0.4, 0.9, d.y));

        // A tilted galactic band, where stars and nebula gather.
        float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.9, -0.3))) * 3.0, 2.0));

        vec3 q = d * 2.1;
        float w = fbm(q + 1.4 * vec3(fbm(q * 1.6 + 3.0), fbm(q * 1.6 + 7.0), 0.0));
        float cloud = smoothstep(0.4, 0.72, w);
        vec3 neb = mix(vec3(0.07, 0.03, 0.18), vec3(0.05, 0.3, 0.55), smoothstep(0.5, 0.75, w));
        neb = mix(neb, vec3(0.5, 0.08, 0.38), smoothstep(0.45, 0.7, fbm(q * 2.7 + 11.0)) * 0.85);
        // Dark dust lanes cut through the glow.
        float lanes = smoothstep(0.52, 0.62, fbm(q * 4.0 + 5.0));
        col += neb * cloud * (0.3 + 1.2 * band) * (1.0 - 0.7 * lanes);
        col += vec3(0.05, 0.045, 0.1) * band * (0.4 + 0.6 * noise(d * 40.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  // Half float so the faint gradients don't band.
  const target = new WebGLCubeRenderTarget(faceSize, { type: HalfFloatType, generateMipmaps: false });
  const bakeScene = new Scene();
  bakeScene.add(new Mesh(new SphereGeometry(10, 64, 32), nebula));
  new CubeCamera(0.1, 100, target).update(renderer, bakeScene);
  nebula.dispose();

  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    defines: { OCTAVES: 1 },
    uniforms: { uTime: time, uNebula: { value: target.texture }, uTint: cosmos.tint },
    vertexShader: direction,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform samplerCube uNebula;
      uniform mat3 uTint;
      varying vec3 vDir;
      ${NOISE}

      // One star per lit cell of a 3D grid over the sphere of directions.
      vec3 stars(vec3 d, float scale, float threshold) {
        vec3 p = d * scale;
        vec3 i = floor(p), f = fract(p);
        float h = hash(i);
        if (h < threshold) return vec3(0.0);
        vec3 at = vec3(hash(i + 1.3), hash(i + 2.7), hash(i + 4.1)) * 0.6 + 0.2;
        float glow = smoothstep(0.2, 0.0, length(f - at));
        float twinkle = 0.75 + 0.25 * sin(uTime * (0.8 + h * 3.0) + h * 40.0);
        vec3 tint = mix(vec3(0.65, 0.8, 1.0), vec3(1.0, 0.82, 0.7), hash(i + 7.0));
        return tint * glow * twinkle * (0.4 + 2.6 * (h - threshold) / (1.0 - threshold));
      }

      void main() {
        vec3 d = normalize(vDir);
        float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.9, -0.3))) * 3.0, 2.0));
        vec3 col = uTint * textureCube(uNebula, d).rgb;
        col += stars(d, 95.0, 0.982 - 0.01 * band);
        col += stars(d.zxy, 210.0, 0.99 - 0.02 * band) * 0.6;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new Mesh(new SphereGeometry(90, 64, 32), material);
  sky.renderOrder = -2;
  sky.frustumCulled = false;
  return sky;
}

/** A huge glowing orb of living circuitry, far off and above the panels, ringed by an interface halo. */
function buildCore(octaves: number): Group {
  const core = new Group();
  core.position.set(-20, 15, -70);

  const surface = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    defines: { OCTAVES: octaves },
    uniforms: {
      uTime: time,
      uCyan: { value: CYAN },
      uMagenta: { value: MAGENTA },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vPos = position;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCyan, uMagenta;
      varying vec3 vPos;
      varying vec3 vNormal;
      varying vec3 vView;
      ${NOISE}
      void main() {
        vec3 p = normalize(vPos) * 3.2;
        float t = uTime * 0.04;
        // Ridged noise makes thin branching filaments, at two scales, with
        // bright waves of activity travelling across them.
        float ridge = 1.0 - abs(fbm(p + vec3(t, 0.0, -t)) * 2.0 - 1.0);
        float fine = 1.0 - abs(fbm(p * 2.3 - vec3(0.0, t, 0.0)) * 2.0 - 1.0);
        float veins = pow(ridge, 22.0) + 0.5 * pow(fine, 30.0);
        float flow = pow(0.5 + 0.5 * sin(dot(p, vec3(2.0, 3.0, 1.5)) * 1.5 - uTime * 1.1), 3.0);
        float facing = max(dot(normalize(vNormal), normalize(vView)), 0.0);
        float rim = pow(1.0 - facing, 3.0);
        vec3 tint = mix(uCyan, uMagenta, smoothstep(0.35, 0.75, noise(p * 0.9 + t)));
        vec3 col = vec3(0.015, 0.012, 0.05) * facing;
        col += tint * veins * (0.35 + 2.2 * flow);
        col += tint * pow(ridge, 5.0) * 0.06;
        col += mix(uCyan, vec3(0.6, 0.5, 1.0), 0.4) * rim * 1.1;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  core.add(new Mesh(new IcosahedronGeometry(8, 24), surface));

  // Soft atmosphere: the back of a larger sphere, bright at its edge.
  const halo = new ShaderMaterial({
    side: BackSide,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uColor: { value: VIOLET } },
    vertexShader: /* glsl */ `
      varying float vFacing;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vFacing = abs(dot(normalize(mat3(modelMatrix) * normal), normalize(cameraPosition - world.xyz)));
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vFacing;
      void main() {
        gl_FragColor = vec4(uColor * pow(vFacing, 2.2) * 0.4, 1.0);
      }`,
  });
  core.add(new Mesh(new SphereGeometry(14, 48, 24), halo));

  // Interface rings: dashed arcs sweeping in opposite directions.
  const ring = (inner: number, outer: number, dashes: number, speed: number, color: Color, tilt: number) => {
    const material = new ShaderMaterial({
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: time, uColor: { value: color } },
      vertexShader: /* glsl */ `
        varying vec2 vXY;
        void main() {
          vXY = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec2 vXY;
        void main() {
          float a = atan(vXY.y, vXY.x) / 6.2831853 + 0.5;
          float dash = step(0.35, fract(a * ${dashes.toFixed(1)} + uTime * ${speed.toFixed(3)}));
          float sweep = pow(fract(a - uTime * ${(speed * 0.2).toFixed(3)}), 6.0);
          float r = length(vXY);
          float edge = smoothstep(${inner.toFixed(2)}, ${((inner + outer) / 2).toFixed(2)}, r) * smoothstep(${outer.toFixed(2)}, ${((inner + outer) / 2).toFixed(2)}, r);
          gl_FragColor = vec4(uColor * edge * (0.25 * dash + 1.4 * sweep), 1.0);
        }`,
    });
    const mesh = new Mesh(new RingGeometry(inner, outer, 256, 1), material);
    mesh.rotation.set(Math.PI / 2 - tilt, 0.3, 0);
    return mesh;
  };
  core.add(ring(13, 13.5, 64, 0.02, CYAN, 0.35), ring(15.2, 15.35, 180, -0.012, MAGENTA, 0.42));
  core.add(ring(17, 17.08, 12, 0.006, VIOLET, 0.3));
  return core;
}

/**
 * Clusters of neurons scattered through the space around you, wired within
 * each cluster by short synapses and between clusters by long curved axons.
 * Each edge fires a pulse every so often; neurons flicker as they fire.
 */
function buildNetwork(lowEnd: boolean): Group {
  const rand = random(1337);
  const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
  const network = new Group();

  const clusters: Vector3[] = [];
  const neurons: Array<{ at: Vector3; cluster: number }> = [];
  const clusterCount = lowEnd ? 10 : 18;
  const perCluster = lowEnd ? 18 : 30;
  while (clusters.length < clusterCount) {
    const dir = new Vector3(gauss(), gauss() * 0.7 + 0.15, gauss()).normalize();
    // Keep the panels' side of the room (forward, near eye level) clearer.
    if (dir.z < -0.6 && Math.abs(dir.y) < 0.25) continue;
    clusters.push(dir.multiplyScalar(16 + rand() * 28));
  }
  clusters.forEach((centre, c) => {
    const spread = 2 + rand() * 3.5;
    for (let i = 0; i < perCluster; i++) {
      const at = centre.clone().add(new Vector3(gauss(), gauss(), gauss()).multiplyScalar(spread));
      if (at.length() > 9) neurons.push({ at, cluster: c });
    }
  });

  // Synapses: bezier curves as line segments; each vertex knows how far along
  // its edge it is (aT) and the edge's pulse phase, speed and colour.
  const positions: number[] = [];
  const along: number[] = [];
  const edgeData: number[] = [];
  const curve = (a: Vector3, b: Vector3, bend: number) => {
    const length = a.distanceTo(b);
    const control = a.clone().lerp(b, 0.5).add(new Vector3(gauss(), gauss(), gauss()).multiplyScalar(length * bend));
    const steps = Math.max(3, Math.min(24, Math.round(length / 1.2)));
    const phase = rand(), speed = 0.08 + rand() * 0.25, hue = rand();
    let prev = a;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const point = a.clone().multiplyScalar((1 - t) ** 2).addScaledVector(control, 2 * (1 - t) * t).addScaledVector(b, t * t);
      positions.push(prev.x, prev.y, prev.z, point.x, point.y, point.z);
      along.push((s - 1) / steps, t);
      edgeData.push(phase, speed, hue, phase, speed, hue);
      prev = point;
    }
  };
  for (const neuron of neurons) {
    const near = neurons
      .filter((other) => other !== neuron && other.cluster === neuron.cluster)
      .sort((p, q) => p.at.distanceToSquared(neuron.at) - q.at.distanceToSquared(neuron.at))
      .slice(0, 2 + Math.floor(rand() * 2));
    for (const other of near) if (neurons.indexOf(other) > neurons.indexOf(neuron) || rand() < 0.3) curve(neuron.at, other.at, 0.2);
  }
  clusters.forEach((centre, c) => {
    const nearest = clusters
      .map((other, i) => ({ i, d: other.distanceTo(centre) }))
      .filter(({ i }) => i > c)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2);
    for (const { i } of nearest) curve(centre, clusters[i], 0.18);
  });

  const lines = new BufferGeometry();
  lines.setAttribute('position', new Float32BufferAttribute(positions, 3));
  lines.setAttribute('aT', new Float32BufferAttribute(along, 1));
  lines.setAttribute('aEdge', new Float32BufferAttribute(edgeData, 3));
  const synapses = new LineSegments(
    lines,
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: time, uCyan: { value: CYAN }, uMagenta: { value: MAGENTA }, uViolet: { value: VIOLET } },
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute vec3 aEdge;
        varying float vT;
        varying vec3 vEdge;
        varying float vFade;
        void main() {
          vT = aT;
          vEdge = aEdge;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFade = smoothstep(90.0, 20.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCyan, uMagenta, uViolet;
        varying float vT;
        varying vec3 vEdge;
        varying float vFade;
        void main() {
          // The pulse head crosses the edge during the first half of each cycle.
          float head = fract(uTime * vEdge.y + vEdge.x) * 2.2 - 0.1;
          float x = head - vT;
          float pulse = x >= 0.0 ? exp(-x * 9.0) : exp(x * 60.0);
          vec3 col = vEdge.z < 0.6 ? mix(uViolet, uCyan, vEdge.z / 0.6) : mix(uCyan, uMagenta, (vEdge.z - 0.6) / 0.4);
          gl_FragColor = vec4(col * (0.06 + 1.3 * pulse) * vFade, 1.0);
        }`,
    }),
  );
  synapses.frustumCulled = false;
  network.add(synapses);

  // Neurons: soft glowing points that fire now and then.
  const points = new BufferGeometry();
  points.setAttribute('position', new Float32BufferAttribute(neurons.flatMap(({ at }) => [at.x, at.y, at.z]), 3));
  points.setAttribute('aSeed', new Float32BufferAttribute(neurons.map(() => rand()), 1));
  const somas = new Points(
    points,
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: time, uCyan: { value: CYAN }, uMagenta: { value: MAGENTA } },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        varying float vFire;
        varying float vSeed;
        void main() {
          vSeed = aSeed;
          vFire = pow(max(sin(uTime * (0.4 + aSeed) + aSeed * 60.0), 0.0), 24.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp((0.35 + 0.4 * aSeed + 0.5 * vFire) * 900.0 / -mv.z, 1.5, 48.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCyan, uMagenta;
        varying float vFire;
        varying float vSeed;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float glow = exp(-r * r * 5.0) + smoothstep(0.25, 0.0, r);
          vec3 col = mix(uCyan, uMagenta, step(0.7, vSeed));
          gl_FragColor = vec4(col * glow * (0.35 + 2.0 * vFire), 1.0);
        }`,
    }),
  );
  somas.frustumCulled = false;
  network.add(somas);
  return network;
}

/** Faint motes drifting upward close by, for parallax and depth. */
function buildMotes(count: number): Points {
  const rand = random(99);
  const positions: number[] = [];
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const radius = 1.8 + rand() * 10;
    positions.push(Math.cos(angle) * radius, rand() * 8 - 1, Math.sin(angle) * radius);
    seeds.push(rand());
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1));
  const motes = new Points(
    geometry,
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: time, uColor: { value: CYAN } },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          p.y = mod(p.y + uTime * (0.03 + 0.06 * aSeed) + 1.0, 8.0) - 1.0;
          p.x += sin(uTime * 0.2 + aSeed * 30.0) * 0.3;
          vAlpha = smoothstep(-1.0, 0.5, p.y) * smoothstep(7.0, 5.0, p.y) * (0.4 + 0.6 * aSeed);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(40.0 / -mv.z, 1.0, 6.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          gl_FragColor = vec4(uColor * exp(-r * r * 4.0) * vAlpha * 0.5, 1.0);
        }`,
    }),
  );
  motes.frustumCulled = false;
  return motes;
}

/** A holographic platform: a dark disc of rings, spokes and outward pulses that fades into space. */
function buildPlatform(): Mesh {
  const platform = new Mesh(
    new PlaneGeometry(64, 64),
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: time, uCyan: { value: CYAN }, uViolet: { value: VIOLET } },
      vertexShader: /* glsl */ `
        varying vec2 vXZ;
        void main() {
          vXZ = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCyan, uViolet;
        varying vec2 vXZ;
        float line(float value, float width) {
          float d = abs(fract(value - 0.5) - 0.5) / fwidth(value);
          return 1.0 - clamp(d / width, 0.0, 1.0);
        }
        void main() {
          float r = length(vXZ);
          float a = atan(vXZ.y, vXZ.x) / 6.2831853;
          float fade = smoothstep(30.0, 3.0, r);
          float rings = line(r, 1.0) * 0.5 + line(r / 4.0, 1.4);
          float spokes = line(a * 24.0, 1.0) * smoothstep(1.5, 4.0, r) * 0.6;
          float wave = exp(-pow(fract(r * 0.08 - uTime * 0.07) - 0.5, 2.0) * 300.0);
          // A radar sweep that lights up the grid lines it passes over.
          float sweep = pow(fract(a + uTime * 0.03), 14.0) * smoothstep(0.8, 3.0, r);
          float grid = rings + spokes;
          float halo = exp(-pow((r - 0.75) * 30.0, 2.0)) + 0.35 * exp(-pow((r - 0.9) * 60.0, 2.0));
          vec3 col = uCyan * grid * (0.2 + 0.9 * wave + 0.8 * sweep) + uViolet * halo * 0.6;
          // A dark body under the lines so the platform reads as solid near you.
          float body = 0.8 * smoothstep(14.0, 2.0, r);
          gl_FragColor = vec4(col * fade + vec3(0.006, 0.008, 0.02) * body, max(body, clamp(length(col) * fade, 0.0, 1.0)));
        }`,
    }),
  );
  platform.rotation.x = -Math.PI / 2;
  platform.renderOrder = -1;
  return platform;
}

export function buildEnvironment(world: World): void {
  const low = quality.tier === 'low';
  cosmos.universe.add(buildSky(world.renderer, low ? 4 : 6, low ? 512 : 1024), buildCore(low ? 3 : 4), buildNetwork(low));
  world.scene.add(cosmos.universe);
  world.scene.add(buildMotes(low ? 150 : 500));
  world.scene.add(buildPlatform());
  world.scene.add(new HemisphereLight(0xcdd6f4, 0x0b0c14, 1.2));
  world.registerSystem(EnvironmentSystem);
}

/** Drives the clock every environment shader animates by. */
export class EnvironmentSystem extends createSystem({}) {
  update(delta: number): void {
    // Wrapped so float precision in the shaders never degrades.
    time.value = (time.value + Math.min(delta, 0.1)) % 3600;
  }
}
