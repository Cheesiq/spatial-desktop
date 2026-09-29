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

export interface LauncherTile {
  id: string;
  label: string;
  /** Material icon path data (24x24 viewBox). */
  icon: string;
  /** Shown with a filled indicator when true (e.g. music on). */
  active?: () => boolean;
  run: () => void;
}

export interface LauncherRow {
  title: string;
  tiles: LauncherTile[];
}

// Physical size (metres) and texture resolution (1000 px per metre).
const WIDTH_M = 1.2;
const HEIGHT_M = 0.46;
const PX_PER_M = 1000;
const W = Math.round(WIDTH_M * PX_PER_M);
const H = Math.round(HEIGHT_M * PX_PER_M);

const TILE_W = 118;
const TILE_H = 150;
const ICON_D = 72;

// Material 3 baseline dark.
const C = {
  surface: 'rgba(33, 31, 38, 0.94)',
  outline: '#49454f',
  onSurface: '#e6e0e9',
  onSurfaceVariant: '#cac4d0',
  tile: '#2b2930',
  hover: '#36343b',
  active: '#4a4458',
  onActive: '#e8def8',
  primary: '#d0bcff',
};

interface HitBox {
  tile: LauncherTile;
  x: number;
  y: number;
}

/**
 * A 3D launcher dock: rows of Material-style tiles drawn into one canvas
 * texture on one plane, so it costs a single draw call and only re-uploads
 * when something on it changes. Works with the mouse, the XR emulator and
 * controller rays through the same pointer events as the panels.
 */
export class Launcher {
  readonly mesh: Mesh;
  readonly entity: Entity;
  private readonly canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  private readonly g = this.canvas.getContext('2d')!;
  private readonly texture = new CanvasTexture(this.canvas);
  private boxes: HitBox[] = [];
  // Tiles are rebuilt on every redraw, so track them by id, not identity.
  private hovered: string | null = null;
  private pressed: { id: string; pointerId: number } | null = null;
  private message = '';
  private messageTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly icons = new Map<string, Path2D>();

  constructor(
    world: World,
    private readonly rows: () => LauncherRow[],
  ) {
    this.texture.colorSpace = SRGBColorSpace;
    if (!quality.mipmaps) {
      this.texture.generateMipmaps = false;
      this.texture.minFilter = LinearFilter;
    }
    this.mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }),
    );
    this.mesh.scale.set(WIDTH_M, HEIGHT_M, 1);
    this.entity = world.createTransformEntity(this.mesh);
    this.entity.addComponent(RayInteractable);
    this.attachPointer();
    this.redraw();
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  set visible(visible: boolean) {
    this.mesh.visible = visible;
    if (!visible) this.hovered = this.pressed = null;
  }

  /** Show a short message in the dock's header for a few seconds. */
  toast(text: string): void {
    this.message = text;
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.message = '';
      this.redraw();
    }, 4000);
    this.redraw();
  }

  /** Repaint after state the tiles reflect (music on, layout, ...) changes. */
  redraw(): void {
    const { g } = this;
    g.clearRect(0, 0, W, H);
    roundRect(g, 0, 0, W, H, 32);
    g.fillStyle = C.surface;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = C.outline;
    g.stroke();

    g.textBaseline = 'middle';
    g.font = '500 26px Roboto, "Noto Sans", system-ui, sans-serif';
    g.fillStyle = C.onSurface;
    g.textAlign = 'left';
    g.fillText('Launcher', 36, 38);
    if (this.message) {
      g.textAlign = 'right';
      g.fillStyle = C.primary;
      g.font = '400 22px Roboto, "Noto Sans", system-ui, sans-serif';
      g.fillText(this.message, W - 36, 38);
    }

    this.boxes = [];
    let y = 70;
    for (const row of this.rows()) {
      g.textAlign = 'left';
      g.fillStyle = C.onSurfaceVariant;
      g.font = '500 17px Roboto, "Noto Sans", system-ui, sans-serif';
      g.fillText(row.title.toUpperCase(), 36, y + 8);
      const rowWidth = row.tiles.length * TILE_W;
      let x = (W - rowWidth) / 2;
      for (const tile of row.tiles) {
        this.drawTile(tile, x, y + 20);
        this.boxes.push({ tile, x, y: y + 20 });
        x += TILE_W;
      }
      y += TILE_H + 36;
    }
    this.texture.needsUpdate = true;
  }

  private drawTile(tile: LauncherTile, x: number, y: number): void {
    const { g } = this;
    const active = tile.active?.() ?? false;
    const hovered = this.hovered === tile.id;
    const pressed = this.pressed?.id === tile.id;
    const cx = x + TILE_W / 2;
    const cy = y + 12 + ICON_D / 2;

    g.beginPath();
    g.arc(cx, cy, ICON_D / 2, 0, Math.PI * 2);
    g.fillStyle = active ? C.active : pressed ? C.hover : hovered ? C.hover : C.tile;
    g.fill();
    if (hovered || pressed) {
      g.lineWidth = 3;
      g.strokeStyle = C.primary;
      g.stroke();
    }

    let icon = this.icons.get(tile.icon);
    if (!icon) this.icons.set(tile.icon, (icon = new Path2D(tile.icon)));
    g.save();
    const scale = 36 / 24;
    g.translate(cx - 12 * scale, cy - 12 * scale);
    g.scale(scale, scale);
    g.fillStyle = active ? C.onActive : C.onSurface;
    g.fill(icon);
    g.restore();

    g.textAlign = 'center';
    g.fillStyle = active || hovered ? C.onSurface : C.onSurfaceVariant;
    g.font = '500 19px Roboto, "Noto Sans", system-ui, sans-serif';
    g.fillText(tile.label, cx, y + 12 + ICON_D + 28, TILE_W - 8);
  }

  private tileAt(u: number, v: number): LauncherTile | null {
    const px = u * W;
    const py = v * H;
    for (const box of this.boxes) {
      if (px >= box.x && px < box.x + TILE_W && py >= box.y && py < box.y + TILE_H) return box.tile;
    }
    return null;
  }

  private attachPointer(): void {
    const target = this.entity.object3D!;
    const hit = new Vector3();
    const soundAt = new Vector3();
    const tileFor = (event: Parameters<typeof pointerRay>[0]) => {
      const at = meshUv(this.mesh, pointerRay(event), hit);
      return at?.inside ? this.tileAt(at.u, at.v) : null;
    };
    const setHovered = (tile: LauncherTile | null) => {
      const id = tile?.id ?? null;
      if (id === this.hovered) return;
      this.hovered = id;
      if (id) sfx.play('hover', { at: this.mesh.getWorldPosition(soundAt) });
      this.redraw();
    };

    target.addEventListener('pointermove', (event) => this.visible && setHovered(tileFor(event)));
    target.addEventListener('pointerleave', () => setHovered(null));
    target.addEventListener('pointerdown', (event) => {
      if (!this.visible) return;
      event.stopPropagation();
      const tile = tileFor(event);
      if (!tile) return;
      this.pressed = { id: tile.id, pointerId: event.pointerId };
      sfx.play('press', { at: this.mesh.getWorldPosition(soundAt) });
      target.setPointerCapture(event.pointerId);
      this.redraw();
    });
    // Activate on release over the same tile, like a normal button. This runs
    // inside the browser's pointerup handler for the mouse, so actions that
    // need a user gesture (the screen-share picker) still work.
    target.addEventListener('pointerup', (event) => {
      const pressed = this.pressed;
      if (!pressed || pressed.pointerId !== event.pointerId) return;
      this.pressed = null;
      target.releasePointerCapture(event.pointerId);
      const tile = tileFor(event);
      if (tile?.id === pressed.id) tile.run();
      this.redraw();
    });
    target.addEventListener('pointercancel', () => {
      this.pressed = null;
      this.redraw();
    });
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/**
 * Keeps the dock where it's reachable: below the panels in 2D, and in VR
 * about 0.7 m in front of where you face when the session starts, just below
 * eye level, turned to face you.
 */
export class LauncherPlacementSystem extends createSystem({}) {
  launcher: Launcher | null = null;
  private placedForXr = false;
  private readonly head = new Vector3();
  private readonly forward = new Vector3();
  private readonly target = new Vector3();

  update(): void {
    const launcher = this.launcher;
    if (!launcher) return;
    const mesh = launcher.mesh;
    // In VR the head is the viewer; in 2D the head node isn't where the camera
    // is, so face the camera itself.
    if (this.renderer.xr.isPresenting) this.player.head.getWorldPosition(this.head);
    else this.camera.getWorldPosition(this.head);

    if (this.renderer.xr.isPresenting) {
      if (!this.placedForXr) {
        this.player.head.getWorldDirection(this.forward);
        // Object3D.getWorldDirection is +z; a camera looks down -z.
        this.forward.set(-this.forward.x, 0, -this.forward.z).normalize();
        mesh.position.copy(this.head).addScaledVector(this.forward, 0.7);
        mesh.position.y = this.head.y - 0.4;
        this.placedForXr = true;
      }
    } else {
      this.placedForXr = false;
      this.player.localToWorld(this.target.set(0, 1.12, -0.95));
      mesh.position.copy(this.target);
    }
    mesh.lookAt(this.head);
  }
}
