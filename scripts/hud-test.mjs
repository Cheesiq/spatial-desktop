// Screenshots the HUD (bottom bar, narrow width, hidden) and reports audio state:
//   CDP_PORT=9224 node scripts/hud-test.mjs <out-dir>
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const out = process.argv[2] ?? '.';
const { js, send, mouse, sleep, reload, close } = await connect();
const shot = async (name) =>
  writeFileSync(`${out}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
const key = async (k, code) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text: k });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
};

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await js(`localStorage.removeItem('spatial-desktop.controls')`);
await reload();
await js(`spatial.addPanel(spatial.world, spatial.streamSource(Object.assign(document.createElement('canvas'), { width: 640, height: 360 }).captureStream(1), 'Test panel')) && true`); // don't serialise the entity
console.log('audio before any interaction:', await js('audio.state'));
await mouse('mousePressed', 640, 200, 1);
await mouse('mouseReleased', 640, 200);
await sleep(800);
console.log('audio after a click:', await js('audio.state'), '| music active:', await js(`document.getElementById('music').classList.contains('active')`));
await sleep(1200);
await shot('hud-bottom');

await key('h', 'KeyH');
await sleep(300);
console.log('after H: collapsed =', await js(`document.getElementById('hud').classList.contains('collapsed')`), '| stored =', await js(`localStorage.getItem('spatial-desktop.controls')`));
await shot('hud-hidden');
await js(`document.getElementById('show').click()`);
console.log('after Show click: collapsed =', await js(`document.getElementById('hud').classList.contains('collapsed')`));

await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(800);
await shot('hud-narrow');
console.log('narrow: page scrollWidth', await js('document.documentElement.scrollWidth'), 'hud width', await js(`Math.round(document.getElementById('hud').getBoundingClientRect().width)`));
await send('Emulation.clearDeviceMetricsOverride');
close();
