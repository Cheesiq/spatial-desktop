import { CanvasTexture, LinearFilter, SRGBColorSpace, type WebGLRenderer } from '@iwsdk/core';

/** Above this share of the canvas, one full upload beats a sub-rectangle. */
const FULL_UPLOAD_SHARE = 0.5;

/**
 * A canvas texture that uploads only what changed. Callers report damage with
 * `markDirty`; `flush` then does nothing when the canvas is idle, a
 * `texSubImage2D` of the damaged rectangle for small changes (a cursor, a
 * clock), and a normal full upload otherwise. On a weak GPU this replaces a
 * full-frame upload every render frame.
 */
export class DirtyCanvasTexture {
  readonly texture: CanvasTexture;
  private dirty: { left: number; top: number; right: number; bottom: number } | null = null;
  private uploadedSize: [number, number] | null = null;
  /** Upload counters, for diagnostics. */
  readonly stats = { full: 0, partial: 0, skipped: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: { mipmaps: boolean },
  ) {
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    // Sub-rectangle uploads need rows in canvas order, so don't flip on
    // upload; flip in the UV transform instead.
    texture.flipY = false;
    texture.repeat.set(1, -1);
    texture.offset.set(0, 1);
    if (!options.mipmaps) {
      texture.generateMipmaps = false;
      texture.minFilter = LinearFilter;
    }
    texture.needsUpdate = false;
    this.texture = texture;
  }

  /** Record that a canvas-pixel rectangle changed. */
  markDirty(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const d = this.dirty;
    if (!d) {
      this.dirty = { left: x, top: y, right: x + w, bottom: y + h };
      return;
    }
    d.left = Math.min(d.left, x);
    d.top = Math.min(d.top, y);
    d.right = Math.max(d.right, x + w);
    d.bottom = Math.max(d.bottom, y + h);
  }

  /** Push pending changes to the GPU; call once per frame before rendering. */
  flush(renderer: WebGLRenderer): void {
    const { canvas, texture } = this;
    const width = canvas.width;
    const height = canvas.height;
    const resized = this.uploadedSize?.[0] !== width || this.uploadedSize?.[1] !== height;
    const gl = renderer.getContext();
    const handle = renderer.properties.get(texture) as { __webglTexture?: WebGLTexture };

    if (resized || !handle.__webglTexture || !(gl instanceof WebGL2RenderingContext)) {
      if (!resized && !this.dirty) return void this.stats.skipped++;
      this.full(width, height);
      return;
    }
    const d = this.dirty;
    if (!d) return void this.stats.skipped++;
    this.dirty = null;

    const x = Math.max(0, Math.floor(d.left));
    const y = Math.max(0, Math.floor(d.top));
    const w = Math.min(width, Math.ceil(d.right)) - x;
    const h = Math.min(height, Math.ceil(d.bottom)) - y;
    if (w <= 0 || h <= 0) return;
    if (w * h > FULL_UPLOAD_SHARE * width * height) {
      this.full(width, height);
      return;
    }

    renderer.state.activeTexture(gl.TEXTURE0);
    renderer.state.bindTexture(gl.TEXTURE_2D, handle.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    if (texture.generateMipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    this.stats.partial++;
  }

  private full(width: number, height: number): void {
    this.dirty = null;
    this.uploadedSize = [width, height];
    this.texture.needsUpdate = true;
    this.stats.full++;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
