// Spatial Desktop's desktop app: runs the production server (dist-server/)
// on a free localhost port and opens the app in a window. On Linux with
// Hyprland every feature works; elsewhere the page offers what the machine
// supports (see src/capabilities.ts).
import { app, BrowserWindow, desktopCapturer, Menu, session, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUpdates } from './updates.mjs';

const here = dirname(fileURLToPath(import.meta.url));

if (process.platform === 'linux') {
  // Native Wayland where available, with screen capture through PipeWire and
  // xdg-desktop-portal (Hyprland's window picker).
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('Spatial Desktop');

/** @type {{ url: string, close(): Promise<void> } | null} */
let server = null;

/**
 * Answer the page's getDisplayMedia(). On Wayland the portal has already
 * shown Hyprland's picker and returns the one chosen source; elsewhere show
 * our own picker of windows and screens.
 */
async function pickSource(_request, callback) {
  try {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } });
    if (sources.length <= 1) return callback(sources[0] ? { video: sources[0] } : {});
    const chosen = await showPicker(sources);
    callback(chosen ? { video: chosen } : {});
  } catch (error) {
    console.error('[capture]', error);
    callback({});
  }
}

/** A small window of thumbnails; resolves with the clicked source, or null. */
function showPicker(sources) {
  const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const items = sources
    .map(
      (source, i) => `<a href="#pick-${i}" title="${escape(source.name)}">
        <img src="${source.thumbnail.toDataURL()}" alt=""><span>${escape(source.name)}</span></a>`,
    )
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Choose a window</title>
    <style>
      body { margin: 0; padding: 20px; background: #141218; color: #e6e0e9; font: 14px system-ui, sans-serif; }
      h1 { font-size: 18px; font-weight: 500; margin: 0 0 16px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
      a { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 16px; background: #211f26;
          color: inherit; text-decoration: none; border: 2px solid transparent; }
      a:hover, a:focus { border-color: #d0bcff; outline: none; }
      img { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #000; border-radius: 10px; }
      span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    </style>
    <h1>Choose a window or screen to bring into Spatial Desktop</h1><div class="grid">${items}</div>`;

  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 900,
      height: 620,
      title: 'Choose a window',
      backgroundColor: '#141218',
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
    });
    let chosen = null;
    // The page runs no script: a click moves to #pick-<index>, noticed here.
    picker.webContents.on('did-navigate-in-page', (_event, url) => {
      const match = /#pick-(\d+)$/.exec(url);
      if (!match) return;
      chosen = sources[Number(match[1])] ?? null;
      picker.close();
    });
    picker.webContents.on('will-navigate', (event) => event.preventDefault());
    picker.on('closed', () => resolve(chosen));
    void picker.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Spatial Desktop',
    backgroundColor: '#05060c',
    autoHideMenuBar: true,
    icon: join(here, '..', 'build', 'icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  // Links out of the app open in the default browser; the window stays on the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!server || !url.startsWith(server.url)) event.preventDefault();
  });
  await window.loadURL(server.url);
}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const { startServer } = await import('../dist-server/main.mjs');
  server = await startServer({ root: join(here, '..', 'dist') });
  session.defaultSession.setDisplayMediaRequestHandler(pickSource, { useSystemPicker: true });
  await createWindow();
  startUpdates();
  app.on('activate', () => BrowserWindow.getAllWindows().length || void createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Stop the server first, which also removes the Hyprland panel's virtual monitor.
app.on('before-quit', (event) => {
  if (!server) return;
  event.preventDefault();
  const running = server;
  server = null;
  running.close().finally(() => app.quit());
});
