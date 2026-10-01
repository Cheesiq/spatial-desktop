import {
  CanvasTexture,
  createSystem,
  type Entity,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RayInteractable,
  SRGBColorSpace,
  Vector3,
  type World,
} from '@iwsdk/core';
import { meshUv, pointerRay } from './pointer.js';
import { quality } from './quality.js';
import { sfx } from './sfx.js';
import type { PanelInput } from './source.js';

/**
 * An on-screen keyboard for the VM panels, for VR and touch screens where
 * there's no physical keyboard. It shows while the Windows or macOS VM has
 * the keyboard and sends X11 keysyms straight down the VNC connection, so
 * every key works, Ctrl, Alt and the Windows key included.
 *
 * Shift, Ctrl and Alt are one-shot: tap one, then the key it goes with.
 * Tap Shift twice for caps lock. Win on its own opens Start.
 */

interface Key {
  code: string;
  label: string;
  /** Label and keysym on the shifted layer, for keys that change. */
  shift?: string;
  /** Keysym for keys that aren't plain characters. */
  sym?: number;
  /** Width in key units. */
  w?: number;
  mod?: 'shift' | 'ctrl' | 'alt';
  hide?: true;
}

const K = (code: string, label: string, shift?: string, w?: number): Key => ({ code, label, shift, w });
const S = (code: string, label: string, sym: number, w?: number): Key => ({ code, label, sym, w });
const letters = (row: string, codes = [...row].map((c) => `Key${c.toUpperCase()}`)) => [...row].map((c, i) => K(codes[i], c, c.toUpperCase()));

const ROWS: Key[][] = [
  [S('Escape', 'Esc', 0xff1b), ...[...'1234567890'].map((d, i) => K(`Digit${d}`, d, '!@#$%^&*()'[i])), K('Minus', '-', '_'), K('Equal', '=', '+'), S('Backspace', '⌫', 0xff08, 1.6)],
  [S('Tab', 'Tab', 0xff09, 1.4), ...letters('qwertyuiop'), K('BracketLeft', '[', '{'), K('BracketRight', ']', '}'), K('Backslash', '\\', '|', 1.2)],
  [{ code: 'ControlLeft', label: 'Ctrl', sym: 0xffe3, w: 1.7, mod: 'ctrl' }, ...letters('asdfghjkl'), K('Semicolon', ';', ':'), K('Quote', "'", '"'), S('Enter', 'Enter', 0xff0d, 1.9)],
  [{ code: 'ShiftLeft', label: 'Shift', sym: 0xffe1, w: 2.2, mod: 'shift' }, ...letters('zxcvbnm'), K('Comma', ',', '<'), K('Period', '.', '>'), K('Slash', '/', '?'), S('ArrowUp', '↑', 0xff52), S('Delete', 'Del', 0xffff, 1.4)],
  [S('MetaLeft', 'Win', 0xffeb, 1.4), { code: 'AltLeft', label: 'Alt', sym: 0xffe9, w: 1.4, mod: 'alt' }, K('Backquote', '`', '~'), S('Space', '', 0x20, 6.4), S('ArrowLeft', '←', 0xff51), S('ArrowDown', '↓', 0xff54), S('ArrowRight', '→', 0xff53), { code: '', label: 'Hide', w: 1.6, hide: true }],
];

const WIDTH_M = 1.1;
const HEIGHT_M = 0.4;
const PX_PER_M = 1000;
const W = Math.round(WIDTH_M * PX_PER_M);
const H = Math.round(HEIGHT_M * PX_PER_M);
const PAD = 22;
const HEADER = 48;
const GAP = 6;
const UNITS = 15.2;
const KEY_W = (W - PAD * 2 - GAP * (UNITS - 1)) / UNITS;
const KEY_H = (H - HEADER - PAD - GAP * (ROWS.length - 1)) / ROWS.length;

// Material 3 baseline dark, as the launcher dock.
const C = {
  surface: 'rgba(33, 31, 38, 0.95)',
  outline: '#49454f',
  key: '#2b2930',
  special: '#36343b',
  hover: '#4a4458',
  pressed: '#d0bcff',
  onPressed: '#381e72',
  latched: '#4f378b',
  text: '#e6e0e9',
  muted: '#cac4d0',
  primary: '#d0bcff',
};

interface Box {
  key: Key;
  x: number;
  y: number;
  w: number;
}

const STORE_KEY = 'spatial-desktop.keyboard';

export class VirtualKeyboard {
  readonly mesh: Mesh;
  readonly entity: Entity;
  /** The VM the keys go to, and its name for the header. */
  target: { input: PanelInput; label: string } | null = null;
  /** The Hide key. */
  onHide: () => void = () => {};
  private readonly canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  private readonly g = this.canvas.getContext('2d')!;
  private readonly texture = new CanvasTexture(this.canvas);
  private boxes: Box[] = [];
  private hovered: string | null = null;
  private readonly held = new Map<number, Key>();
  private mods = { shift: false, ctrl: false, alt: false };
  private caps = false;
  private lastShiftTap = 0;

  constructor(world: World) {
    this.texture.colorSpace = SRGBColorSpace;
    if (!quality.mipmaps) {
      this.texture.generateMipmaps = false;
      this.texture.minFilter = LinearFilter;
    }
    this.mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }));
    this.mesh.scale.set(WIDTH_M, HEIGHT_M, 1);
    this.mesh.visible = false;
    this.entity = world.createTransformEntity(this.mesh);
    this.attachPointer();
    this.redraw();
  }

  /** Pop up for VM panels automatically (the player can turn this off). */
  get auto(): boolean {
    try {
      return localStorage.getItem(STORE_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  set auto(on: boolean) {
    try {
      localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
    } catch {
      // Not remembered; fine.
    }
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  set visible(visible: boolean) {
    if (visible === this.mesh.visible) return;
    this.mesh.visible = visible;
    // Hidden, it mustn't catch rays.
    if (visible) this.entity.addComponent(RayInteractable);
    else this.entity.removeComponent(RayInteractable);
    if (!visible) {
      this.releaseAll();
      this.hovered = null;
    }
    this.redraw();
  }

  redraw(): void {
    const { g } = this;
    g.clearRect(0, 0, W, H);
    g.beginPath();
    g.roundRect(0, 0, W, H, 28);
    g.fillStyle = C.surface;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = C.outline;
    g.stroke();

    g.textBaseline = 'middle';
    g.font = '500 22px Roboto, "Noto Sans", system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillStyle = C.text;
    g.fillText(this.target ? `Keyboard → ${this.target.label}` : 'Keyboard', PAD + 6, HEADER / 2 + 2);
    const state = [this.caps ? 'CAPS' : this.mods.shift && 'Shift', this.mods.ctrl && 'Ctrl', this.mods.alt && 'Alt'].filter(Boolean).join(' + ');
    if (state) {
      g.textAlign = 'right';
      g.fillStyle = C.primary;
      g.fillText(`${state} +`, W - PAD - 6, HEADER / 2 + 2);
    }

    const shifted = this.mods.shift !== this.caps;
    this.boxes = [];
    let y = HEADER;
    for (const row of ROWS) {
      let x = PAD;
      for (const key of row) {
        const w = (key.w ?? 1) * KEY_W + ((key.w ?? 1) - 1) * GAP;
        this.drawKey(key, x, y, w, shifted);
        this.boxes.push({ key, x, y, w });
        x += w + GAP;
      }
      y += KEY_H + GAP;
    }
    this.texture.needsUpdate = true;
  }

  private drawKey(key: Key, x: number, y: number, w: number, shifted: boolean): void {
    const { g } = this;
    const id = this.id(key);
    const pressed = [...this.held.values()].some((k) => this.id(k) === id);
    const latched = (key.mod && this.mods[key.mod]) || (key.mod === 'shift' && this.caps);
    g.beginPath();
    g.roundRect(x, y, w, KEY_H, 10);
    g.fillStyle = pressed ? C.pressed : latched ? C.latched : this.hovered === id ? C.hover : key.sym || key.hide ? C.special : C.key;
    g.fill();
    if (this.hovered === id && !pressed) {
      g.lineWidth = 2;
      g.strokeStyle = C.primary;
      g.stroke();
    }
    const letter = key.shift && /^[a-z]$/.test(key.label);
    const label = letter ? (shifted ? key.shift! : key.label) : key.shift && shifted ? key.shift : key.label;
    g.textAlign = 'center';
    g.fillStyle = pressed ? C.onPressed : key.sym || key.hide ? C.muted : C.text;
    g.font = `${label.length > 1 ? 500 : 400} ${label.length > 1 ? 20 : 28}px Roboto, "Noto Sans", system-ui, sans-serif`;
    g.fillText(label, x + w / 2, y + KEY_H / 2 + 1);
    // The shifted character, small, on keys whose two layers differ.
    if (key.shift && !letter && !shifted) {
      g.font = '400 15px Roboto, "Noto Sans", system-ui, sans-serif';
      g.fillStyle = C.muted;
      g.fillText(key.shift, x + w - 13, y + 14);
    }
  }

  private id(key: Key): string {
    return key.code || key.label;
  }

  private keyAt(u: number, v: number): Key | null {
    const px = u * W;
    const py = v * H;
    for (const box of this.boxes) {
      if (px >= box.x && px < box.x + box.w && py >= box.y && py < box.y + KEY_H) return box.key;
    }
    return null;
  }

  // ---- sending -----------------------------------------------------------------

  private send(sym: number, code: string, down: boolean): void {
    this.target?.input.key?.(sym, code, down);
  }

  /** Key down: modifiers latch; everything else goes out with the latched modifiers held. */
  private press(key: Key): void {
    if (key.hide) return;
    if (key.mod) {
      if (key.mod === 'shift') {
        const now = performance.now();
        // A quick second tap locks caps.
        if (now - this.lastShiftTap < 400) {
          this.caps = !this.caps;
          this.mods.shift = false;
          this.lastShiftTap = 0;
        } else {
          this.mods.shift = !this.mods.shift;
          this.lastShiftTap = now;
        }
      } else {
        this.mods[key.mod] = !this.mods[key.mod];
      }
      return;
    }
    // Another key in between means the next Shift tap isn't a double-tap.
    this.lastShiftTap = 0;
    const shifted = this.mods.shift !== this.caps;
    const letter = key.shift && /^[a-z]$/.test(key.label);
    // Caps lock shifts letters only, like a real keyboard.
    const useShift = letter ? shifted : this.mods.shift && key.shift != null;
    const sym = key.sym ?? (useShift && key.shift ? key.shift : key.label).charCodeAt(0);
    if (this.mods.ctrl) this.send(0xffe3, 'ControlLeft', true);
    if (this.mods.alt) this.send(0xffe9, 'AltLeft', true);
    if (useShift || (this.mods.shift && key.sym)) this.send(0xffe1, 'ShiftLeft', true);
    this.send(sym, key.code, true);
  }

  private release(key: Key): void {
    if (key.hide) return this.onHide();
    if (key.mod) return;
    const shifted = this.mods.shift !== this.caps;
    const letter = key.shift && /^[a-z]$/.test(key.label);
    const useShift = letter ? shifted : this.mods.shift && key.shift != null;
    const sym = key.sym ?? (useShift && key.shift ? key.shift : key.label).charCodeAt(0);
    this.send(sym, key.code, false);
    if (useShift || (this.mods.shift && key.sym)) this.send(0xffe1, 'ShiftLeft', false);
    if (this.mods.alt) this.send(0xffe9, 'AltLeft', false);
    if (this.mods.ctrl) this.send(0xffe3, 'ControlLeft', false);
    // One-shot modifiers are used up by the key they went with.
    this.mods = { shift: false, ctrl: false, alt: false };
  }

  private releaseAll(): void {
    for (const key of this.held.values()) this.release(key);
    this.held.clear();
  }

  // ---- pointer -----------------------------------------------------------------

  private attachPointer(): void {
    const target = this.entity.object3D!;
    const hit = new Vector3();
    const soundAt = new Vector3();
    const keyFor = (event: Parameters<typeof pointerRay>[0]) => {
      const at = meshUv(this.mesh, pointerRay(event), hit);
      return at?.inside ? this.keyAt(at.u, at.v) : null;
    };

    target.addEventListener('pointermove', (event) => {
      if (!this.visible) return;
      const id = keyFor(event) ? this.id(keyFor(event)!) : null;
      if (id === this.hovered) return;
      this.hovered = id;
      this.redraw();
    });
    target.addEventListener('pointerleave', () => {
      this.hovered = null;
      this.redraw();
    });
    target.addEventListener('pointerdown', (event) => {
      if (!this.visible) return;
      event.stopPropagation();
      // A click in the scene releases the VM's keyboard first (index.ts); typing
      // here means the VM should keep it.
      this.target?.input.focusKeyboard();
      const key = keyFor(event);
      if (!key) return;
      this.held.set(event.pointerId, key);
      target.setPointerCapture(event.pointerId);
      sfx.play('tick', { value: 0.6, at: this.mesh.getWorldPosition(soundAt) });
      this.press(key);
      this.redraw();
    });
    const up = (event: { pointerId: number }) => {
      const key = this.held.get(event.pointerId);
      if (!key) return;
      this.held.delete(event.pointerId);
      this.release(key);
      this.redraw();
    };
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
}

/**
 * Shows the keyboard while a VM panel has the keyboard and places it: in 2D
 * where the launcher dock sits (the dock steps aside), in VR at waist height
 * in front of you, tilted up to face you.
 */
export class KeyboardPlacementSystem extends createSystem({}) {
  keyboard: VirtualKeyboard | null = null;
  /** Which VM panel has the keyboard right now, if any. */
  findTarget: () => { input: PanelInput; label: string } | null = () => null;
  /** Called when the keyboard shows or hides, so the dock can step aside. */
  onShown: (shown: boolean) => void = () => {};
  private placedForXr = false;
  private lostFor = 0;
  /** Put away with Hide: stays away until the VM loses the keyboard and is clicked again. */
  private dismissed: PanelInput | null = null;
  private wasShown = false;

  attach(keyboard: VirtualKeyboard): void {
    this.keyboard = keyboard;
    keyboard.onHide = () => (this.dismissed = keyboard.target?.input ?? null);
  }
  private readonly head = new Vector3();
  private readonly forward = new Vector3();
  private readonly target = new Vector3();

  update(delta: number): void {
    const keyboard = this.keyboard;
    if (!keyboard) return;
    const found = this.findTarget();
    if (found) {
      this.lostFor = 0;
      if (found.input !== keyboard.target?.input) {
        keyboard.target = found;
        this.dismissed = null;
        keyboard.redraw();
      }
    } else {
      // Clicking a key releases and retakes the VM's keyboard in one go; only
      // a lasting release (a click elsewhere) puts the keyboard away.
      this.lostFor += delta;
    }
    const show = keyboard.auto && keyboard.target != null && this.lostFor < 0.3 && this.dismissed !== keyboard.target.input;
    if (!found && this.lostFor >= 0.3) {
      keyboard.target = null;
      this.dismissed = null;
    }
    if (show !== this.wasShown) {
      keyboard.visible = show;
      this.wasShown = show;
      this.onShown(show);
      if (show) sfx.play('open', { at: keyboard.mesh.position });
    }
    if (!keyboard.visible) {
      this.placedForXr = false;
      return;
    }

    const mesh = keyboard.mesh;
    const xr = this.renderer.xr.isPresenting;
    if (xr) this.player.head.getWorldPosition(this.head);
    else this.camera.getWorldPosition(this.head);
    if (xr) {
      if (!this.placedForXr) {
        this.player.head.getWorldDirection(this.forward);
        this.forward.set(-this.forward.x, 0, -this.forward.z).normalize();
        mesh.position.copy(this.head).addScaledVector(this.forward, 0.55);
        mesh.position.y = this.head.y - 0.5;
        this.placedForXr = true;
      }
    } else {
      this.placedForXr = false;
      this.player.localToWorld(this.target.set(0, 1.2, -0.9));
      mesh.position.copy(this.target);
    }
    mesh.lookAt(this.head);
  }
}
