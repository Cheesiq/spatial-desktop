const targets = await (await fetch(`http://localhost:${process.env.CDP_PORT ?? 9223}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type !== 'mouseMoved' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
await js(`location.reload()`); await sleep(4000);
await js(`(() => {
  const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  c.getContext('2d').fillRect(0, 0, 640, 360);
  const e = spatial.addPanel(spatial.world, { stream: c.captureStream(5), label: 'probe' });
  window.log = [];
  e.object3D.addEventListener('pointermove', (ev) => log.push([ev.pointerType, ev.pointer?.toArray().map(n=>+n.toFixed(3)), ev.point.toArray().map(n=>+n.toFixed(2))]));
})()`);
await sleep(1500);
await mouse('mousePressed', 455, 501, 1);
for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', 455 + i * 40, 501, 1); await sleep(40); }
await mouse('mouseReleased', 655, 501);
console.log(JSON.stringify(await js('log'), null, 0));
console.log('innerWidth', await js('innerWidth'), 'canvas', await js('[spatial.world.renderer.domElement.clientWidth, spatial.world.renderer.domElement.width]'));
ws.close();
