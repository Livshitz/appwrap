import { cpSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const root = import.meta.dir;
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// ESM: the native shell serves the bundle via the app:// scheme handler
// (stable origin), so module scripts load fine — no IIFE workaround needed.
const result = await Bun.build({
  entrypoints: [join(root, 'src/main.ts')],
  outdir: dist,
  format: 'esm',
  minify: true,
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

cpSync(join(root, 'index.html'), join(dist, 'index.html'));
cpSync(join(root, 'public'), dist, { recursive: true });
console.log('hello-pwa → dist/ ✓');
