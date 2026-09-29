// Drives the running app over CDP (launch with SPATIAL_DEBUG=1) and checks
// that the mouse can hover, click-to-focus, and drag a panel.
const targets = await (await fetch(`http://localhost:${process.env.CDP_PORT ?? 9223}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  pending.get(msg.id)?.(msg);
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const mouse = (type, x, y, buttons = 0) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = `(() => {
  const [entity, r] = [...spatial.desktop.panels][0];
  const v = r.root.getWorldPosition(r.root.position.clone());
  const p = v.clone().project(spatial.world.camera);
  return { frame: r.frame.color.getHexString(), focused: spatial.desktop.focused === entity, placed: r.placed,
    pos: v.toArray().map((n) => +n.toFixed(2)), screen: [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight].map(Math.round) };
})()`;

const mode = process.argv[2] ?? '2d';
await js(`location.reload()`); await sleep(4000);
if (mode === 'xr') {
  await js(`spatial.world.launchXR()`);
  await sleep(1500);
  console.log('session active:', await js(`!!spatial.world.renderer.xr.getSession()`));
}

await js(`(() => {
  for (const e of [...spatial.desktop.panels.keys()]) e.dispose();
  spatial.desktop.panels.clear();
  const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const g = c.getContext('2d'); g.fillStyle = '#89b4fa'; g.fillRect(0, 0, 640, 360);
  setInterval(() => { g.fillStyle = '#89b4fa'; g.fillRect(0, 0, 640, 360); }, 100);
  spatial.addPanel(spatial.world, { stream: c.captureStream(10), label: 'Test panel' });
})()`);
await sleep(1500);

let s = await js(state);
console.log('start      ', s);
const [x, y] = s.screen;

await mouse('mouseMoved', x, y); await sleep(300);
console.log('hover      ', await js(state));

await mouse('mousePressed', x, y, 1); await sleep(80); await mouse('mouseReleased', x, y); await sleep(1200);
s = await js(state);
console.log('click      ', s);

const [fx, fy] = s.screen;
await mouse('mousePressed', fx, fy, 1);
for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', fx + i * 20, fy - i * 6, 1); await sleep(30); }
await mouse('mouseReleased', fx + 200, fy - 60); await sleep(600);
console.log('drag       ', await js(state));

await mouse('mouseMoved', 5, 5); await sleep(300);
console.log('unhover    ', await js(state));
ws.close();
