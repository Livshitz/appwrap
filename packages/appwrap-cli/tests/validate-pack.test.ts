import { describe, expect, test, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validatePack, assertValidPack } from '../src/testing';

const DEMO_PACK = resolve(import.meta.dir, 'fixtures/demo-pack');
const EXAMPLE_PACK = resolve(import.meta.dir, '../../../examples/custom-module-pack');

const tmpDirs: string[] = [];
/** Make a throwaway pack dir with the given files; auto-cleaned afterAll. `files` maps rel path → body. */
function makePack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'appwrap-pack-'));
  tmpDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const VALID_MANIFEST = (name = 'x') =>
  `const pack = { manifestSchemaVersion: 1, modules: [{ name: '${name}', group: '${name}', ` +
  `capabilities: { ${name}: { ios: true, android: true } }, handler: { file: './handler.ts', fn: 'reg' } }] };\n` +
  `export default pack;\n`;
const VALID_HANDLER = `import { bridge } from '@livx.cc/appwrap/runtime/app/shell/bridge';\nexport function reg() { bridge.register('x.ping', () => ({ ok: true })); }\n`;

describe('validatePack — passing packs', () => {
  test('demo-pack fixture is conformant', async () => {
    const res = await validatePack(DEMO_PACK);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test('custom-module-pack example is conformant', async () => {
    const res = await validatePack(EXAMPLE_PACK);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test('assertValidPack does not throw on a valid pack', async () => {
    await expect(assertValidPack(EXAMPLE_PACK)).resolves.toBeUndefined();
  });
});

describe('validatePack — failing packs', () => {
  test('(a) missing manifest.ts', async () => {
    const dir = makePack({ 'handler.ts': VALID_HANDLER });
    const res = await validatePack(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('manifest.ts');
  });

  test('(b) wrong manifestSchemaVersion', async () => {
    const dir = makePack({
      'manifest.ts': `export default { manifestSchemaVersion: 99, modules: [{ name: 'x', group: 'x', capabilities: { x: 'native' } }] };\n`,
    });
    const res = await validatePack(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('manifestSchemaVersion 99');
  });

  test('(c) handler.file does not exist', async () => {
    const dir = makePack({ 'manifest.ts': VALID_MANIFEST() });
    const res = await validatePack(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('does not exist');
  });

  test('(d) handler imports an illegal ../ path escaping the pack', async () => {
    const dir = makePack({
      'manifest.ts': VALID_MANIFEST(),
      'handler.ts': `import { secret } from '../../../src/packs';\nexport function reg() { void secret; }\n`,
    });
    const res = await validatePack(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('escapes the pack directory');
  });

  test('assertValidPack throws with the joined errors', async () => {
    const dir = makePack({ 'manifest.ts': VALID_MANIFEST() });
    await expect(assertValidPack(dir)).rejects.toThrow('does not exist');
  });
});
