// Keeps the desktop app up to date from GitHub Releases.
//
// Windows, the AppImage and the .deb update themselves with electron-updater:
// a check at launch and every few hours, a background download, and the
// install when the app quits (or right away, from the notification). The
// release workflow publishes the latest*.yml manifests and blockmaps it reads.
//
// macOS builds aren't code-signed, and macOS won't apply an unsigned update,
// so there the app only checks and points to the download page.
import { app, net, Notification, shell } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
const REPO = 'Cheesiq/spatial-desktop';
const DOWNLOAD_PAGE = 'https://cheesiq.github.io/spatial-desktop/';
const EVERY = 6 * 60 * 60 * 1000;

/** True when `latest` (e.g. "1.3.0") is a newer version than `current`. */
export function isNewer(latest, current) {
  const parse = (v) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  if (onClick) notification.on('click', onClick);
  notification.show();
}

function selfUpdating() {
  // Another update server (a mirror, or a local one for testing a release before publishing it).
  if (process.env.SPATIAL_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.SPATIAL_UPDATE_URL });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => console.log('[update]', m), warn: (m) => console.warn('[update]', m), error: (m) => console.error('[update]', m), debug() {} };
  autoUpdater.on('update-downloaded', ({ version }) => {
    notify(
      `Spatial Desktop ${version} is ready`,
      'It installs when you quit the app. Click to restart and update now.',
      () => autoUpdater.quitAndInstall(),
    );
  });
  // Offline, rate-limited or a release still uploading: try again next time.
  autoUpdater.on('error', (error) => console.warn('[update]', error?.message ?? error));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  void check();
  setInterval(check, EVERY);
}

function checkOnly() {
  let told = '';
  const check = async () => {
    try {
      const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) return;
      const { tag_name: tag } = await response.json();
      if (!tag || tag === told || !isNewer(tag, app.getVersion())) return;
      told = tag;
      notify(`Spatial Desktop ${tag.replace(/^v/, '')} is available`, 'Click to open the download page.', () => void shell.openExternal(DOWNLOAD_PAGE));
    } catch {
      // Offline; try again next time.
    }
  };
  void check();
  setInterval(check, EVERY);
}

/** Start checking for updates. Does nothing when running from source or with SPATIAL_NO_UPDATES set. */
export function startUpdates() {
  if (!app.isPackaged || process.env.SPATIAL_NO_UPDATES) return;
  if (process.platform === 'darwin') return checkOnly();
  selfUpdating();
}
