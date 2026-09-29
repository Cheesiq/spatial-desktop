// Keyboard-to-VM test against the headless test browser:
//   CDP_PORT=9224 node scripts/vm-keyboard-test.mjs <out-dir>
// Clicks the VM (the lock screen's sign-in box takes focus), types one
// character, deletes it, then presses Escape. It never presses Enter, so it
// never attempts a sign-in.
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2] ?? '.';
const { js, send, mouse, sleep, reload, close } = await connect();
await reload();
await js(`document.getElementById('vm').click()`);
const vm = `[...spatial.desktop.panels.values()].find((r) => r.source.label === 'Windows VM')`;
for (let i = 0; i < 40 && !(await js(`!!${vm}?.source.size()`)); i++) await sleep(250);
await sleep(2500);

await js(`(() => {
  window.keys = [];
  const messages = ${vm}.source.rfb.constructor.messages;
  for (const name of ['keyEvent', 'QEMUExtendedKeyEvent']) {
    const original = messages[name];
    messages[name] = (sock, keysym, down, keycode) => { keys.push([name, keysym, down]); return original.call(messages, sock, keysym, down, keycode); };
  }
})()`);

const frame = async (name) => {
  const png = await js(`${vm}.source.texture.image.toDataURL('image/png')`);
  writeFileSync(`${out}/${name}.png`, Buffer.from(png.split(',')[1], 'base64'));
};
const pageXY = await js(`(() => {
  const r = ${vm};
  const p = r.screen.localToWorld(r.screen.position.clone().set(0, 0, 0)).project(spatial.world.camera);
  const rect = spatial.world.renderer.domElement.getBoundingClientRect();
  return [rect.left + (p.x + 1) / 2 * rect.width, rect.top + (1 - p.y) / 2 * rect.height];
})()`);
await mouse('mouseMoved', ...pageXY);
await mouse('mousePressed', ...pageXY, 1);
await mouse('mouseReleased', ...pageXY);
await sleep(1500);
console.log('status:', await js(`document.getElementById('status').textContent`));
await frame('vm-key-0-focused');

const key = async (key, code, keyCode, text) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  await sleep(600);
};
await key('x', 'KeyX', 88, 'x');
await frame('vm-key-1-typed');
await key('Backspace', 'Backspace', 8);
await frame('vm-key-2-deleted');
await key('Escape', 'Escape', 27);
await sleep(800);
await frame('vm-key-3-escaped');
console.log('VNC key messages:', JSON.stringify(await js('keys')));
console.log('app shortcuts fired?', await js(`[...spatial.desktop.panels.values()].length`), 'panels (should be 1)');
close();
