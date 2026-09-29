// 3D launcher test against the headless browser:
//   CDP_PORT=9224 node scripts/launcher-test.mjs <out-dir>
// Clicks dock tiles with the real (CDP) mouse through the scene. App launches
// are intercepted in the page, so nothing actually opens on the desktop.
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2] ?? '.';
const { js, send, mouse, sleep, reload, close } = await connect();
const shot = async (name) =>
  writeFileSync(`${out}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await js(`localStorage.removeItem('spatial-desktop.launcher'); localStorage.setItem('spatial-desktop.controls', 'shown'); true`);
await reload();
await sleep(1500);

// Intercept launches: record the request, answer like the server would.
await js(`(() => {
  window.launches = [];
  const real = window.fetch;
  window.fetch = (url, init) => {
    if (String(url).includes('/api/launch')) {
      launches.push({ url: String(url), method: init?.method, type: init?.headers?.['Content-Type'], body: init?.body });
      const id = JSON.parse(init.body).id;
      return Promise.resolve(new Response(JSON.stringify({ launched: id }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real(url, init);
  };
  return true;
})()`);

// Page coordinates of a tile's centre, from its box on the dock canvas.
const tileXY = (id) =>
  js(`(() => {
    const box = launcher.boxes.find((b) => b.tile.id === ${JSON.stringify(id)});
    if (!box) return null;
    const m = launcher.mesh;
    const u = (box.x + 59) / 1200, v = (box.y + 60) / 460;
    const p = m.localToWorld(m.position.clone().set(u - 0.5, 0.5 - v, 0)).project(spatial.world.camera);
    const r = spatial.world.renderer.domElement.getBoundingClientRect();
    return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
  })()`);
const tap = async (id) => {
  const xy = await tileXY(id);
  if (!xy) throw new Error(`no tile ${id}`);
  await mouse('mouseMoved', ...xy);
  await sleep(100);
  await mouse('mousePressed', ...xy, 1);
  await sleep(60);
  await mouse('mouseReleased', ...xy);
  await sleep(250);
};

console.log('tiles:', await js(`launcher.boxes.map((b) => b.tile.id).join(', ')`));
const hoverXY = await tileXY('music');
await mouse('mouseMoved', ...hoverXY);
await sleep(300);
console.log('hovered tile:', await js('launcher.hovered ?? null'));
await shot('launcher-hover');

const musicBefore = await js(`document.getElementById('music').classList.contains('active')`);
await tap('music');
console.log('music toggled:', musicBefore, '→', await js(`document.getElementById('music').classList.contains('active')`));
await tap('music'); // restore

const layoutBefore = await js('spatial.desktop.layout');
await tap('layout');
console.log('layout:', layoutBefore, '→', await js('spatial.desktop.layout'));

const pBefore = await js('music.abundance');
await tap('more');
console.log('p(abundance):', pBefore, '→', await js('music.abundance'));
await tap('less');

await tap('terminal');
await sleep(300);
console.log('launch requests:', JSON.stringify(await js('launches')));
console.log('dock message:', JSON.stringify(await js('launcher.message')));
await shot('launcher-after');

// A hides it; a hidden dock must ignore taps.
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
await sleep(300);
const layoutHidden = await js('spatial.desktop.layout');
await tap('layout');
console.log('after A: visible =', await js('launcher.visible'), '| tap on hidden layout tile changed layout?', layoutHidden !== (await js('spatial.desktop.layout')));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
await send('Emulation.clearDeviceMetricsOverride');
close();
