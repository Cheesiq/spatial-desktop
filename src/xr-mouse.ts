// Provided by @iwsdk/core's own dependency tree.
import { forwardHtmlEvents } from '@pmndrs/pointer-events';
import { createSystem, type PerspectiveCamera } from '@iwsdk/core';

/**
 * In an emulated XR session, Meta's emulator (IWER) draws the headset view on
 * its own canvas over the app's, so IWSDK's canvas mouse forwarding never sees
 * a click. Forward the mouse from that canvas instead, raycasting through the
 * headset's view, so panels stay clickable and draggable.
 */
export class EmulatorMouseSystem extends createSystem({}) {
  private handler?: { update(): void; destroy(): void };

  init(): void {
    const xr = this.renderer.xr;
    const start = () => {
      const canvas = this.emulatorCanvas();
      if (!canvas) return;
      const camera = (): PerspectiveCamera => xr.getCamera().cameras[0] ?? this.camera;
      this.handler = forwardHtmlEvents(canvas, camera, this.scene, {
        batchEvents: false,
        // Hidden objects (a hidden launcher) must not swallow clicks.
        filter: (object) => {
          for (let o: typeof object | null = object; o; o = o.parent) if (!o.visible) return false;
          return true;
        },
      });
    };
    const end = () => {
      this.handler?.destroy();
      this.handler = undefined;
    };
    xr.addEventListener('sessionstart', start);
    xr.addEventListener('sessionend', end);
    this.cleanupFuncs.push(
      () => xr.removeEventListener('sessionstart', start),
      () => xr.removeEventListener('sessionend', end),
      end,
    );
  }

  update(): void {
    this.handler?.update();
  }

  /** The largest visible canvas that isn't the app's own renderer. */
  private emulatorCanvas(): HTMLCanvasElement | undefined {
    return [...document.querySelectorAll('canvas')]
      .filter((c) => c !== this.renderer.domElement && c.clientWidth > 0)
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }
}
