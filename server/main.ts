/**
 * The production server: serves the built app (dist/) and mounts the same
 * features as the dev server. The desktop app starts it in-process; it also
 * runs on its own with `npm start` after `npm run build`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachFeatures } from './features.js';
import type { Handler, Host, UpgradeHandler } from './host.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

export interface RunningServer {
  url: string;
  /** Stop serving and clean up (removes the Hyprland panel's virtual monitor). */
  close(): Promise<void>;
}

/** Serve `root` (the Vite build) on 127.0.0.1; port 0 picks a free one. */
export async function startServer({ root, port = 0 }: { root: string; port?: number }): Promise<RunningServer> {
  const base = resolve(root);
  const routes: Array<[string, Handler]> = [];
  const upgrades = new Map<string, UpgradeHandler>();
  const origins = new Set<string>();

  const serveFile = (req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(base, path));
    if (file !== base && !file.startsWith(base + sep)) return void ((res.statusCode = 403), res.end());
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(base, 'index.html');
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(file).pipe(res);
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    for (const [prefix, handler] of routes) {
      if (path === prefix || path.startsWith(prefix + '/')) return handler(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void ((res.statusCode = 405), res.end());
    serveFile(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    const handler = upgrades.get(new URL(req.url ?? '/', 'http://x').pathname);
    if (handler) handler(req, socket, head);
    else socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });

  const host: Host = {
    use: (path, handler) => routes.push([path, handler]),
    onUpgrade: (path, handler) => upgrades.set(path, handler),
    log: { warn: (message) => console.warn(message), error: (message) => console.error(message) },
    origins,
  };
  const hyprland = attachFeatures(host);

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  const actual = (server.address() as AddressInfo).port;
  origins.add(`http://127.0.0.1:${actual}`).add(`http://localhost:${actual}`);

  return {
    url: `http://127.0.0.1:${actual}/`,
    close: () =>
      new Promise((done) => {
        hyprland?.shutdown();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

// Run directly: node dist-server/main.mjs [port]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
  const running = await startServer({ root, port: Number(process.argv[2] ?? process.env.PORT ?? 5174) });
  console.log(`Spatial Desktop: ${running.url}`);
}
