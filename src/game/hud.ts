import {
  type Camera,
  CanvasTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';

export type Phase = 'title' | 'playing' | 'paused' | 'over';

export interface Blip {
  position: Vector3;
  kind: 'drone' | 'gunner' | 'lancer' | 'overseer' | 'node' | 'pickup' | 'bolt';
  /** A lancer charging at you, or a bolt about to hit. */
  urgent: boolean;
}

export interface HudState {
  phase: Phase;
  score: number;
  best: number;
  multiplier: number;
  wave: number;
  sector: string;
  hull: number;
  shield: number;
  novas: number;
  overdrive: number;
  boss: { hp: number; max: number; shielded: boolean } | null;
  banner: { title: string; sub: string; age: number } | null;
  blips: Blip[];
  /** Player position and view yaw, for the radar. */
  origin: Vector3;
  yaw: number;
  hitmarker: number;
  damage: number;
  kills: number;
  newBest: boolean;
  /** 2D: whether the mouse is captured (else the title says "click to engage"). */
  locked: boolean;
  touch: boolean;
  autopilot: boolean;
}

const RADAR_RANGE = 60;
const BLIP_COLORS: Record<Blip['kind'], string> = {
  drone: '#ff2e52',
  gunner: '#ff8c1f',
  lancer: '#ff3df2',
  overseer: '#ff2e52',
  node: '#ffb347',
  pickup: '#6dffa0',
  bolt: '#ffd166',
};

export const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');

/** The radar: you at the centre, facing up. Shared by the 2D and VR HUDs. */
function drawRadar(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, state: HudState, time: number): void {
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = 'rgba(6, 14, 26, 0.62)';
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(90, 220, 255, 0.55)';
  g.stroke();
  g.clip();
  g.strokeStyle = 'rgba(90, 220, 255, 0.16)';
  g.lineWidth = 1;
  for (const k of [0.33, 0.66]) {
    g.beginPath();
    g.arc(cx, cy, r * k, 0, Math.PI * 2);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(cx - r, cy);
  g.lineTo(cx + r, cy);
  g.moveTo(cx, cy - r);
  g.lineTo(cx, cy + r);
  g.stroke();
  // Sweep.
  const sweep = (time * 2.2) % (Math.PI * 2);
  const gradient = g.createConicGradient(sweep - Math.PI / 2, cx, cy);
  gradient.addColorStop(0, 'rgba(90, 220, 255, 0.28)');
  gradient.addColorStop(0.12, 'rgba(90, 220, 255, 0)');
  gradient.addColorStop(1, 'rgba(90, 220, 255, 0)');
  g.fillStyle = gradient;
  g.fillRect(cx - r, cy - r, r * 2, r * 2);
  // View cone.
  g.beginPath();
  g.moveTo(cx, cy);
  g.arc(cx, cy, r, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
  g.closePath();
  g.fillStyle = 'rgba(90, 220, 255, 0.07)';
  g.fill();

  const cos = Math.cos(state.yaw);
  const sin = Math.sin(state.yaw);
  for (const blip of state.blips) {
    const dx = blip.position.x - state.origin.x;
    const dz = blip.position.z - state.origin.z;
    // Rotate into the view frame: forward (-z at yaw 0) is up.
    const x = dx * cos - dz * sin;
    const z = dx * sin + dz * cos;
    const d = Math.hypot(x, z);
    const k = Math.min(d, RADAR_RANGE) / RADAR_RANGE / Math.max(d, 0.001);
    const px = cx + x * k * r * 0.94;
    const py = cy + z * k * r * 0.94;
    const size = blip.kind === 'overseer' ? 7 : blip.kind === 'bolt' ? 2 : 4;
    g.fillStyle = BLIP_COLORS[blip.kind];
    g.globalAlpha = blip.urgent ? 0.6 + 0.4 * Math.sin(time * 20) : 1;
    g.beginPath();
    if (blip.kind === 'pickup') g.rect(px - 3, py - 3, 6, 6);
    else g.arc(px, py, size, 0, Math.PI * 2);
    g.fill();
    // Above or below you: a tick.
    const dy = blip.position.y - state.origin.y;
    if (Math.abs(dy) > 4 && blip.kind !== 'bolt') {
      g.fillRect(px - 0.5, dy > 0 ? py - size - 5 : py + size, 1.5, 5);
    }
  }
  g.globalAlpha = 1;
  g.fillStyle = '#9ff0ff';
  g.beginPath();
  g.moveTo(cx, cy - 7);
  g.lineTo(cx + 5, cy + 5);
  g.lineTo(cx - 5, cy + 5);
  g.closePath();
  g.fill();
  g.restore();
}

// ---- 2D -----------------------------------------------------------------------

export interface HudActions {
  engage: () => void;
  resume: () => void;
  restart: () => void;
  quit: () => void;
  nova: () => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
};

/** The flat-screen HUD, as DOM over the scene. */
export class ScreenHud {
  readonly root = el('div', 'rp');
  private readonly score = el('div', 'rp-score');
  private readonly mult = el('div', 'rp-mult');
  private readonly wave = el('div', 'rp-wave');
  private readonly best = el('div', 'rp-best');
  private readonly hull = el('i');
  private readonly shield = el('i');
  private readonly novas = el('div', 'rp-novas');
  private readonly overdrive = el('div', 'rp-overdrive');
  private readonly boss = el('div', 'rp-boss', '<span>OVERSEER</span><div class="rp-bar"><i></i></div>');
  private readonly banner = el('div', 'rp-banner', '<b></b><span></span>');
  private readonly cross = el('div', 'rp-cross');
  private readonly vignette = el('div', 'rp-vignette');
  private readonly radar = Object.assign(el('canvas', 'rp-radar'), { width: 200, height: 200 });
  private readonly arrows = el('canvas', 'rp-arrows');
  private readonly menu = el('div', 'rp-menu');
  private readonly novaButton = el('button', 'rp-nova-btn', 'NOVA');
  private menuKey = '';
  private readonly projected = new Vector3();

  constructor(private readonly actions: HudActions) {
    const bars = el('div', 'rp-bars');
    const bar = (name: string, fill: HTMLElement, cls: string) => {
      const row = el('div', `rp-row ${cls}`, `<span>${name}</span>`);
      const track = el('div', 'rp-bar');
      track.append(fill);
      row.append(track);
      return row;
    };
    bars.append(bar('HULL', this.hull, 'rp-hull'), bar('SHIELD', this.shield, 'rp-shield'), this.novas, this.overdrive);
    const top = el('div', 'rp-top');
    const left = el('div', 'rp-left');
    left.append(this.score, this.mult);
    top.append(left, this.wave, this.best);
    this.cross.innerHTML =
      '<svg viewBox="-20 -20 40 40"><circle r="2" /><path d="M-14 0h-6M14 0h6M0 -14v-6M0 14v6" /><path class="hm" d="M-9 -9l-5 -5M9 -9l5 -5M-9 9l-5 5M9 9l5 5" /></svg>';
    this.novaButton.onclick = () => actions.nova();
    this.root.append(this.vignette, this.arrows, top, this.boss, this.banner, this.cross, bars, this.radar, this.novaButton, this.menu);
    this.root.hidden = true;
    document.body.append(this.root);
  }

  set visible(visible: boolean) {
    this.root.hidden = !visible;
    this.menuKey = '';
  }

  update(state: HudState, camera: Camera, time: number): void {
    const playing = state.phase === 'playing';
    this.root.classList.toggle('rp-playing', playing);
    this.root.classList.toggle('rp-touch', state.touch);
    this.score.textContent = fmt(state.score);
    this.mult.textContent = state.multiplier > 1 ? `×${state.multiplier}` : '';
    this.wave.innerHTML = state.wave ? `<b>WAVE ${state.wave}</b><span>${state.sector}</span>` : '';
    this.best.textContent = `BEST ${fmt(Math.max(state.best, state.score))}`;
    this.hull.style.width = `${state.hull * 100}%`;
    this.hull.parentElement!.parentElement!.classList.toggle('rp-low', state.hull < 0.3);
    this.shield.style.width = `${state.shield * 100}%`;
    this.novas.innerHTML = `<span>NOVA</span>${'<i></i>'.repeat(state.novas)}${state.novas ? '' : '<em>—</em>'}`;
    this.overdrive.textContent = state.overdrive > 0.05 ? `OVERDRIVE ${state.overdrive.toFixed(1)}s` : '';
    this.boss.hidden = !state.boss;
    if (state.boss) {
      (this.boss.querySelector('i') as HTMLElement).style.width = `${(state.boss.hp / state.boss.max) * 100}%`;
      this.boss.classList.toggle('rp-shielded', state.boss.shielded);
      this.boss.querySelector('span')!.textContent = state.boss.shielded ? 'OVERSEER · DESTROY THE SHIELD NODES' : 'OVERSEER · CORE EXPOSED';
    }
    const banner = state.banner;
    this.banner.hidden = !banner;
    if (banner) {
      this.banner.querySelector('b')!.textContent = banner.title;
      this.banner.querySelector('span')!.textContent = banner.sub;
      const fade = Math.min(1, banner.age * 3, Math.max(0, (3 - banner.age) * 2));
      this.banner.style.opacity = String(fade);
      this.banner.style.letterSpacing = `${0.5 - fade * 0.2}em`;
    }
    this.cross.classList.toggle('rp-hit', time - state.hitmarker < 0.12);
    this.vignette.style.opacity = String(Math.min(1, state.damage));
    this.root.classList.toggle('rp-critical', state.hull < 0.3 && playing);

    const g = this.radar.getContext('2d')!;
    g.clearRect(0, 0, 200, 200);
    drawRadar(g, 100, 100, 96, state, time);
    this.drawArrows(state, camera, time);
    this.drawMenu(state);
  }

  /** Edge arrows pointing at threats that are off screen. */
  private drawArrows(state: HudState, camera: Camera, time: number): void {
    const canvas = this.arrows as HTMLCanvasElement;
    const w = innerWidth;
    const h = innerHeight;
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    if (state.phase !== 'playing') return;
    const margin = 46;
    for (const blip of state.blips) {
      if (blip.kind === 'bolt' || blip.kind === 'pickup') continue;
      const p = this.projected.copy(blip.position).applyMatrix4(camera.matrixWorldInverse);
      const behind = p.z > 0;
      p.applyMatrix4(camera.projectionMatrix);
      let x = p.x;
      let y = p.y;
      if (behind) {
        x = -x;
        y = -y;
      }
      if (!behind && Math.abs(x) < 1 && Math.abs(y) < 1) continue;
      // Push onto the screen's edge rectangle.
      if (behind && Math.abs(x) < 1 && Math.abs(y) < 1) {
        const k = 1 / Math.max(Math.abs(x), Math.abs(y), 0.001);
        x *= k;
        y *= k;
      }
      const k = 1 / Math.max(Math.abs(x), Math.abs(y));
      const sx = ((x * Math.min(k, 1) + 1) / 2) * w;
      const sy = ((1 - y * Math.min(k, 1)) / 2) * h;
      const cx = Math.min(w - margin, Math.max(margin, sx));
      const cy = Math.min(h - margin, Math.max(margin, sy));
      const angle = Math.atan2(cy - h / 2, cx - w / 2);
      g.save();
      g.translate(cx, cy);
      g.rotate(angle);
      g.globalAlpha = blip.urgent ? 0.55 + 0.45 * Math.sin(time * 18) : 0.8;
      g.fillStyle = BLIP_COLORS[blip.kind];
      const s = blip.kind === 'overseer' ? 1.6 : blip.urgent ? 1.35 : 1;
      g.beginPath();
      g.moveTo(14 * s, 0);
      g.lineTo(-8 * s, -10 * s);
      g.lineTo(-3 * s, 0);
      g.lineTo(-8 * s, 10 * s);
      g.closePath();
      g.shadowColor = BLIP_COLORS[blip.kind];
      g.shadowBlur = 12;
      g.fill();
      g.restore();
    }
  }

  private drawMenu(state: HudState): void {
    const key = `${state.phase}|${state.locked}|${state.touch}|${state.best}|${state.phase === 'over' ? state.score : ''}`;
    if (key === this.menuKey) return;
    this.menuKey = key;
    this.menu.hidden = state.phase === 'playing';
    this.menu.replaceChildren();
    const button = (label: string, run: () => void, primary = false) => {
      const b = el('button', primary ? 'rp-btn rp-primary' : 'rp-btn', label);
      b.onclick = (event) => {
        event.stopPropagation();
        run();
      };
      return b;
    };
    const controls = state.touch
      ? '<div class="rp-keys"><span><b>Drag</b> aim</span><span><b>Hold</b> fire</span><span><b>NOVA</b> clear the sky</span></div>'
      : '<div class="rp-keys"><span><b>Mouse</b> aim</span><span><b>Click</b> fire</span><span><b>Right-click</b> shield</span><span><b>WASD</b> move</span><span><b>Space</b> nova</span><span><b>Esc</b> pause</span></div>';
    const actions = el('div', 'rp-actions');
    if (state.phase === 'title') {
      this.menu.append(
        el('div', 'rp-kicker', 'SPATIAL DESKTOP PRESENTS'),
        el('h1', 'rp-logo', 'ROGUE<br><span>PROTOCOL</span>'),
        el('p', 'rp-tag', 'The bots have gone rogue. The universe is the arena.'),
      );
      actions.append(button('ENGAGE', this.actions.engage, true), button('Back to desktop', this.actions.quit));
      this.menu.append(actions, el('div', '', controls));
      if (state.best) this.menu.append(el('p', 'rp-small', `Best: ${fmt(state.best)}`));
    } else if (state.phase === 'paused') {
      this.menu.append(el('h2', 'rp-title', 'PAUSED'));
      actions.append(button('Resume', this.actions.resume, true), button('Restart', this.actions.restart), button('Back to desktop', this.actions.quit));
      this.menu.append(actions, el('div', '', controls));
    } else if (state.phase === 'over') {
      this.menu.append(
        el('h2', 'rp-title rp-red', 'HULL BREACHED'),
        el('div', 'rp-final', `<span>SCORE</span><b>${fmt(state.score)}</b>`),
        el('p', 'rp-small', `Wave ${state.wave} · ${state.sector} · ${state.kills} bots destroyed${state.newBest ? ' · <em>NEW BEST</em>' : ''}`),
      );
      actions.append(button('Fight again', this.actions.restart, true), button('Back to desktop', this.actions.quit));
      this.menu.append(actions);
    }
  }
}

// ---- VR ------------------------------------------------------------------------

const VW = 1024;
const VH = 600;

/** The HUD in VR: one canvas plane that floats below your gaze and follows lazily. */
export class XrHud {
  readonly mesh: Mesh;
  private readonly canvas = Object.assign(document.createElement('canvas'), { width: VW, height: VH });
  private readonly texture = new CanvasTexture(this.canvas);
  private readonly target = new Vector3();
  private readonly forward = new Vector3();
  private frame = 0;

  constructor() {
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;
    this.mesh = new Mesh(
      new PlaneGeometry(0.64, 0.375),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  place(head: Vector3, headForward: Vector3, dt: number, snap = false): void {
    this.forward.set(headForward.x, 0, headForward.z).normalize();
    this.target.copy(head).addScaledVector(this.forward, 0.95);
    this.target.y = head.y - 0.38;
    if (snap) this.mesh.position.copy(this.target);
    else this.mesh.position.lerp(this.target, 1 - Math.exp(-dt * 2.5));
    this.mesh.lookAt(head);
  }

  update(state: HudState, time: number): void {
    // 30 Hz is plenty for text and saves uploads.
    if (this.frame++ % 2) return;
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, VW, VH);
    const font = (size: number, weight = 700) => `${weight} ${size}px "JetBrains Mono", ui-monospace, monospace`;
    g.textBaseline = 'middle';

    if (state.phase !== 'playing') {
      g.fillStyle = 'rgba(4, 8, 18, 0.82)';
      g.beginPath();
      g.roundRect(40, 60, VW - 80, VH - 120, 36);
      g.fill();
      g.strokeStyle = 'rgba(90, 220, 255, 0.5)';
      g.lineWidth = 3;
      g.stroke();
      g.textAlign = 'center';
      const lines: Array<[string, number, string]> =
        state.phase === 'title'
          ? [['ROGUE PROTOCOL', 78, '#9ff0ff'], ['The bots have gone rogue.', 32, '#e6e0e9'], ['Pull a trigger to engage', 34, '#ffd166'], ['Trigger fire · Grip shield · A/X nova · Stick move', 24, '#cac4d0'], ['B/Y pause', 24, '#cac4d0']]
          : state.phase === 'paused'
            ? [['PAUSED', 80, '#9ff0ff'], ['Trigger: resume', 34, '#ffd166'], ['B/Y: back to desktop', 30, '#cac4d0']]
            : [['HULL BREACHED', 72, '#ff4d6d'], [`SCORE ${fmt(state.score)}`, 50, '#ffffff'], [`Wave ${state.wave} · ${state.kills} bots${state.newBest ? ' · NEW BEST' : ''}`, 28, '#cac4d0'], ['Trigger: fight again · B/Y: desktop', 28, '#ffd166']];
      let y = 150;
      for (const [text, size, color] of lines) {
        g.font = font(size, size > 40 ? 800 : 500);
        g.fillStyle = color;
        g.fillText(text, VW / 2, y);
        y += size * 1.45 + 10;
      }
      this.texture.needsUpdate = true;
      return;
    }

    // Score and wave.
    g.textAlign = 'left';
    g.font = font(56, 800);
    g.fillStyle = '#ffffff';
    g.fillText(fmt(state.score), 30, 50);
    if (state.multiplier > 1) {
      g.font = font(36);
      g.fillStyle = '#ffd166';
      g.fillText(`×${state.multiplier}`, 40 + g.measureText(fmt(state.score)).width * 1.55, 54);
    }
    g.font = font(28, 600);
    g.fillStyle = '#9ff0ff';
    g.fillText(`WAVE ${state.wave} · ${state.sector.toUpperCase()}`, 30, 108);

    // Bars.
    const bar = (label: string, y: number, value: number, color: string) => {
      g.font = font(24, 600);
      g.fillStyle = '#cac4d0';
      g.fillText(label, 30, y);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(170, y - 12, 420, 24);
      g.fillStyle = color;
      g.fillRect(170, y - 12, 420 * value, 24);
    };
    bar('HULL', 170, state.hull, state.hull < 0.3 ? '#ff4d6d' : '#6dffa0');
    bar('SHIELD', 214, state.shield, '#5ad8ff');
    g.font = font(24, 600);
    g.fillStyle = '#b89cff';
    g.fillText(`NOVA ${'◆ '.repeat(state.novas) || '—'}`, 30, 258);
    if (state.overdrive > 0) {
      g.fillStyle = '#ffd166';
      g.fillText(`OVERDRIVE ${state.overdrive.toFixed(1)}s`, 330, 258);
    }
    if (state.boss) {
      g.fillStyle = '#ff4d6d';
      g.fillText(state.boss.shielded ? 'OVERSEER · HIT THE NODES' : 'OVERSEER · CORE EXPOSED', 30, 310);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(30, 330, 560, 18);
      g.fillStyle = '#ff4d6d';
      g.fillRect(30, 330, (560 * state.boss.hp) / state.boss.max, 18);
    }
    if (state.banner) {
      const fade = Math.min(1, state.banner.age * 3, Math.max(0, (3 - state.banner.age) * 2));
      g.globalAlpha = fade;
      g.textAlign = 'center';
      g.font = font(54, 800);
      g.fillStyle = '#ffffff';
      g.fillText(state.banner.title, 330, 430);
      g.font = font(28, 500);
      g.fillStyle = '#9ff0ff';
      g.fillText(state.banner.sub, 330, 486);
      g.globalAlpha = 1;
    }
    drawRadar(g, 830, 300, 170, state, time);
    if (state.damage > 0.05) {
      g.fillStyle = `rgba(255, 40, 70, ${Math.min(0.5, state.damage * 0.5)})`;
      g.fillRect(0, 0, VW, 8);
      g.fillRect(0, VH - 8, VW, 8);
    }
    this.texture.needsUpdate = true;
  }
}
