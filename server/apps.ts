/**
 * The only programs the in-VR launcher can start. The page sends an `id`;
 * the command lives here, server-side, and runs without a shell. Adding an app
 * means adding an entry here.
 */
export interface LauncherApp {
  id: string;
  name: string;
  /** argv for spawn(); argv[0] must be on PATH. */
  command: readonly string[];
  /**
   * Program that must already be installed. Some Omarchy launchers install a
   * missing app instead (e.g. Spotify asks for sudo), which a launcher tile
   * must never trigger, so apps without it are hidden and refused.
   */
  requires: string;
}

export const LAUNCHER_APPS: readonly LauncherApp[] = [
  { id: 'terminal', name: 'Terminal', command: ['omarchy-launch-terminal'], requires: 'xdg-terminal-exec' },
  { id: 'browser', name: 'Browser', command: ['omarchy-launch-browser'], requires: 'xdg-settings' },
  { id: 'files', name: 'Files', command: ['omarchy-launch-nautilus'], requires: 'nautilus' },
  { id: 'editor', name: 'Editor', command: ['omarchy-launch-editor'], requires: 'omarchy-launch-editor' },
  { id: 'spotify', name: 'Spotify', command: ['omarchy-launch-spotify'], requires: '/usr/bin/spotify' },
  { id: 'activity', name: 'Activity', command: ['omarchy-launch-tui', 'btop'], requires: 'btop' },
];

/** True if `program` (a name on PATH, or an absolute path) is an executable. */
export function isInstalled(program: string, access: (path: string) => boolean): boolean {
  if (program.startsWith('/')) return access(program);
  return (process.env.PATH ?? '').split(':').some((dir) => dir && access(`${dir}/${program}`));
}
