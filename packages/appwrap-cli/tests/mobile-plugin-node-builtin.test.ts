import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { regenerateMobilePlugins } from '../src/cli';
import type { AppwrapConfig } from '../src/config';

// The mobile lane skips a plugin that pulls in a Node.js CORE module (unavailable in NativeScript), so a
// shared `plugins:[]` list builds on both lanes. The skip decision must scan the plugin's authored SOURCE
// (via Bun.Transpiler.scanImports), NOT the emitted bundle's raw text — otherwise it false-positives on a
// builtin specifier sitting inside a STRING LITERAL, or on bun's injected `createRequire from "node:module"`
// interop shim for a CJS plugin. This test locks both the retained false-negative coverage (real builtin
// imports still skipped) and the fixed false-positives (pure-handler + @nativescript/core plugins build).

const bundleId = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Run regenerateMobilePlugins over one fixture file and report whether its bundle was emitted (built)
 * or skipped-with-warning. */
function runOne(label: string, filename: string, source: string): { built: boolean } {
  const cwd = resolve(import.meta.dir, `../../../.tmp/mobile-builtin-check/${label}`);
  const outDir = join(cwd, 'native');
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(outDir, 'app/shell'), { recursive: true });
  writeFileSync(join(cwd, filename), source);
  const cfg = { id: 'x', name: 'X', version: '1.0.0', pwaDist: 'dist', plugins: [`./${filename}`] } as unknown as AppwrapConfig;
  regenerateMobilePlugins(cwd, cfg, outDir);
  const built = existsSync(join(outDir, 'app/shell/plugins', `${bundleId(`./${filename}`)}.js`));
  rmSync(cwd, { recursive: true, force: true });
  return { built };
}

// --- Retained false-negative coverage: real builtin imports/requires stay SKIPPED (never built). ---
const skipCases: Array<[string, string, string]> = [
  ['import_net', 'net.ts', `import net from 'net';\nexport default { name: 'p', handlers: { f: () => !!net } };`],
  ['import_named_net', 'named.ts', `import { createConnection } from 'net';\nexport default { name: 'p', handlers: { f: () => !!createConnection } };`],
  ['import_node_net', 'nodenet.ts', `import net from 'node:net';\nexport default { name: 'p', handlers: { f: () => !!net } };`],
  ['import_fs_promises', 'fsprom.ts', `import { readFile } from 'fs/promises';\nexport default { name: 'p', handlers: { f: () => !!readFile } };`],
  ['require_net', 'reqnet.js', `const net = require('net');\nmodule.exports = { name: 'p', handlers: { f: () => !!net } };`],
  ['require_node_fs', 'reqnodefs.js', `const fs = require('node:fs');\nmodule.exports = { name: 'p', handlers: { f: () => !!fs } };`],
];
for (const [label, file, src] of skipCases) {
  test(`SKIP (desktop-only): ${label} is not built`, () => {
    expect(runOne(label, file, src).built).toBe(false);
  });
}

// --- Fixed false-positives: these must BUILD (no longer skipped). ---
test('BUILD: pure-handler plugin whose body contains the STRING "x from \'fs\'"', () => {
  const src = `export default { name: 'p', handlers: { f: () => "x from 'fs'" } };`;
  expect(runOne('fp_string', 'fpstr.ts', src).built).toBe(true);
});

test('BUILD: pure-handler plugin whose body contains the STRING "require(\'net\')"', () => {
  const src = `export default { name: 'p', handlers: { f: () => "call require('net') here" } };`;
  expect(runOne('fp_reqstr', 'fpreq.ts', src).built).toBe(true);
});

test('BUILD: ESM plugin importing the external @nativescript/core', () => {
  const src = `import { Http } from '@nativescript/core';\nexport default { name: 'p', handlers: { f: () => !!Http } };`;
  expect(runOne('ok_nscore_esm', 'nscore.ts', src).built).toBe(true);
});

test('BUILD: CJS plugin requiring the external @nativescript/core (bun injects node:module shim)', () => {
  const src = `const { Http } = require('@nativescript/core');\nmodule.exports = { name: 'p', handlers: { f: () => !!Http } };`;
  expect(runOne('ok_nscore_cjs', 'nscore.js', src).built).toBe(true);
});
