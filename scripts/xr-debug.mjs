// Checks whether mouse clicks reach panels during an emulated XR session.
import { addTestPanel, connect } from './cdp.mjs';

const { js, mouse, sleep, reload, close } = await connect();
await reload();
await js(addTestPanel);
await sleep(1200);
await js('spatial.world.launchXR()');
await sleep(2000);
await js(`(() => {
  window.log = [];
  const sys = [...spatial.world.systems].find((s) => s.constructor.name === 'EmulatorMouseSystem');
  log.push('handler: ' + !!sys.handler);
  const emu = [...document.querySelectorAll('canvas')].find((c) => c !== spatial.world.renderer.domElement);
  log.push('picked===emu: ' + (sys.emulatorCanvas() === emu));
  emu.addEventListener('pointerdown', (e) => log.push('emu pointerdown ' + e.clientX + ',' + e.clientY), true);
  const [entity] = [...spatial.desktop.panels.keys()];
  for (const t of ['pointerenter', 'pointerdown', 'pointerup', 'pointerleave'])
    entity.object3D.addEventListener(t, (e) => log.push('panel ' + t + ' ' + e.pointerType));
})()`);
await mouse('mouseMoved', 455, 540);
await sleep(200);
await mouse('mousePressed', 455, 540, 1);
await sleep(80);
await mouse('mouseReleased', 455, 540);
await sleep(300);
console.log((await js('log')).join('\n'));
console.log(
  'xr camera',
  await js(`(() => {
    const c = spatial.world.renderer.xr.getCamera();
    return { n: c.cameras.length, fov0: c.cameras[0] && +(2 * Math.atan(1 / c.cameras[0].projectionMatrix.elements[5]) * 180 / Math.PI).toFixed(1) };
  })()`),
);
await js('spatial.world.exitXR()');
close();
