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
}

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
