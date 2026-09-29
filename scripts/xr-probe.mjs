const targets = await (await fetch(`http://localhost:${process.env.CDP_PORT ?? 9223}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expression) => { const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result; if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await js(`location.reload()`); await sleep(4000);
await js(`spatial.world.launchXR()`); await sleep(1500);
console.log(await js(`(() => {
  const el = document.elementFromPoint(455, 500);
  const describe = (e) => e ? e.tagName + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '') : null;
  const chain = []; for (let e = el; e; e = e.parentElement) chain.push(describe(e));
  return { session: !!spatial.world.renderer.xr.getSession(), under: chain, canvas: describe(spatial.world.renderer.domElement),
    canvasStyle: getComputedStyle(spatial.world.renderer.domElement).pointerEvents,
    overlays: [...document.body.children].map(e => describe(e) + ' z=' + getComputedStyle(e).zIndex + ' pe=' + getComputedStyle(e).pointerEvents) };
})()`));
ws.close();
