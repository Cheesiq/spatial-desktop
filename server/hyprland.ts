/**
 * Hyprland itself as a panel. The server adds a headless Hyprland output
 * (a virtual monitor nobody sees directly) and streams it with wayvnc, so it
 * is a real part of the running desktop: apps open on it, Super+Space search
 * works on it, and windows can be moved between it and the real monitors.
 *
 * Hyprland has one cursor and one keyboard focus, shared with the Chromium
 * window the scene runs in, so input works two ways:
 *
 * - Mouse ("entering"): clicking the panel moves the real cursor and focus onto
 *   the virtual monitor, where the real mouse and keyboard drive Hyprland
 *   natively (hover, drag, Super shortcuts). wayvnc draws the cursor into the
 *   stream. Pushing the cursor off the monitor's left, right or bottom edge
 *   puts it back on the scene, next to the matching edge of the panel.
 * - XR rays ("borrowing"): the cursor is moved onto the virtual monitor for
 *   each click and then put back, with the focus.
 *
 * Either way the page positions the cursor here, through Hyprland, and sends
 * only buttons and wheel through VNC: Hyprland maps wayvnc's absolute pointer
 * motion onto the first real monitor, not SPATIAL-1, so the page always sends
 * it the same (0, 0) position, for which wayvnc sends no motion at all.
 *   Keys typed while the panel has the keyboard go to the last window clicked,
 *   through Hyprland's send_key_state, without taking focus from the scene.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { WebSocketServer } from 'ws';
import type { Host } from './host.js';

export const OUTPUT = 'SPATIAL-1';
const WORKSPACE = 'name:spatial';
const MODE = { width: 1920, height: 1080, scale: 1.25 };
const RUNTIME = `${process.env.XDG_RUNTIME_DIR}/spatial-desktop`;
const VNC_SOCKET = `${RUNTIME}/vnc.sock`;
const HYPR_SOCKET = `${process.env.XDG_RUNTIME_DIR}/hypr/${process.env.HYPRLAND_INSTANCE_SIGNATURE}/.socket.sock`;
/** Distance (logical px) outside the panel's edge where the cursor comes back. */
const RETURN_GAP = 24;
const MODS = new Set(['SHIFT', 'CTRL', 'ALT', 'SUPER']);

type Point = [number, number];
/** Panel corners in the scene window's CSS px (= Hyprland logical px): TL, TR, BR, BL. */
type Quad = [Point, Point, Point, Point];
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Monitor {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
interface Client {
  address?: string;
  monitor: number;
  at: Point;
  size: Point;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request on Hyprland's IPC socket (what hyprctl does). */
function hypr(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(HYPR_SOCKET);
    let reply = '';
    socket.setEncoding('utf8');
    socket.on('data', (data) => (reply += data));
    socket.on('end', () => resolve(reply));
    socket.on('error', reject);
    socket.write(command);
  });
}
const query = async <T>(what: string): Promise<T> => JSON.parse(await hypr(`j/${what}`)) as T;
async function dispatch(lua: string): Promise<void> {
  const reply = await hypr(`dispatch ${lua}`);
  if (reply.trim() !== 'ok') throw new Error(`Hyprland: ${reply.trim()}`);
}
const moveCursor = ([x, y]: Point) => dispatch(`hl.dsp.cursor.move({ x = ${Math.round(x)}, y = ${Math.round(y)} })`);
const focusWindow = (address: string) => dispatch(`hl.dsp.focus({ window = "address:${address}" })`);
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]+$/.test(value);

/** The virtual monitor's area in global logical coordinates, creating it if needed. */
async function ensureOutput(): Promise<Monitor & Rect> {
  let monitors = await query<Monitor[]>('monitors all');
  if (!monitors.some((m) => m.name === OUTPUT)) {
    // Up and left of every real monitor with a gap: the real cursor can't
    // wander onto it, and monitors placed "auto" don't move to make room.
    const x = Math.min(0, ...monitors.map((m) => m.x)) - MODE.width - 1000;
    const y = Math.min(0, ...monitors.map((m) => m.y)) - MODE.height - 1000;
    await hypr(
      `eval hl.monitor({ output = "${OUTPUT}", mode = "${MODE.width}x${MODE.height}@60", position = "${x}x${y}", scale = ${MODE.scale} }); ` +
        `hl.workspace_rule({ workspace = "${WORKSPACE}", monitor = "${OUTPUT}", default = true, persistent = true })`,
    );
    await hypr(`output create headless ${OUTPUT}`);
    for (let i = 0; i < 40 && !monitors.some((m) => m.name === OUTPUT); i++) {
      await sleep(50);
      monitors = await query<Monitor[]>('monitors');
    }
  }
  const m = monitors.find((m) => m.name === OUTPUT);
  if (!m) throw new Error('Hyprland did not create the virtual monitor');
  return { ...m, w: Math.round(m.width / m.scale), h: Math.round(m.height / m.scale) };
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Where (u, v) on the panel is on screen: bilinear across its projected corners. */
function onQuad([tl, tr, br, bl]: Quad, u: number, v: number): Point {
  const top: Point = [tl[0] + (tr[0] - tl[0]) * u, tl[1] + (tr[1] - tl[1]) * u];
  const bottom: Point = [bl[0] + (br[0] - bl[0]) * u, bl[1] + (br[1] - bl[1]) * u];
  return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
}

function isQuad(value: unknown): value is Quad {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)))
  );
}

export interface HyprlandDesktop {
  /** The server is going away but may come back (a dev-server restart): stop wayvnc, keep the monitor. */
  close(): void;
  /** The app is quitting: also remove the virtual monitor, moving its windows to a real one. */
  shutdown(): void;
}

/** Mount the Hyprland panel's endpoints on `host`; null outside a Hyprland session. */
export function attachHyprland(host: Host, canRun: (program: string) => boolean): HyprlandDesktop | null {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  const allowedOrigins = host.origins;
  let vnc: ChildProcess | null = null;
  /** The scene's window while the real cursor is on the virtual monitor. */
  let inside: { address: string; window: Rect; quad: Quad; edgeHits: number } | null = null;
  let polling: ReturnType<typeof setInterval> | undefined;
  /** Cursor and focus to put back after an XR ray click. */
  let borrowed: { address: string | null; cursor: Point } | null = null;
  let returnTimer: ReturnType<typeof setTimeout> | undefined;
  /** Window on the virtual monitor that forwarded keys go to. */
  let keyTarget: string | null = null;
  const listeners = new Set<ServerResponse>();

  const broadcast = () => {
    const data = `data: ${JSON.stringify({ inside: inside != null, keyTarget: keyTarget != null })}\n\n`;
    for (const res of listeners) res.write(data);
  };

  async function ensureVnc(): Promise<void> {
    if (vnc) return;
    if (!canRun('wayvnc')) throw new Error('wayvnc is not installed (sudo pacman -S wayvnc)');
    mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
    rmSync(VNC_SOCKET, { force: true });
    // A plain unix socket: nothing on the network, or any web page, can reach
    // it; the page gets it through the origin-checked /hyprland-vnc bridge.
    // (wayvnc's own --websocket crashes in neatvnc 1.0.1's handshake, so the
    // bridge does the websocket framing.)
    const child = spawn(
      'wayvnc',
      ['--output', OUTPUT, '--unix-socket', '--render-cursor', '--max-fps', '60', '--socket', `${RUNTIME}/wayvnc-ctl.sock`, VNC_SOCKET],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    vnc = child;
    child.stderr?.on('data', (data: Buffer) => host.log.warn(`[wayvnc] ${String(data).trim()}`));
    child.once('error', (error) => host.log.error(`[wayvnc] ${error.message}`));
    child.once('exit', () => vnc === child && (vnc = null));
    for (let i = 0; i < 50; i++) {
      if (await canConnect(VNC_SOCKET)) return;
      if (vnc !== child) break;
      await sleep(100);
    }
    throw new Error('wayvnc did not start');
  }

  /** Move the real cursor and focus onto the virtual monitor at (u, v). */
  async function enter(u: number, v: number, quad: Quad): Promise<void> {
    const output = await ensureOutput();
    if (!inside) {
      const scene = await query<Client>('activewindow');
      if (!isAddress(scene.address) || scene.monitor === output.id) throw new Error('The scene window is not focused');
      inside = {
        address: scene.address,
        window: { x: scene.at[0], y: scene.at[1], w: scene.size[0], h: scene.size[1] },
        quad,
        edgeHits: 0,
      };
    } else {
      inside.quad = quad;
    }
    clearTimeout(returnTimer);
    borrowed = null;
    await dispatch(`hl.dsp.focus({ monitor = "${OUTPUT}" })`);
    // Stay a pixel inside the edges so arriving doesn't count as leaving.
    await moveCursor([
      output.x + Math.min(output.w - 2, Math.max(1, u * output.w)),
      output.y + Math.min(output.h - 2, Math.max(1, v * output.h)),
    ]);
    clearInterval(polling);
    polling = setInterval(() => void watchCursor(output).catch(() => {}), 33);
    broadcast();
  }

  /** While entered, notice the cursor leaving through an edge (or any other way). */
  async function watchCursor(output: Rect): Promise<void> {
    if (!inside) return clearInterval(polling);
    const [x, y] = (({ x, y }) => [x, y])(await query<{ x: number; y: number }>('cursorpos'));
    const within = x >= output.x && x < output.x + output.w && y >= output.y && y < output.y + output.h;
    if (!within) {
      // Left another way, e.g. a Super+number to a workspace on a real monitor.
      inside = null;
      clearInterval(polling);
      return broadcast();
    }
    // The cursor is clamped to the monitor, so pushing past an edge pins it
    // there. The top edge is left alone: that's where the bar is.
    const left = x <= output.x, right = x >= output.x + output.w - 1.5, bottom = y >= output.y + output.h - 1.5;
    inside.edgeHits = left || right || bottom ? inside.edgeHits + 1 : 0;
    if (inside.edgeHits >= 2) await leave((x - output.x) / output.w, (y - output.y) / output.h);
  }

  /** Put the cursor back in the scene window just outside the panel at (u, v), or its centre. */
  async function leave(u?: number, v?: number): Promise<void> {
    const home = inside;
    if (!home) return;
    inside = null;
    clearInterval(polling);
    const { window, quad } = home;
    let point: Point = [window.w / 2, window.h / 2];
    if (u != null && v != null) {
      const edge = onQuad(quad, Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
      const centre = onQuad(quad, 0.5, 0.5);
      const length = Math.hypot(edge[0] - centre[0], edge[1] - centre[1]) || 1;
      point = [edge[0] + ((edge[0] - centre[0]) / length) * RETURN_GAP, edge[1] + ((edge[1] - centre[1]) / length) * RETURN_GAP];
    }
    const x = window.x + Math.min(window.w - 2, Math.max(1, point[0]));
    const y = window.y + Math.min(window.h - 2, Math.max(1, point[1]));
    try {
      await focusWindow(home.address);
    } catch {
      // The scene window is gone; still get the cursor off the virtual monitor.
    }
    await moveCursor([x, y]);
    broadcast();
  }

  /** Put the cursor at (u, v) on the virtual monitor. */
  async function point(u: number, v: number): Promise<void> {
    const output = await ensureOutput();
    await moveCursor([output.x + Math.min(output.w - 1, u * output.w), output.y + Math.min(output.h - 1, v * output.h)]);
  }

  /** Before an XR ray click: remember the cursor and focus to restore, then move to (u, v). */
  async function borrow(u: number, v: number): Promise<void> {
    await ensureOutput();
    clearTimeout(returnTimer);
    if (!inside && !borrowed) {
      const [cursor, active] = await Promise.all([query<{ x: number; y: number }>('cursorpos'), query<Client>('activewindow')]);
      borrowed = { address: isAddress(active.address) ? active.address : null, cursor: [cursor.x, cursor.y] };
    }
    if (!inside) await point(u, v);
  }

  /** After an XR ray click: note the clicked window for keys, then put things back. */
  function giveBack(): void {
    clearTimeout(returnTimer);
    // Wait for wayvnc to deliver the click; a quick second click (a double
    // click) borrows again before this runs, so nothing jumps in between.
    returnTimer = setTimeout(async () => {
      const home = borrowed;
      if (!home) return;
      borrowed = null;
      try {
        const [output, active] = await Promise.all([ensureOutput(), query<Client>('activewindow')]);
        if (active.monitor === output.id && isAddress(active.address)) keyTarget = active.address;
        if (home.address) await focusWindow(home.address);
        await moveCursor(home.cursor);
      } finally {
        broadcast();
      }
    }, 150);
  }

  async function sendKey(code: number, mods: string): Promise<boolean> {
    if (!keyTarget) return false;
    try {
      for (const state of ['down', 'up']) {
        await dispatch(`hl.dsp.send_key_state({ mods = "${mods}", key = "code:${code}", state = "${state}", window = "address:${keyTarget}" })`);
      }
      return true;
    } catch {
      keyTarget = null; // The window closed.
      broadcast();
      return false;
    }
  }

  function cleanUp(): void {
    vnc?.kill();
    vnc = null;
    clearInterval(polling);
    // Removing the output moves its windows to a real monitor, and a cursor
    // still on it, so nothing is left stranded off-screen.
    try {
      execFileSync('hyprctl', ['output', 'remove', OUTPUT], { stdio: 'ignore', timeout: 2000 });
    } catch {
      // Hyprland isn't running, or the output was never made.
    }
  }

  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', () => {
        try {
          const value = JSON.parse(body || '{}');
          resolve(value && typeof value === 'object' ? value : {});
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });

  /** POST-only, same-origin, JSON-only endpoint (see attachLauncher in server/features.ts). */
  const endpoint =
    (handler: (body: Record<string, unknown>) => Promise<object>) => async (req: IncomingMessage, res: ServerResponse) => {
      const reply = (status: number, body: object) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST') return reply(405, { error: 'POST only' });
      if (!allowedOrigins.has(req.headers.origin ?? '')) return reply(403, { error: 'Forbidden origin' });
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON only' });
      try {
        reply(200, await handler(await readJson(req)));
      } catch (error) {
        reply(500, { error: (error as Error).message });
      }
    };

  const unit = (value: unknown) => (typeof value === 'number' && value >= 0 && value <= 1 ? value : 0.5);

  process.once('exit', cleanUp);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      cleanUp();
      process.exit(0);
    });
  }

  host.use(
    '/api/hyprland/start',
    endpoint(async () => {
      const output = await ensureOutput();
      await ensureVnc();
      return { width: output.width, height: output.height };
    }),
  );
  host.use(
    '/api/hyprland/enter',
    endpoint(async (body) => {
      if (!isQuad(body.quad)) throw new Error('Bad quad');
      await enter(unit(body.u), unit(body.v), body.quad);
      return { inside: true };
    }),
  );
  host.use(
    '/api/hyprland/leave',
    endpoint(async () => {
      await leave();
      return { inside: false };
    }),
  );
  host.use(
    '/api/hyprland/search',
    endpoint(async (body) => {
      if (!isQuad(body.quad)) throw new Error('Bad quad');
      if (!canRun('omarchy-menu')) throw new Error('omarchy-menu is not installed');
      // The menu opens on the focused monitor, and so do the apps it starts.
      await enter(0.5, 0.5, body.quad);
      spawn('omarchy-menu', ['toggle', 'apps'], { detached: true, stdio: 'ignore' }).unref();
      return { inside: true };
    }),
  );
  host.use(
    '/api/hyprland/borrow',
    endpoint(async (body) => {
      await borrow(unit(body.u), unit(body.v));
      return {};
    }),
  );
  host.use(
    '/api/hyprland/point',
    endpoint(async (body) => {
      // Only while borrowed: a stray request must not pull the cursor away.
      if (borrowed && !inside) await point(unit(body.u), unit(body.v));
      return {};
    }),
  );
  host.use(
    '/api/hyprland/return',
    endpoint(async () => {
      giveBack();
      return {};
    }),
  );
  host.use(
    '/api/hyprland/key',
    endpoint(async (body) => {
      const code = body.code;
      const mods = Array.isArray(body.mods) ? body.mods.filter((m): m is string => MODS.has(m as string)) : [];
      if (typeof code !== 'number' || !Number.isInteger(code) || code < 9 || code > 255) throw new Error('Bad key code');
      return { delivered: await sendKey(code, mods.join(' ')) };
    }),
  );
  // Server-sent events: whether the real cursor is on the virtual monitor.
  host.use('/api/hyprland/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    listeners.add(res);
    broadcast();
    req.on('close', () => {
      listeners.delete(res);
      // The page went away mid-visit: don't leave the cursor stranded.
      if (!listeners.size) void leave().catch(() => {});
    });
  });

  // ws://<host>/hyprland-vnc → wayvnc's unix socket.
  const wss = new WebSocketServer({ noServer: true });
  host.onUpgrade('/hyprland-vnc', (req, socket, head) => {
    if (!allowedOrigins.has(req.headers.origin ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const upstream = connect(VNC_SOCKET);
      upstream.on('data', (data) => ws.send(data));
      ws.on('message', (data) => upstream.write(data as Buffer));
      const close = () => {
        ws.close();
        upstream.destroy();
      };
      upstream.on('error', close).on('close', close);
      ws.on('error', close).on('close', close);
    });
  });

  return {
    close() {
      vnc?.kill();
      vnc = null;
      clearInterval(polling);
    },
    shutdown: cleanUp,
  };
}

/**
 * Start `command` through Hyprland so its window opens on the virtual
 * monitor's workspace instead of wherever focus is. The argv comes from
 * server/apps.ts, never the page.
 */
export async function launchOnPanel(command: readonly string[]): Promise<boolean> {
  const monitors = await query<Monitor[]>('monitors').catch(() => []);
  if (!monitors.some((m) => m.name === OUTPUT)) return false;
  const shell = command.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(' ');
  if (shell.includes(']]')) return false;
  const reply = await hypr(`eval hl.exec_cmd([[${shell}]], { workspace = "${WORKSPACE} silent" })`);
  return reply.trim() === 'ok';
}
