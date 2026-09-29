import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * What the app's server features need from whichever HTTP server hosts them:
 * Vite's dev server (vite.config.ts) or the production server (server/main.ts,
 * used by the desktop app).
 */
export interface Host {
  /** Handle requests whose path starts with `path`, connect-style. */
  use(path: string, handler: Handler): void;
  /** Handle websocket upgrades for exactly `path`. */
  onUpgrade(path: string, handler: UpgradeHandler): void;
  log: { warn(message: string): void; error(message: string): void };
  /**
   * Origins of this app's own pages. Everything that can touch the desktop
   * (the VM, the launcher, Hyprland) refuses other origins, so a website open
   * in any browser can't drive it through localhost.
   */
  origins: ReadonlySet<string>;
}

/** Reply with JSON. */
export function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
