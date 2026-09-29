// Bundles the production server (server/main.ts and everything it uses,
// including ws) into dist-server/main.mjs, so the desktop app ships no
// node_modules. Run by `npm run build`.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/main.ts'],
  outfile: 'dist-server/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ws loads these native speed-ups only if they're installed.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS; give the ESM bundle a `require` for its Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
