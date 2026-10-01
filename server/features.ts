import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { isInstalled, LAUNCHER_APPS } from './apps.js';
import { attachClaude } from './claude.js';
import { type Host, reply } from './host.js';
import { attachHyprland, type HyprlandDesktop, launchOnPanel } from './hyprland.js';

/**
 * The VMs, each a dockur container serving noVNC's websockify behind basic
 * auth: Omarchy's Windows VM, and the macOS VM from ~/.local/bin/macos-vm.
 * A VM counts as set up once its private (0600) credentials file exists.
 */
const VMS = {
  windows: { route: '/vm-vnc', port: 8006, credentials: `${homedir()}/.config/windows/credentials` },
  macos: { route: '/macos-vnc', port: 8007, credentials: `${homedir()}/.config/macos/credentials` },
} as const;
type Vm = (typeof VMS)[keyof typeof VMS];
const VM_HOST = '127.0.0.1';
const VM_PATH = '/websockify';

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
export const canRun = (program: string) => isInstalled(program, executable);

/** What this machine can do, so the page only offers what works here. */
export interface Capabilities {
  platform: NodeJS.Platform;
  hyprland: boolean;
  search: boolean;
  windowsVm: boolean;
  macosVm: boolean;
  launcher: boolean;
  /** Claude Code and tmux, for Claude workers. */
  claude: boolean;
  /** voxtype, for dictating into Claude workers. */
  dictation: boolean;
}

function capabilities(hyprland: boolean): Capabilities {
  return {
    platform: process.platform,
    hyprland,
    search: hyprland && canRun('omarchy-menu'),
    windowsVm: existsSync(VMS.windows.credentials),
    macosVm: existsSync(VMS.macos.credentials),
    launcher: LAUNCHER_APPS.some((app) => canRun(app.requires)),
    claude: canRun('claude') && canRun('tmux'),
    dictation: canRun('claude') && canRun('tmux') && canRun('voxtype'),
  };
}

/** USERNAME/PASSWORD from a VM's private (0600) credentials file. */
function readVmCredentials(vm: Vm): { username: string; password: string } | null {
  try {
    const fields = Object.fromEntries(
      readFileSync(vm.credentials, 'utf8')
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return fields.USERNAME && fields.PASSWORD ? { username: fields.USERNAME, password: fields.PASSWORD } : null;
  } catch {
    return null;
  }
}

/**
 * Proxies ws://<host><route> to the VM's password-protected VNC websocket,
 * adding the basic-auth header server-side so the password never reaches the
 * page. Only this app's own origin may connect; without that check any
 * website open in the browser could drive the VM through localhost.
 */
function attachVmProxy(host: Host, vm: Vm): void {
  host.onUpgrade(vm.route, (req, socket, head) => {
    const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);

    if (!host.origins.has(req.headers.origin ?? '')) return refuse('403 Forbidden');
    const credentials = readVmCredentials(vm);
    if (!credentials) return refuse('503 Service Unavailable');

    const headers = { ...req.headers };
    delete headers.cookie;
    const upstream = request({
      host: VM_HOST,
      port: vm.port,
      path: VM_PATH,
      headers: {
        ...headers,
        host: `${VM_HOST}:${vm.port}`,
        origin: `http://${VM_HOST}:${vm.port}`,
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
}

/**
 * GET /api/apps lists the launcher's apps; POST /api/launch {"id": "..."}
 * starts one. Only ids from server/apps.ts can run, each as a fixed argv with
 * no shell, and only for this app's own origin with a JSON body (which a
 * cross-site form post can't send without the Origin check catching it).
 */
function attachLauncher(host: Host): void {
  const lastLaunch = new Map<string, number>();
  // Re-checked per request, so installing an app makes it appear without a restart.
  const installedApps = () => LAUNCHER_APPS.filter((app) => canRun(app.requires));
  host.use('/api/apps', (req, res) => reply(res, 200, installedApps().map(({ id, name }) => ({ id, name }))));
  host.use('/api/launch', (req, res) => {
    if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
    if (!host.origins.has(req.headers.origin ?? '')) return reply(res, 403, { error: 'Forbidden origin' });
    if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'JSON only' });

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
        return reply(res, 400, { error: 'Bad JSON' });
      }
      const app = installedApps().find((a) => a.id === id);
      if (!app) return reply(res, 404, { error: 'Unknown or not installed' });
      // Swallow double taps so one press opens one window.
      const now = Date.now();
      if (now - (lastLaunch.get(app.id) ?? 0) < 1500) return reply(res, 200, { launched: app.name, deduplicated: true });
      lastLaunch.set(app.id, now);

      // With the Hyprland panel open, start it there so it shows up in the scene.
      if (onPanel === true) {
        launchOnPanel(app.command).then(
          (launched) =>
            launched
              ? reply(res, 200, { launched: app.name, onPanel: true })
              : reply(res, 409, { error: 'The Hyprland panel is not open' }),
          (error: Error) => reply(res, 500, { error: error.message }),
        );
        return;
      }
      const child = spawn(app.command[0], app.command.slice(1), { detached: true, stdio: 'ignore' });
      child.once('error', (error) => host.log.error(`[launcher] ${app.name}: ${error.message}`));
      child.once('spawn', () => {
        child.unref();
        reply(res, 200, { launched: app.name });
      });
      child.once('error', () => res.writableEnded || reply(res, 500, { error: `Could not start ${app.name}` }));
    });
  });
}

/**
 * Mount everything the page talks to: capabilities, the app launcher, the
 * VM proxies, Claude workers and the Hyprland panel. Returns the Hyprland panel's
 * lifecycle (null outside a Hyprland session).
 */
export function attachFeatures(host: Host): HyprlandDesktop | null {
  const hyprland = attachHyprland(host, canRun);
  host.use('/api/capabilities', (req, res) => reply(res, 200, capabilities(hyprland != null)));
  attachLauncher(host);
  attachClaude(host, canRun);
  for (const vm of Object.values(VMS)) attachVmProxy(host, vm);
  return hyprland;
}
