import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig, type Plugin } from 'vite';
import { isInstalled, LAUNCHER_APPS } from './server/apps.js';
import { hyprlandDesktop, launchOnPanel } from './server/hyprland.js';

const PORT = 5173;
/** Only this app's own pages may use the VM proxy or the app launcher. */
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

/** Omarchy's Windows VM (dockur/windows) serves noVNC's websockify here. */
const VM_VNC = { host: '127.0.0.1', port: 8006, path: '/websockify' };
const VM_CREDENTIALS = `${homedir()}/.config/windows/credentials`;

/** USERNAME/PASSWORD from Omarchy's private (0600) VM credentials file. */
function readVmCredentials(): { username: string; password: string } | null {
  try {
    const fields = Object.fromEntries(
      readFileSync(VM_CREDENTIALS, 'utf8')
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return fields.USERNAME && fields.PASSWORD ? { username: fields.USERNAME, password: fields.PASSWORD } : null;
  } catch {
    return null;
  }
}

/**
 * Proxies ws://localhost:5173/vm-vnc to the VM's password-protected VNC
 * websocket, adding the basic-auth header server-side so the password never
 * reaches the page. Only this app's own origin may connect; without that check
 * any website open in the browser could drive the VM through localhost.
 */
function vmVncProxy(): Plugin {
  return {
    name: 'vm-vnc-proxy',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (new URL(req.url ?? '/', 'http://x').pathname !== '/vm-vnc') return;
        const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);

        if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) return refuse('403 Forbidden');
        const credentials = readVmCredentials();
        if (!credentials) return refuse('503 Service Unavailable');

        const headers = { ...req.headers };
        delete headers.cookie;
        const upstream = request({
          host: VM_VNC.host,
          port: VM_VNC.port,
          path: VM_VNC.path,
          headers: {
            ...headers,
            host: `${VM_VNC.host}:${VM_VNC.port}`,
            origin: `http://${VM_VNC.host}:${VM_VNC.port}`,
            authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
          },
        });

        upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
          const lines = [`HTTP/1.1 101 ${res.statusMessage ?? 'Switching Protocols'}`];
          for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
          socket.write(lines.join('\r\n') + '\r\n\r\n');
          if (upstreamHead.length) socket.write(upstreamHead);
          if (head.length) upstreamSocket.write(head);
          upstreamSocket.pipe(socket).pipe(upstreamSocket);
          const close = () => {
            socket.destroy();
            upstreamSocket.destroy();
          };
          socket.on('error', close).on('close', close);
          upstreamSocket.on('error', close).on('close', close);
        });
        // A plain HTTP response means the VM refused the upgrade (e.g. 401).
        upstream.on('response', (res) => {
          res.resume();
          refuse(`${res.statusCode ?? 502} ${res.statusMessage ?? 'Bad Gateway'}`);
        });
        upstream.on('error', () => refuse('502 Bad Gateway'));
        socket.on('error', () => upstream.destroy());
        upstream.end();
      });
    },
  };
}

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const canRun = (program: string) => isInstalled(program, executable);

/**
 * GET /api/apps lists the launcher's apps; POST /api/launch {"id": "..."}
 * starts one. Only ids from server/apps.ts can run, each as a fixed argv with
 * no shell, and only for this app's own origin with a JSON body (which a
 * cross-site form post can't send without the Origin check catching it).
 */
function appLauncher(): Plugin {
  const lastLaunch = new Map<string, number>();
  // Re-checked per request, so installing an app makes it appear without a restart.
  const installedApps = () => LAUNCHER_APPS.filter((app) => canRun(app.requires));
  return {
    name: 'app-launcher',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/apps', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(installedApps().map(({ id, name }) => ({ id, name }))));
      });
      server.middlewares.use('/api/launch', (req, res) => {
        const reply = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return reply(405, { error: 'POST only' });
        if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) return reply(403, { error: 'Forbidden origin' });
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON only' });

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk;
          if (body.length > 1024) req.destroy();
        });
        req.on('end', () => {
          let id: unknown;
          let onPanel: unknown = false;
          try {
            ({ id, onPanel = false } = JSON.parse(body));
          } catch {
            return reply(400, { error: 'Bad JSON' });
          }
          const app = installedApps().find((a) => a.id === id);
          if (!app) return reply(404, { error: 'Unknown or not installed' });
          // Swallow double taps so one press opens one window.
          const now = Date.now();
          if (now - (lastLaunch.get(app.id) ?? 0) < 1500) return reply(200, { launched: app.name, deduplicated: true });
          lastLaunch.set(app.id, now);

          // With the Hyprland panel open, start it there so it shows up in the scene.
          if (onPanel === true) {
            launchOnPanel(app.command).then(
              (launched) => (launched ? reply(200, { launched: app.name, onPanel: true }) : reply(409, { error: 'The Hyprland panel is not open' })),
              (error: Error) => reply(500, { error: error.message }),
            );
            return;
          }
          const child = spawn(app.command[0], app.command.slice(1), { detached: true, stdio: 'ignore' });
          child.once('error', (error) => server.config.logger.error(`[launcher] ${app.name}: ${error.message}`));
          child.once('spawn', () => {
            child.unref();
            reply(200, { launched: app.name });
          });
          child.once('error', () => res.writableEnded || reply(500, { error: `Could not start ${app.name}` }));
        });
      });
    },
  };
}

export default defineConfig({
  // Emulates a Quest 3 on localhost so the XR session runs on a plain
  // Hyprland desktop; a real headset skips the emulator via its user agent.
  plugins: [iwsdkDev({ emulator: { device: 'metaQuest3' }, https: false }), vmVncProxy(), appLauncher(), hyprlandDesktop(ALLOWED_ORIGINS, canRun)],
  server: { host: '127.0.0.1', port: PORT, strictPort: true, open: false },
  build: { outDir: 'dist', target: 'esnext' },
  // noVNC uses top-level await, so dependencies must target esnext too.
  esbuild: { target: 'esnext' },
  // Keep a single copy of three/uikit so IWSDK's instanceof checks hold.
  resolve: { dedupe: ['three', '@pmndrs/uikit'] },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: ['three', '@pmndrs/uikit', '@novnc/novnc'],
    esbuildOptions: { target: 'esnext' },
  },
});
