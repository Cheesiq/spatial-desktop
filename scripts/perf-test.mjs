// Low-end GPU checks, run against the headless (SwiftShader) test browser:
//   CDP_PORT=9224 node scripts/perf-test.mjs <out-dir>
// Uses a synthetic 1280x800 canvas in place of the VM, so it never touches
// the real VM. Checks partial-upload correctness, then measures frame rate.
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2] ?? '.';
const { js, send, sleep, reload, close } = await connect();

// A fake VM source backed by DirtyCanvasTexture (or, with legacy=true, the old
// full upload every frame), drawn with a labelled top edge to check orientation.
const setup = (legacy) => `(async () => {
  const { DirtyCanvasTexture } = await import('/src/dirty-texture.ts');
  for (const e of [...spatial.desktop.panels.keys()]) e.dispose();
  spatial.desktop.panels.clear();
  const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 });
  const g = canvas.getContext('2d');
  g.fillStyle = '#c00000'; g.fillRect(0, 0, 1280, 800);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1280, 60);          // white band = top edge
  g.fillStyle = '#000000'; g.font = 'bold 48px sans-serif'; g.fillText('TOP', 590, 48);
  const upload = new DirtyCanvasTexture(canvas, { mipmaps: spatial.quality.mipmaps });
  const legacy = ${legacy};
  window.fake = { canvas, g, upload };
  spatial.addPanel(spatial.world, {
    label: 'Fake VM', texture: upload.texture,
    size: () => [1280, 800],
    update: (r) => legacy ? (upload.texture.needsUpdate = true) : upload.flush(r),
    onEnded() {}, dispose() { upload.dispose(); },
  });
  return true;
})()`;

// Read texels straight from the GPU texture via a framebuffer.
const readTexels = (points) => `(() => {
  const r = spatial.world.renderer, gl = r.getContext();
  const tex = r.properties.get(fake.upload.texture).__webglTexture;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const px = new Uint8Array(4);
  const out = ${JSON.stringify(points)}.map(([x, y]) => { gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [x, y, [...px.slice(0, 3)]]; });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  r.state.reset?.(); r.resetState();
  return out;
})()`;

const fps = (seconds) => js(`new Promise((resolve) => { let n = 0; const tick = () => { n++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(() => resolve(+(n / ${seconds}).toFixed(1)), ${seconds * 1000}); })`);

// ---- 1. correctness -------------------------------------------------------
await reload();
await js(setup(false));
await sleep(1500);
console.log('stats after first frames:', await js('({ ...fake.upload.stats })'));
// Small change: a green 40x30 block at canvas (200, 500) = a moving cursor.
await js(`fake.g.fillStyle = '#00c000'; fake.g.fillRect(200, 500, 40, 30); fake.upload.markDirty(200, 500, 40, 30)`);
await sleep(300);
console.log('stats after small change:', await js('({ ...fake.upload.stats })'));
// Texel rows are canvas rows (no flip on upload): row 10 is the white top band.
console.log('texels [x, y, rgb]:', JSON.stringify(await js(readTexels([[210, 510], [239, 529], [240, 530], [199, 499], [100, 10], [100, 700]]))));
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(500);
writeFileSync(`${out}/perf-orientation.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

// ---- 2. upload cost ---------------------------------------------------------
// Fix the resolution so only the upload path differs between runs.
const pin = `spatial.world.systems && [...spatial.world.systems].find((s) => s.constructor.name === 'AdaptiveResolutionSystem') && ([...spatial.world.systems].find((s) => s.constructor.name === 'AdaptiveResolutionSystem').update = () => {}); spatial.world.renderer.setPixelRatio(1); spatial.quality.pixelRatio = 1`;
const cursorEveryFrame = `(() => { let x = 0; const step = () => { if (!window.fake) return; x = (x + 7) % 1200; fake.g.fillStyle = x % 2 ? '#00c000' : '#c00000'; fake.g.fillRect(x, 400, 24, 24); fake.upload.markDirty(x, 400, 24, 24); requestAnimationFrame(step); }; step(); })()`;
const results = {};
for (const [name, legacy, cursor] of [['old: full upload every frame', true, false], ['new: idle screen', false, false], ['new: cursor moving', false, true]]) {
  await reload();
  await js(pin);
  await js(setup(legacy));
  await sleep(1500);
  if (cursor) await js(cursorEveryFrame);
  await sleep(500);
  results[name] = { fps: await fps(4), uploads: await js('({ ...fake.upload.stats })') };
}
console.table(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { fps: v.fps, full: v.uploads.full, partial: v.uploads.partial, skipped: v.uploads.skipped }])));

// ---- 3. adaptive resolution on a 2x HiDPI screen -------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
await js('location.href = location.pathname + "?quality=high"');
await sleep(1000);
for (let i = 0; i < 120 && !(await js('typeof spatial === "object"').catch(() => false)); i++) await sleep(250);
await js(setup(false));
const trace = [];
for (let i = 0; i < 12; i++) {
  await sleep(1000);
  trace.push(await js('`${spatial.quality.pixelRatio}x @ ${spatial.quality.fps}fps`'));
}
console.log('adaptive (2x screen, forced high tier):', trace.join(' → '));
console.log('detected GPU:', await js('spatial.quality.gpu'), '| auto tier would be:', await js(`/swiftshader|llvmpipe/i.test(spatial.quality.gpu) ? 'low' : 'high'`));
await send('Emulation.clearDeviceMetricsOverride');
await js('location.href = location.pathname');
close();
