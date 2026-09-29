import {
  type Camera,
  Color,
  createComponent,
  createSystem,
  DoubleSide,
  type Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  Plane,
  PlaneGeometry,
  RayInteractable,
  Vector3,
  type World,
} from '@iwsdk/core';
import { meshUv, pointerRay, type RayEvent } from './pointer.js';
import { sfx } from './sfx.js';
import type { PanelSource, ScreenQuad } from './source.js';

export const Panel = createComponent('Panel', {});

export type Layout = 'arc' | 'grid' | 'stack';
export const LAYOUTS: Layout[] = ['arc', 'grid', 'stack'];

const PANEL_WIDTH = 1.6;
const BORDER = 0.02;
/** Grab bar along the top edge; the handle for moving controllable panels. */
const BAR = 0.08;
const FRAME_IDLE = new Color('#262a3d');
const FRAME_HOVER = new Color('#89b4fa');
const FRAME_FOCUS = new Color('#f5c2e7');
const FRAME_KEYBOARD = new Color('#a6e3a1');
const soundAt = new Vector3();
const corner = new Vector3();
/** The scene's canvas, for turning projected points into page pixels. */
let canvas: HTMLCanvasElement | null = null;

interface PanelRecord {
  source: PanelSource;
  root: Group;
  screen: Mesh;
  frameMesh: Mesh;
  frame: MeshBasicMaterial;
  /** Content pixel size the meshes were last fitted to. */
  fitted: readonly [number, number] | null;
  /** True once the user has dragged it somewhere; layouts leave it alone. */
  placed: boolean;
  drag: DragState | null;
  /** Pointer currently driving the source's input (mouse held on the VM), if any. */
  inputPointer: number | null;
  /** Mouse pressed on a source that takes the real cursor on release (Hyprland). */
  enterPointer: number | null;
  /** Pointers (mouse, controller rays) currently over the panel. */
  hovering: Set<number>;
}

interface DragState {
  pointerId: number;
  startedAt: number;
  from: Vector3;
  /** Panel origin minus the grab point, so the panel doesn't jump. */
  offset: Vector3;
  /** Plane through the grab point, facing the pointer, that the panel slides on. */
  plane: Plane;
}

/** Shared panel state; Map order is layout slot order. */
export const desktop = {
  panels: new Map<Entity, PanelRecord>(),
  layout: 'arc' as Layout,
  focused: null as Entity | null,
  onChange: () => {},
};

export function setLayout(layout: Layout): void {
  desktop.layout = layout;
  desktop.focused = null;
  for (const record of desktop.panels.values()) record.placed = false;
  desktop.onChange();
}

export function addPanel(world: World, source: PanelSource): Entity {
  canvas = world.renderer.domElement;
  const root = new Group();
  const screen = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: source.texture, toneMapped: false }));
  const frame = new MeshBasicMaterial({ color: FRAME_IDLE, side: DoubleSide });
  const frameMesh = new Mesh(new PlaneGeometry(1, 1), frame);
  frameMesh.position.z = -0.004;
  root.add(frameMesh, screen);

  // Spawn in front of the viewer, then glide into its layout slot.
  root.position.set(0, 1.5, -1.2);

  const entity = world.createTransformEntity(root);
  entity.addComponent(Panel);
  entity.addComponent(RayInteractable);

  const record: PanelRecord = {
    source,
    root,
    screen,
    frameMesh,
    frame,
    fitted: null,
    placed: false,
    drag: null,
    inputPointer: null,
    enterPointer: null,
    hovering: new Set(),
  };
  fit(record);
  desktop.panels.set(entity, record);
  attachPointer(entity, record);

  source.onEnded(() => removePanel(entity));
  sfx.play('open', { at: root.position });
  desktop.onChange();
  return entity;
}

export function removePanel(entity: Entity): void {
  const record = desktop.panels.get(entity);
  if (!record) return;
  desktop.panels.delete(entity);
  sfx.play('close', { at: record.root.getWorldPosition(soundAt) });
  if (desktop.focused === entity) desktop.focused = null;
  record.source.input?.releaseKeyboard();
  record.source.dispose();
  entity.dispose();
  desktop.onChange();
}

/** Stop sending keys to whichever panel has the keyboard. */
export function releaseKeyboard(): void {
  let changed = false;
  for (const record of desktop.panels.values()) {
    if (record.source.input?.hasKeyboard()) {
      record.source.input.releaseKeyboard();
      changed = true;
    }
  }
  if (changed) {
    sfx.play('release');
    paintFrames();
    desktop.onChange();
  }
}

/** Repaint frames and the HUD after a source's input state changed on its own. */
export function refreshPanels(): void {
  paintFrames();
  desktop.onChange();
}

/** Status text for whichever panel has the keyboard, if it has its own. */
export function keyboardHint(): string | null {
  for (const record of desktop.panels.values()) if (record.source.input?.hasKeyboard()) return record.source.input.hint?.() ?? null;
  return null;
}

/** Where a panel's screen is in the page, in CSS px (TL, TR, BR, BL). */
export function panelQuad(entity: Entity, camera: Camera): ScreenQuad | null {
  const record = desktop.panels.get(entity);
  if (!record || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  record.screen.updateWorldMatrix(true, false);
  const project = (x: number, y: number): [number, number] => {
    corner.set(x, y, 0).applyMatrix4(record.screen.matrixWorld).project(camera);
    return [rect.left + ((corner.x + 1) / 2) * rect.width, rect.top + ((1 - corner.y) / 2) * rect.height];
  };
  return [project(-0.5, 0.5), project(0.5, 0.5), project(0.5, -0.5), project(-0.5, -0.5)];
}

export function keyboardOwner(): string | null {
  for (const record of desktop.panels.values()) if (record.source.input?.hasKeyboard()) return record.source.label;
  return null;
}

/** Size the screen to the content's aspect, with a border and a top grab bar. */
function fit(record: PanelRecord): void {
  const size = record.source.size();
  record.fitted = size;
  const height = PANEL_WIDTH * (size ? size[1] / size[0] : 9 / 16);
  record.screen.scale.set(PANEL_WIDTH, height, 1);
  record.frameMesh.scale.set(PANEL_WIDTH + 2 * BORDER, height + 2 * BORDER + BAR, 1);
  record.frameMesh.position.y = BAR / 2;
}

/**
 * Pointer handling for mouse and XR rays. On a controllable panel the screen
 * surface drives the source (VM) and the frame/bar drags the panel; on a
 * view-only panel the whole panel drags. IWSDK's DistanceGrabbable either
 * snaps the panel's centre to the cursor or only follows controller motion
 * (which a mouse never has), so panels do this themselves. A short press that
 * barely moves the panel toggles focus instead.
 */
function attachPointer(entity: Entity, record: PanelRecord): void {
  const target = entity.object3D!;
  const input = record.source.input;
  const hit = new Vector3();
  const normal = new Vector3();

  const onScreen = (event: { object: unknown }) => input != null && event.object === record.screen;

  target.addEventListener('pointerenter', (event) => {
    if (!record.hovering.size) sfx.play('hover', { at: event.point });
    record.hovering.add(event.pointerId);
    paintFrames();
  });
  target.addEventListener('pointerleave', (event) => {
    record.hovering.delete(event.pointerId);
    paintFrames();
  });

  target.addEventListener('pointerdown', (event) => {
    if (record.drag || record.inputPointer != null || record.enterPointer != null) return;
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);

    // The mouse on a source that can take the real cursor: hand it over on release.
    if (input?.enter && onScreen(event) && event.pointerType.startsWith('screen')) {
      record.enterPointer = event.pointerId;
      return;
    }

    if (input && onScreen(event)) {
      const at = meshUv(record.screen, pointerRay(event), hit);
      if (!at) return;
      record.inputPointer = event.pointerId;
      if (!input.hasKeyboard()) sfx.play('keyboard', { at: event.point });
      input.focusKeyboard();
      input.pointer(at.u, at.v, event.buttons);
      paintFrames();
      desktop.onChange();
      return;
    }

    releaseKeyboard();
    sfx.play('grab', { at: event.point });
    normal.copy(pointerRay(event).direction).negate();
    record.drag = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      from: record.root.position.clone(),
      offset: record.root.position.clone().sub(event.point),
      plane: new Plane().setFromNormalAndCoplanarPoint(normal, event.point),
    };
  });

  target.addEventListener('pointermove', (event) => {
    const drag = record.drag;
    if (drag) {
      if (drag.pointerId === event.pointerId && pointerRay(event).intersectPlane(drag.plane, hit)) {
        record.root.position.copy(hit).add(drag.offset);
      }
      return;
    }
    if (!input) return;
    const held = record.inputPointer === event.pointerId;
    // The guest draws its own cursor into the framebuffer, so just move it.
    if (!held && (record.inputPointer != null || !onScreen(event))) return;
    const at = meshUv(record.screen, pointerRay(event), hit);
    if (!at || (!held && !at.inside)) return;
    input.pointer(at.u, at.v, event.buttons);
  });

  target.addEventListener('wheel', (event) => {
    if (!input || !onScreen(event)) return;
    const at = meshUv(record.screen, pointerRay(event), hit);
    if (at) input.wheel(at.u, at.v, event.deltaX ?? 0, event.deltaY ?? 0);
  });

  type EndEvent = RayEvent & { pointerId: number };
  const end = (event: EndEvent, buttons: number, cancelled = false) => {
    if (record.enterPointer === event.pointerId) {
      record.enterPointer = null;
      target.releasePointerCapture(event.pointerId);
      const at = meshUv(record.screen, pointerRay(event), hit);
      const quad = panelQuad(entity, event.camera);
      if (at?.inside && quad && !cancelled) {
        sfx.play('keyboard', { at: record.root.getWorldPosition(soundAt) });
        input?.enter?.(at.u, at.v, quad);
      }
      return;
    }
    if (record.inputPointer === event.pointerId) {
      record.inputPointer = null;
      target.releasePointerCapture(event.pointerId);
      const at = meshUv(record.screen, pointerRay(event), hit);
      if (at) input?.pointer(at.u, at.v, buttons);
      return;
    }
    const drag = record.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    record.drag = null;
    target.releasePointerCapture(event.pointerId);
    const at = record.root.getWorldPosition(soundAt);
    if (record.root.position.distanceTo(drag.from) > 0.03) {
      record.placed = true;
      if (desktop.focused === entity) desktop.focused = null;
      sfx.play('drop', { at });
    } else if (performance.now() - drag.startedAt < 400) {
      desktop.focused = desktop.focused === entity ? null : entity;
      record.placed = false;
      sfx.play(desktop.focused === entity ? 'focus' : 'unfocus', { at });
    }
    paintFrames();
  };
  target.addEventListener('pointerup', (event) => end(event, event.buttons));
  // A cancelled pointer must not leave VM buttons stuck down.
  target.addEventListener('pointercancel', (event) => end(event, 0, true));
}

function paintFrames(): void {
  for (const [entity, record] of desktop.panels) {
    const color = record.source.input?.hasKeyboard()
      ? FRAME_KEYBOARD
      : desktop.focused === entity
        ? FRAME_FOCUS
        : record.hovering.size
          ? FRAME_HOVER
          : FRAME_IDLE;
    record.frame.color.copy(color);
  }
}

/** Slot position in player-local space for panel `i` of `n`. */
function slotPosition(layout: Layout, i: number, n: number, out: Vector3): Vector3 {
  switch (layout) {
    case 'arc': {
      const radius = 2.2;
      const angle = (i - (n - 1) / 2) * 0.62;
      return out.set(Math.sin(angle) * radius, 1.5, -Math.cos(angle) * radius);
    }
    case 'grid': {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const col = i % cols;
      const row = Math.floor(i / cols);
      return out.set((col - (cols - 1) / 2) * 1.8, 1.5 + ((rows - 1) / 2 - row) * 1.1, -2.6);
    }
    case 'stack':
      return out.set(i * 0.18, 1.5 + i * 0.08, -1.8 - i * 0.5);
  }
}

export class PanelSystem extends createSystem({
  panels: { required: [Panel] },
}) {
  private target = new Vector3();
  private head = new Vector3();
  private focusSpot = new Vector3(0, 1.55, -1.1);

  update(delta: number): void {
    const n = desktop.panels.size;
    if (n === 0) return;
    const ease = 1 - Math.exp(-8 * delta);
    this.player.head.getWorldPosition(this.head);

    let slot = 0;
    for (const [entity, record] of desktop.panels) {
      const i = slot++;
      const obj = record.root;

      record.source.update?.(this.renderer);
      const size = record.source.size();
      if (size?.[0] !== record.fitted?.[0] || size?.[1] !== record.fitted?.[1]) fit(record);

      if (!record.drag && !record.placed) {
        if (desktop.focused === entity) this.target.copy(this.focusSpot);
        else slotPosition(desktop.layout, i, n, this.target);
        this.player.localToWorld(this.target);
        obj.position.lerp(this.target, ease);
      }

      // Always turn to face the viewer, upright.
      obj.lookAt(this.head.x, obj.position.y, this.head.z);
    }
  }
}

export function panelLabels(): Array<[Entity, string]> {
  return [...desktop.panels].map(([entity, record]) => [entity, record.source.label]);
}
