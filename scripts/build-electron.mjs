// Bundles the Electron main and preload scripts with esbuild.
// npm dependencies stay external (electron-builder ships node_modules), which also
// keeps the native better-sqlite3 module loadable.
import { context, build } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  external: ['electron'],
  logLevel: 'info',
};
const configs = [
  { ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' },
  // Sandboxed preloads must be a single CommonJS file that only requires 'electron'.
  { ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', packages: undefined },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
