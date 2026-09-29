// Connects the *test* window to the VM (view only, no input) and saves the
// VM framebuffer and a screenshot of the scene.
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2] ?? '.';
const { js, send, sleep, reload, close } = await connect();
await reload();
await js(`document.getElementById('vm').click()`);
let state;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  state = await js(`(() => {
    const vm = [...spatial.desktop.panels.values()].find((r) => r.source.label === 'Windows VM');
    return { status: document.getElementById('status').textContent, connected: !!vm, size: vm?.source.size() ?? null };
  })()`);
  if (state.connected && state.size) break;
  if (state.status.startsWith('Windows VM:')) break;
}
console.log(state);
if (state.connected) {
  await sleep(2500); // let the panel glide into place
  const fb = await js(`[...spatial.desktop.panels.values()].find((r) => r.source.label === 'Windows VM').source.texture.image.toDataURL('image/png')`);
  writeFileSync(`${out}/vm-framebuffer.png`, Buffer.from(fb.split(',')[1], 'base64'));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${out}/vm-scene.png`, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', `${out}/vm-framebuffer.png`, `${out}/vm-scene.png`);
}
close();
