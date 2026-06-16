#!/usr/bin/env node
// prepack: stage runtime/ + templates/ into the package so the published tarball is self-contained.
// The CLI resolves them at the package root (see resolveAssetRoot in src/cli.ts). Excludes build
// artifacts (node_modules, platforms, hooks, app/www) and OS cruft. Gitignored — tarball-only.
import { cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '../..');
const EXCLUDE = /(?:^|\/)(?:node_modules|platforms|hooks|app\/www|\.DS_Store)(?:\/|$)/;

for (const name of ['runtime', 'templates']) {
  const srcRoot = resolve(repoRoot, name);
  const dest = resolve(pkgDir, name);
  rmSync(dest, { recursive: true, force: true });
  // Match RELATIVE to srcRoot — testing the absolute path would wrongly exclude everything when the
  // repo is checked out under a path containing "node_modules"/"hooks" (e.g. some CI layouts).
  cpSync(srcRoot, dest, { recursive: true, filter: (src) => !EXCLUDE.test(src.slice(srcRoot.length)) });
  console.log(`staged ${name}/`);
}
