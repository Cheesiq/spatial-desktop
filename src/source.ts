import type { Texture, WebGLRenderer } from '@iwsdk/core';

/** Input a panel can forward to whatever it displays. */
export interface PanelInput {
  /** `u`/`v` in [0, 1] from the top-left; `buttons` is a DOM `MouseEvent.buttons` mask. */
  pointer(u: number, v: number, buttons: number): void;
  wheel(u: number, v: number, deltaX: number, deltaY: number): void;
  /** Route the physical keyboard to this source until released. */
  focusKeyboard(): void;
  releaseKeyboard(): void;
  hasKeyboard(): boolean;
  /** Send a key directly (the on-screen keyboard): an X11 keysym, its KeyboardEvent.code, pressed or released. */
  key?(keysym: number, code: string, down: boolean): void;
  /**
   * Hand the real mouse and keyboard over at (u, v) instead of forwarding
   * mouse clicks: the source takes the desktop cursor itself. `quad` is where
   * the panel's screen is in the page (CSS px: top-left, top-right,
   * bottom-right, bottom-left) so the cursor can come back beside it.
   */
  enter?(u: number, v: number, quad: ScreenQuad): void;
  /** Status line while this source has the keyboard, if not the default. */
  hint?(): string | null;
}

export type ScreenQuad = [[number, number], [number, number], [number, number], [number, number]];

/** Something a panel shows: a captured window, a VM display, ... */
export interface PanelSource {
  label: string;
  texture: Texture;
  /** Content size in pixels, or null until known. */
  size(): readonly [number, number] | null;
  /** Called once per frame, before rendering. */
  update?(renderer: WebGLRenderer): void;
  onEnded(callback: () => void): void;
  dispose(): void;
  /** Present when the panel's content can be controlled, not just viewed. */
  input?: PanelInput;
}
