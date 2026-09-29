// Tiny CDP client for the *test* browser (port 9223 unless CDP_PORT is set),
// so test runs never touch the window you're actually using.
export async function connect() {
  const port = process.env.CDP_PORT ?? 9223;
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const js = async (expression, ms = 20000) => {
    // Client-side deadline: a reply can be lost if the page navigates or freezes.
    const reply = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
    if (!reply) throw new Error(`Page did not answer within ${ms}ms: ${expression.slice(0, 80)}`);
    const r = reply.result;
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const mouse = (type, x, y, buttons = 0) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      buttons,
      button: buttons || type !== 'mouseMoved' ? 'left' : 'none',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Reload and wait until the app has finished starting (up to 30s). */
  const reload = async () => {
    // Don't evaluate location.reload(): the reply dies with the page.
    void send('Page.reload');
    await sleep(500);
    for (let i = 0; i < 60; i++) {
      try {
        if (await js('typeof spatial === "object"', 1000)) return;
      } catch {
        // Mid-navigation or still starting; keep polling.
      }
      await sleep(250);
    }
    throw new Error('App did not start within 30s of reloading');
  };
  return { send, js, mouse, sleep, reload, close: () => ws.close() };
}

/** A solid-blue fake "window" so tests don't need the portal picker. */
export const addTestPanel = `(() => {
  const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const g = c.getContext('2d');
  setInterval(() => { g.fillStyle = '#89b4fa'; g.fillRect(0, 0, 640, 360); }, 100);
  return spatial.addPanel(spatial.world, spatial.streamSource(c.captureStream(10), 'Test panel')) && true;
})()`;
