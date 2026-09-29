// End-to-end VM mouse test, run against the headless test browser:
//   CDP_PORT=9224 node scripts/vm-input-test.mjs <out-dir>
// 1. Aims the real (CDP) mouse at known VM pixels through the 3D scene and
//    records the VNC pointer messages actually sent to the VM.
// 2. Clicks once on the lock screen and saves the framebuffer before/after,
//    which should show the curtain raised to the sign-in box. It never signs in.
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2] ?? '.';
const { js, mouse, sleep, reload, close } = await connect();
await reload();
await js(`document.getElementById('vm').click()`);
const vm = `[...spatial.desktop.panels.values()].find((r) => r.source.label === 'Windows VM')`;
for (let i = 0; i < 40 && !(await js(`!!${vm}?.source.size()`)); i++) await sleep(250);
await sleep(2500); // settle into the layout slot

// Record every VNC pointer message: [x, y, buttonMask] in VM pixels.
await js(`(() => {
  window.sent = [];
  const messages = ${vm}.source.rfb.constructor.messages;
  const original = messages.pointerEvent;
  messages.pointerEvent = (sock, x, y, mask) => { sent.push([x, y, mask]); return original.call(messages, sock, x, y, mask); };
})()`);

// Page CSS pixel where a given VM framebuffer pixel appears.
const pageXY = (px, py) =>
  js(`(() => {
    const r = ${vm}, [w, h] = r.source.size();
    const p = r.screen.localToWorld(r.screen.position.clone().set((${px} + 0.5) / w - 0.5, 0.5 - (${py} + 0.5) / h, 0));
    p.project(spatial.world.camera);
    const rect = spatial.world.renderer.domElement.getBoundingClientRect();
    return [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height];
  })()`);

const results = [];
for (const [px, py] of [[100, 100], [640, 400], [1180, 700], [320, 600]]) {
  const [x, y] = await pageXY(px, py);
  await js('sent.length = 0');
  await mouse('mouseMoved', x, y);
  await sleep(150); // noVNC throttles moves to one per 17ms
  const last = (await js('sent')).at(-1) ?? null;
  results.push({ target: `${px},${py}`, page: `${x.toFixed(1)},${y.toFixed(1)}`, sentToVm: last && `${last[0]},${last[1]} mask ${last[2]}` });
}
console.table(results);

const frame = async (name) => {
  const png = await js(`${vm}.source.texture.image.toDataURL('image/png')`);
  writeFileSync(`${out}/${name}.png`, Buffer.from(png.split(',')[1], 'base64'));
};
await frame('vm-before-click');
const [cx, cy] = await pageXY(640, 400);
await js('sent.length = 0');
await mouse('mouseMoved', cx, cy);
await mouse('mousePressed', cx, cy, 1);
await sleep(80);
await mouse('mouseReleased', cx, cy);
await sleep(1500);
console.log('click messages sent to VM:', JSON.stringify(await js('sent')));
await frame('vm-after-click');
console.log('status:', await js(`document.getElementById('status').textContent`));
console.log('saved', `${out}/vm-before-click.png`, `${out}/vm-after-click.png`);
close();
