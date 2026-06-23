import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isFrameworkRepo } from '../src/cli';

describe('isFrameworkRepo (CI scaffold guard)', () => {
  test('true when the root carries the appwrap framework source (in-repo example)', () => {
    const root = mkdtempSync(join(tmpdir(), 'fw-'));
    try {
      mkdirSync(join(root, 'packages/appwrap-cli/src'), { recursive: true });
      writeFileSync(join(root, 'packages/appwrap-cli/src/cli.ts'), '// marker');
      expect(isFrameworkRepo(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('false for an external consumer project (no framework source) → workflows DO scaffold', () => {
    const root = mkdtempSync(join(tmpdir(), 'consumer-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      expect(isFrameworkRepo(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
