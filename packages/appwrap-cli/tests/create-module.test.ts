import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validatePack } from '../src/testing';

const CLI = join(import.meta.dir, '../src/cli.ts');

describe('appwrap create-module', () => {
  test('scaffolds a token-substituted, pack-conformant module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'appwrap-cm-'));
    try {
      const r = spawnSync('bun', [CLI, 'create-module', 'sparkle'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      const pack = join(dir, 'sparkle');
      expect(existsSync(join(pack, 'manifest.ts'))).toBe(true);
      expect(existsSync(join(pack, 'native-src/sparkle'))).toBe(true); // token dir renamed
      const manifest = readFileSync(join(pack, 'manifest.ts'), 'utf8');
      expect(manifest).not.toContain('__MODULE_NAME__');
      expect(manifest).toContain("name: 'sparkle'");
      expect(readFileSync(join(pack, 'handler.ts'), 'utf8')).toContain('registerSparkleHandlers');
      // the scaffolded pack must itself validate
      const res = await validatePack(pack);
      expect(res).toEqual({ ok: true, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects an invalid module name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appwrap-cm-'));
    try {
      const r = spawnSync('bun', [CLI, 'create-module', '9bad-name'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
