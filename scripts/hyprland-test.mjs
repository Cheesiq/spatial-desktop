// Hyprland panel test against the headless browser:
//   CDP_PORT=9224 node scripts/hyprland-test.mjs <out-dir>
// Opens the panel, saves what it shows, then clicks it with the (CDP) mouse,
// which moves the REAL desktop cursor onto the virtual monitor, checks it got
// there, and sends it back. Needs Hyprland and wayvnc.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2] ?? '.';
const { js, mouse, sleep, reload, close } = await connect();
const cursor = () => execFileSync('hyprctl', ['cursorpos']).toString().trim();
const output = () =>
  JSON.parse(execFileSync('hyprctl', ['-j', 'monitors']).toString()).find((m) => m.name === 'SPATIAL-1');

await reload();
await js(`document.getElementById('hyprland').click()`);
const panel = `[...spatial.desktop.panels.values()].find((r) => r.source.label === 'Hyprland')`;
for (let i = 0; i < 40 && !(await js(`!!${panel}?.source.size()`)); i++) await sleep(250);
console.log('panel size:', await js(`${panel}?.source.size()`));
await sleep(2500); // settle into the layout slot
const png = await js(`${panel}.source.texture.image.toDataURL('image/png')`);
writeFileSync(`${out}/hyprland-panel.png`, Buffer.from(png.split(',')[1], 'base64'));

// Page pixel of the panel's centre.
const [x, y] = await js(`(() => {
  const entity = [...spatial.desktop.panels.keys()].find((e) => spatial.desktop.panels.get(e).source.label === 'Hyprland');
  const r = spatial.desktop.panels.get(entity);
  const p = r.screen.localToWorld(r.screen.position.clone().set(0, 0, 0)).project(spatial.world.camera);
  const rect = spatial.world.renderer.domElement.getBoundingClientRect();
  return [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height];
})()`);
const before = cursor();
await mouse('mouseMoved', x, y);
await mouse('mousePressed', x, y, 1);
await sleep(60);
await mouse('mouseReleased', x, y);
await sleep(600);
const m = output();
const [cx, cy] = cursor().split(',').map(Number);
const onPanel = cx >= m.x && cx < m.x + m.width / m.scale && cy >= m.y && cy < m.y + m.height / m.scale;
console.log(`cursor ${before} → ${cx}, ${cy}: ${onPanel ? 'on SPATIAL-1' : 'NOT on SPATIAL-1'}`);
console.log('status:', await js(`document.getElementById('status').textContent`));

await js(`fetch('/api/hyprland/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })`);
await sleep(300);
console.log('after leave:', cursor());
close();
