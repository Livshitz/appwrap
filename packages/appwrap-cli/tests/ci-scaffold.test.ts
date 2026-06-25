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

  test('lane :release promotes the binary to the App Store (production), headless + safe', () => {
    expect(fastfile).toContain('lane :release');
    expect(fastfile).toContain('upload_to_app_store');
    // Safe-by-default: no review submit / metadata / screenshots push unless env opts in.
    expect(fastfile).toContain('APPWRAP_SUBMIT_FOR_REVIEW');
    expect(fastfile).toContain('skip_metadata: true');
    expect(fastfile).toContain('skip_screenshots: true');
    expect(fastfile).toContain('force: true'); // headless (no HTML preview)
  });

  test(':beta and :release share ONE archive/sign helper (no duplicated build block)', () => {
    expect(fastfile).toContain('def appwrap_archive_and_sign_ios');
    // The signing/build verbs live in the helper exactly once, not inlined per lane.
    expect(fastfile.match(/build_app\(/g)?.length).toBe(1);
    expect(fastfile.match(/appwrap_archive_and_sign_ios/g)?.length).toBe(3); // def + 2 lane calls
  });

  test('appwrap_prepare_ios strips the leaked gem env only for the system Ruby 2.6 pod', () => {
    // The CocoaPods-under-fastlane fix: GEM_HOME/GEM_PATH leak breaks the system pod; we clear them,
    // but ONLY when the active pod is the 2.6-pinned system one (CI ruby is left untouched).
    expect(fastfile).toContain('Ruby.framework/Versions/2.6');
    expect(fastfile).toMatch(/ENV\.delete/);
    expect(fastfile).toContain('GEM_HOME');
  });
});

describe('submit ios CLI command (App Store production promote)', () => {
  const cliSrc = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf8');

  test('`submit` is registered in the dispatcher and routes to the :release lane', () => {
    expect(cliSrc).toContain("case 'submit':");
    expect(cliSrc).toMatch(/release\(cwd, flags, positionals, 'release'\)/);
  });

  test('`release` still routes to the :beta lane (unchanged TestFlight path)', () => {
    expect(cliSrc).toMatch(/release\(cwd, flags, positionals, 'beta'\)/);
  });

  test('--submit-for-review maps to APPWRAP_SUBMIT_FOR_REVIEW for the child lane', () => {
    expect(cliSrc).toContain("'submit-for-review' in flags");
    expect(cliSrc).toContain('APPWRAP_SUBMIT_FOR_REVIEW');
  });

  test('submit ios is listed in the usage/help text', () => {
    expect(cliSrc).toContain('submit ios');
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
