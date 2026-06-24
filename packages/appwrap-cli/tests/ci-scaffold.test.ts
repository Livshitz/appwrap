import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isFrameworkRepo } from '../src/cli';

// Resolve the template Fastfile both in the monorepo and a published tarball layout.
function fastfileTemplate(): string {
  const a = join(import.meta.dir, '../../../templates/ci/fastlane/Fastfile');
  const b = join(import.meta.dir, '../templates/ci/fastlane/Fastfile');
  return existsSync(a) ? a : b;
}

describe('iOS release lane (single source of truth)', () => {
  const fastfile = readFileSync(fastfileTemplate(), 'utf8');

  test('lane :beta is the one release recipe (prepare → sign → build → upload)', () => {
    expect(fastfile).toContain('lane :beta');
    expect(fastfile).toContain('upload_to_testflight');
    expect(fastfile).toContain('appwrap_prepare_ios'); // ns prepare goes through the env-sanitizing wrapper
  });

  test('appwrap_prepare_ios strips the leaked gem env only for the system Ruby 2.6 pod', () => {
    // The CocoaPods-under-fastlane fix: GEM_HOME/GEM_PATH leak breaks the system pod; we clear them,
    // but ONLY when the active pod is the 2.6-pinned system one (CI ruby is left untouched).
    expect(fastfile).toContain('Ruby.framework/Versions/2.6');
    expect(fastfile).toMatch(/ENV\.delete/);
    expect(fastfile).toContain('GEM_HOME');
  });
});

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
