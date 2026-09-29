import RFB from '@novnc/novnc';
import { DirtyCanvasTexture } from './dirty-texture.js';
import { quality } from './quality.js';
import type { PanelSource } from './source.js';

/**
 * noVNC's pointer entry points. They're internal, so @novnc/novnc is pinned to
 * an exact version and checked at connect time. The public alternative,
 * synthetic DOM mouse events, makes noVNC cover the whole page with a capture
 * overlay and hijack the real mouse.
 */
interface RfbPointerInternals {
  _canvas: HTMLCanvasElement;
  /** Display; every change to the visible canvas is one drawImage on this context. */
  _display: { _targetCtx: CanvasRenderingContext2D };
  _handleMouseButton(x: number, y: number, mask: number): void;
  _handleMouseMove(x: number, y: number): void;
}

/** VNC button bits (RFB spec): left, middle, right, then wheel up/down/left/right. */
const VNC_LEFT = 1, VNC_MIDDLE = 2, VNC_RIGHT = 4;
const VNC_WHEEL = { up: 1 << 3, down: 1 << 4, left: 1 << 5, right: 1 << 6 };
/** Pixels of wheel travel per VNC wheel step, matching noVNC's own client. */
const WHEEL_STEP = 50;

/** DOM `buttons` (1 left, 2 right, 4 middle) to a VNC button mask. */
function vncButtons(buttons: number): number {
  return (buttons & 1 ? VNC_LEFT : 0) | (buttons & 4 ? VNC_MIDDLE : 0) | (buttons & 2 ? VNC_RIGHT : 0);
}

/**
 * Connect to Omarchy's Windows VM display through the dev server's /vm-vnc
 * proxy (see vite.config.ts), which adds the VM's credentials server-side.
 */
export function connectVm(): Promise<PanelSource> {
  return new Promise((resolve, reject) => {
    // noVNC needs its canvas in the DOM; keep it there but invisible and inert.
    const holder = document.createElement('div');
    Object.assign(holder.style, {
      position: 'fixed', left: '0', top: '0', width: '1px', height: '1px',
      overflow: 'hidden', opacity: '0', pointerEvents: 'none',
    });
    document.body.append(holder);

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const rfb = new RFB(holder, `${protocol}://${location.host}/vm-vnc`, { shared: true });
    // 1:1 framebuffer so canvas pixels are VM pixels; never resize the guest.
    rfb.scaleViewport = false;
    rfb.clipViewport = false;
    rfb.resizeSession = false;
    rfb.focusOnClick = false;

    const internals = rfb as unknown as RfbPointerInternals;
    if (
      !(internals._canvas instanceof HTMLCanvasElement) ||
      typeof internals._handleMouseButton !== 'function' ||
      typeof internals._handleMouseMove !== 'function' ||
      !(internals._display?._targetCtx instanceof CanvasRenderingContext2D)
    ) {
      rfb.disconnect();
      holder.remove();
      reject(new Error('Unsupported @novnc/novnc version: pointer internals changed'));
      return;
    }
    const canvas = internals._canvas;

    // Upload only the regions noVNC redraws instead of the whole framebuffer
    // every frame: idle desktops cost nothing, a moving cursor a few KB.
    const upload = new DirtyCanvasTexture(canvas, { mipmaps: quality.mipmaps });
    const target = internals._display._targetCtx;
    const drawImage = target.drawImage.bind(target) as (...args: unknown[]) => void;
    target.drawImage = ((...args: unknown[]) => {
      drawImage(...args);
      // 9-argument form: (image, sx, sy, sw, sh, dx, dy, dw, dh).
      if (args.length === 9) upload.markDirty(args[5] as number, args[6] as number, args[7] as number, args[8] as number);
      else upload.markDirty(0, 0, canvas.width, canvas.height);
    }) as CanvasRenderingContext2D['drawImage'];

    let connected = false;
    let mask = 0;
    let wheelX = 0;
    let wheelY = 0;
    const ended: Array<() => void> = [];

    const toPixels = (u: number, v: number): [number, number] => [
      Math.min(canvas.width - 1, Math.max(0, Math.floor(u * canvas.width))),
      Math.min(canvas.height - 1, Math.max(0, Math.floor(v * canvas.height))),
    ];
    const click = (x: number, y: number, bit: number) => {
      internals._handleMouseButton(x, y, mask | bit);
      internals._handleMouseButton(x, y, mask);
    };

    const source: PanelSource = {
      label: 'Windows VM',
      texture: upload.texture,
      size: () => (canvas.width > 1 && canvas.height > 1 ? [canvas.width, canvas.height] : null),
      update: (renderer) => upload.flush(renderer),
      onEnded: (callback) => ended.push(callback),
      dispose: () => {
        rfb.disconnect();
        holder.remove();
        upload.dispose();
      },
      input: {
        pointer(u, v, buttons) {
          if (!connected) return;
          const [x, y] = toPixels(u, v);
          const next = vncButtons(buttons);
          if (next !== mask) {
            mask = next;
            internals._handleMouseButton(x, y, mask);
          } else {
            internals._handleMouseMove(x, y);
          }
        },
        wheel(u, v, deltaX, deltaY) {
          if (!connected) return;
          const [x, y] = toPixels(u, v);
          wheelX += deltaX;
          wheelY += deltaY;
          while (Math.abs(wheelY) >= WHEEL_STEP) {
            click(x, y, wheelY < 0 ? VNC_WHEEL.up : VNC_WHEEL.down);
            wheelY -= Math.sign(wheelY) * WHEEL_STEP;
          }
          while (Math.abs(wheelX) >= WHEEL_STEP) {
            click(x, y, wheelX < 0 ? VNC_WHEEL.left : VNC_WHEEL.right);
            wheelX -= Math.sign(wheelX) * WHEEL_STEP;
          }
        },
        // noVNC's own keyboard handler lives on its canvas, so focusing it
        // routes real key events (with correct keysyms) to the VM.
        focusKeyboard: () => rfb.focus({ preventScroll: true }),
        releaseKeyboard: () => rfb.blur(),
        hasKeyboard: () => document.activeElement === canvas,
      },
    };

    // Dev-only handle so test scripts can observe the VNC traffic.
    if (import.meta.env.DEV) Object.assign(source, { rfb, upload });

    rfb.addEventListener('connect', () => {
      connected = true;
      resolve(source);
    });
    rfb.addEventListener('securityfailure', () => reject(new Error('The VM rejected the VNC login')));
    rfb.addEventListener('disconnect', (event) => {
      holder.remove();
      if (!connected) {
        const clean = (event as CustomEvent<{ clean: boolean }>).detail?.clean;
        reject(new Error(clean ? 'The VM closed the connection' : 'Could not reach the VM display (is it running?)'));
        return;
      }
      connected = false;
      ended.forEach((callback) => callback());
    });
  });
}
