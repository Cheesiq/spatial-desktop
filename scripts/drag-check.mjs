// Checks the grabbed spot stays under the cursor through a drag.
const targets = await (await fetch(`http://localhost:${process.env.CDP_PORT ?? 9223}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expression) => { const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result; if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type !== 'mouseMoved' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });

await js(`location.reload()`); await sleep(4000);
await js(`(() => {
  const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  c.getContext('2d').fillRect(0, 0, 640, 360);
  spatial.addPanel(spatial.world, { stream: c.captureStream(5), label: 'probe' });
})()`);
await sleep(1500);
// Local panel coords (metres from centre) under a client-space point.
const under = (x, y) => js(`(() => {
  const r = [...spatial.desktop.panels.values()][0];
  const cam = spatial.world.camera, el = spatial.world.renderer.domElement, rect = el.getBoundingClientRect();
  const ndc = { x: (${x} - rect.left) / rect.width * 2 - 1, y: -((${y} - rect.top) / rect.height) * 2 + 1 };
  const origin = cam.getWorldPosition(r.root.position.clone());
  const p = r.root.position.clone().set(ndc.x, ndc.y, 0.5).unproject(cam).sub(origin).normalize();
  const n = r.root.getWorldDirection(r.root.position.clone());
  const t = r.root.position.clone().sub(origin).dot(n) / p.dot(n);
  const hit = origin.add(p.multiplyScalar(t));
  return r.root.worldToLocal(hit).toArray().slice(0, 2).map((v) => +v.toFixed(3));
})()`);

const [x0, y0] = [520, 470]; // off-centre grab point
console.log('grab spot before', await under(x0, y0));
await mouse('mouseMoved', x0, y0); await sleep(100);
await mouse('mousePressed', x0, y0, 1);
for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', x0 + i * 20, y0 - i * 8, 1); await sleep(30); }
await sleep(200);
console.log('grab spot after ', await under(x0 + 240, y0 - 96));
await mouse('mouseReleased', x0 + 240, y0 - 96);
ws.close();
