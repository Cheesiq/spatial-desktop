import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig, type Plugin } from 'vite';
import { attachFeatures } from './server/features.js';

const PORT = 5173;

/**
 * Mounts the app's server features (server/features.ts) on the dev server.
 * The desktop app mounts the same features on its own server (server/main.ts).
 */
function spatialServer(): Plugin {
  return {
    name: 'spatial-desktop-server',
    apply: 'serve',
    configureServer(server) {
      const hyprland = attachFeatures({
        use: (path, handler) => server.middlewares.use(path, handler),
        onUpgrade: (path, handler) =>
          server.httpServer?.on('upgrade', (req, socket, head) => {
            if (new URL(req.url ?? '/', 'http://x').pathname === path) handler(req, socket, head);
          }),
        log: { warn: (message) => server.config.logger.warn(message), error: (message) => server.config.logger.error(message) },
        origins: new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]),
      });
      // Vite restarts the server in-process when its config changes; the new
      // instance starts its own wayvnc, and the virtual monitor carries over.
      server.httpServer?.once('close', () => hyprland?.close());
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so one build works from any path: the desktop app's
  // server, the Android app's WebView, and GitHub Pages under /spatial-desktop/app/.
  base: './',
  // Emulates a Quest 3 on localhost so the XR session runs on a plain
  // Hyprland desktop; a real headset skips the emulator via its user agent.
  plugins: [iwsdkDev({ emulator: { device: 'metaQuest3' }, https: false }), spatialServer()],
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
