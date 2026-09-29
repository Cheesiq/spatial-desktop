import { createSystem, type WebGLRenderer } from '@iwsdk/core';

export type Tier = 'low' | 'high';

/** Settings live textures and XR sessions read; decided once at startup. */
export const quality = {
  tier: 'high' as Tier,
  /** Where the tier came from: a ?quality= override or GPU detection. */
  source: 'detected' as 'override' | 'detected',
  gpu: '',
  /** Mipmaps keep distant panel text from shimmering but cost a pass per upload. */
  mipmaps: true,
  /** Highest render pixel ratio the adaptive scaler may use. */
  maxPixelRatio: 1,
  pixelRatio: 1,
  fps: 0,
};

/** Software rasterisers and common low-power integrated/mobile GPUs. */
const LOW_END_GPU = /swiftshader|llvmpipe|softpipe|software|microsoft basic|intel.*\b(hd|uhd)\b|mali|adreno|powervr|videocore/i;

function gpuName(renderer: WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
}

/** Pick the tier and apply the settings that must be in place before rendering. */
export function configureQuality(renderer: WebGLRenderer): void {
  quality.gpu = gpuName(renderer);
  const override = new URLSearchParams(location.search).get('quality');
  if (override === 'low' || override === 'high') {
    quality.tier = override;
    quality.source = 'override';
  } else {
    quality.tier = LOW_END_GPU.test(quality.gpu) ? 'low' : 'high';
  }

  const low = quality.tier === 'low';
  quality.mipmaps = !low;
  // Past 2x the extra pixels are invisible on panels but still cost fill rate.
  quality.maxPixelRatio = low ? 1 : Math.min(window.devicePixelRatio, 2);
  quality.pixelRatio = quality.maxPixelRatio;
  renderer.setPixelRatio(quality.pixelRatio);

  // Only takes effect for sessions started afterwards, which is all of them.
  renderer.xr.setFramebufferScaleFactor(low ? 0.75 : 1);
  renderer.xr.setFoveation(1);
}

const MIN_PIXEL_RATIO = 0.75;
const STEP = 0.25;
/** Sample window, and the frame-rate band that triggers a change. */
const WINDOW_SECONDS = 1;
const SLOW_FPS = 50;
const FAST_FPS = 57;
/** Wait after any change, and longer before retrying a ratio that was too slow. */
const SETTLE_SECONDS = 2;
const RETRY_UP_SECONDS = 10;

/**
 * Lowers the render resolution while frames miss ~50 fps and raises it back
 * when there's headroom. A ratio that has already proved too slow becomes the
 * new ceiling, so it doesn't bounce between two steps. Resolution can't change
 * while an XR session is presenting, so it pauses then.
 */
export class AdaptiveResolutionSystem extends createSystem({}) {
  private frames = 0;
  private elapsed = 0;
  private sinceChange = 0;
  /** Seconds before stepping up is allowed again after stepping down. */
  private cooldown = 0;
  private ceiling = quality.maxPixelRatio;
  private lastChange: 'up' | 'down' | null = null;

  init(): void {
    this.ceiling = quality.maxPixelRatio;
  }

  update(delta: number): void {
    // Ignore stalls (tab hidden, debugger) rather than treating them as slow frames.
    if (delta <= 0 || delta > 0.25 || document.hidden) return;
    this.frames++;
    this.elapsed += delta;
    this.sinceChange += delta;
    if (this.elapsed < WINDOW_SECONDS) return;

    const fps = this.frames / this.elapsed;
    this.cooldown -= this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    quality.fps = Math.round(fps);
    if (this.renderer.xr.isPresenting || this.sinceChange < SETTLE_SECONDS) return;

    const ratio = quality.pixelRatio;
    if (fps < SLOW_FPS && ratio > MIN_PIXEL_RATIO) {
      // Slow right after stepping up: that ratio is too much for this GPU.
      const blameUp = this.lastChange === 'up' && this.sinceChange < SETTLE_SECONDS + 2 * WINDOW_SECONDS;
      if (blameUp) this.ceiling = Math.max(MIN_PIXEL_RATIO, ratio - STEP);
      this.set(Math.max(MIN_PIXEL_RATIO, ratio - STEP), 'down');
      this.cooldown = RETRY_UP_SECONDS;
    } else if (fps >= FAST_FPS && ratio < this.ceiling && this.cooldown <= 0) {
      this.set(Math.min(this.ceiling, ratio + STEP), 'up');
    }
  }

  private set(ratio: number, direction: 'up' | 'down'): void {
    quality.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.sinceChange = 0;
    this.lastChange = direction;
  }
}
