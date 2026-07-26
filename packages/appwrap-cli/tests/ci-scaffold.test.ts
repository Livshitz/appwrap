import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ciRenderContext, isFrameworkRepo, renderCiWorkflow, type CiRenderContext } from '../src/cli';
import type { AppwrapConfig } from '../src/config';

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

  test('all lanes share ONE archive/sign helper (no duplicated build block)', () => {
    expect(fastfile).toContain('def appwrap_archive_and_sign_ios');
    // The signing/build verbs live in the helper exactly once, not inlined per lane.
    expect(fastfile.match(/build_app\(/g)?.length).toBe(1);
    // def + one call per iOS lane (:beta, :build, :release) — every iOS lane goes through the
    // helper, none inlines its own archive/sign block. (Android lanes don't build iOS binaries.)
    const iosBlock = fastfile.slice(fastfile.indexOf('platform :ios'), fastfile.indexOf('platform :android'));
    const iosLaneCount = iosBlock.match(/^\s*lane :/gm)?.length ?? 0;
    expect(iosLaneCount).toBeGreaterThanOrEqual(3);
    expect(fastfile.match(/appwrap_archive_and_sign_ios/g)?.length).toBe(1 + iosLaneCount);
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

// Resolve a workflow template both in the monorepo and a published tarball layout.
function workflowTemplate(name: string): string {
  const a = join(import.meta.dir, '../../../templates/ci/github/workflows', name);
  const b = join(import.meta.dir, '../templates/ci/github/workflows', name);
  return readFileSync(existsSync(a) ? a : b, 'utf8');
}

const ROOT_WEB: CiRenderContext = { subdir: '', tagPrefix: 'v', webBuild: true };
const MONO_SERVER: CiRenderContext = { subdir: 'app', tagPrefix: 'app-v', webBuild: false };
const WORKFLOWS = ['appwrap-pr.yml', 'appwrap-release-ios.yml', 'appwrap-release-android.yml'];

describe('ciRenderContext (repo-shape detection)', () => {
  const cfg = (extra: Partial<AppwrapConfig> = {}): AppwrapConfig =>
    ({ id: 'cc.x.y', name: 'X', version: '1.0.0', pwaDist: 'dist', ...extra }) as AppwrapConfig;

  test('app at repo root → no subdir, v* tags, web build on', () => {
    expect(ciRenderContext('/r', '/r', cfg())).toEqual({ subdir: '', tagPrefix: 'v', webBuild: true });
  });

  test('monorepo subdir → scoped, safe <subdir>-v tag prefix, server loader drops web build', () => {
    expect(ciRenderContext('/r/app', '/r', cfg({ loader: 'server' }))).toEqual(MONO_SERVER);
  });

  test('nested subdir uses the LAST segment for the tag prefix (tags are flat names)', () => {
    const ctx = ciRenderContext('/r/apps/foo', '/r', cfg());
    expect(ctx.subdir).toBe('apps/foo');
    expect(ctx.tagPrefix).toBe('foo-v');
  });

  test('config ci.tagPrefix overrides the derived default', () => {
    expect(ciRenderContext('/r/app', '/r', cfg({ ci: { tagPrefix: 'copybin-v' } })).tagPrefix).toBe('copybin-v');
  });
});

describe('renderCiWorkflow (repo-shape substitutions)', () => {
  test('no directive or token survives rendering, in either shape', () => {
    for (const name of WORKFLOWS) {
      for (const ctx of [ROOT_WEB, MONO_SERVER]) {
        const out = renderCiWorkflow(workflowTemplate(name), ctx);
        expect(out).not.toContain('#@');
        expect(out).not.toContain('__DIR__');
        expect(out).not.toContain('__APP_DIR__');
        expect(out).not.toContain('__TAG_PREFIX__');
      }
    }
  });

  test('malformed block directives fail loud (not silent mis-render)', () => {
    expect(() => renderCiWorkflow('#@if:root\n#@if:web\nx\n#@end\n#@end', MONO_SERVER)).toThrow(/nested/);
    expect(() => renderCiWorkflow('#@if:web\nx\n', ROOT_WEB)).toThrow(/unterminated/);
  });

  test('root+web PR: web job with build, no paths filter, no working-directory scoping', () => {
    const out = renderCiWorkflow(workflowTemplate('appwrap-pr.yml'), ROOT_WEB);
    expect(out).toContain('  web:');
    expect(out).toContain('needs: web');
    expect(out).toContain('bun run build');
    expect(out).not.toContain('paths:');
    expect(out).not.toContain('working-directory: app');
    expect(out).toContain('working-directory: native'); // __DIR__native at root
  });

  test('monorepo+server PR: path-filtered to the subdir, no web job, steps scoped to app/', () => {
    const out = renderCiWorkflow(workflowTemplate('appwrap-pr.yml'), MONO_SERVER);
    expect(out).toContain("- 'app/**'");
    expect(out).toContain("- '.github/workflows/appwrap-pr.yml'");
    expect(out).not.toContain('  web:');
    expect(out).not.toContain('needs: web');
    expect(out).not.toContain('bun run build');
    expect(out).toContain('working-directory: app');
    expect(out).toContain('working-directory: app/native');
  });

  test('release tag triggers: v* at root, app-v* in the monorepo (web tags cannot cut a store release)', () => {
    for (const name of ['appwrap-release-ios.yml', 'appwrap-release-android.yml']) {
      expect(renderCiWorkflow(workflowTemplate(name), ROOT_WEB)).toContain("tags: ['v*']");
      const mono = renderCiWorkflow(workflowTemplate(name), MONO_SERVER);
      expect(mono).toContain("tags: ['app-v*']");
      expect(mono).not.toContain("tags: ['v*']");
    }
  });

  test('monorepo release: install/init/release steps scoped to app/, artifact + gradle key paths prefixed', () => {
    const ios = renderCiWorkflow(workflowTemplate('appwrap-release-ios.yml'), MONO_SERVER);
    expect(ios).toContain('working-directory: app');
    expect(ios).toContain('working-directory: app/native');
    expect(ios).not.toContain('bun run build'); // server loader
    const android = renderCiWorkflow(workflowTemplate('appwrap-release-android.yml'), MONO_SERVER);
    expect(android).toContain("hashFiles('app/bun.lock', 'app/package.json')");
    expect(android).toContain('path: app/native/platforms/android/app/build/outputs/bundle/release/app-release.aab');
  });

  test('android release carries the Play-SA graceful-degradation gate (green without the secret)', () => {
    for (const ctx of [ROOT_WEB, MONO_SERVER]) {
      const out = renderCiWorkflow(workflowTemplate('appwrap-release-android.yml'), ctx);
      expect(out).toContain('id: play-sa');
      expect(out).toContain("if: steps.play-sa.outputs.present == 'true'");
      expect(out).toContain('PLAY_SERVICE_ACCOUNT_JSON not set');
    }
  });

  test('the appwrap version pin placeholder is present in every workflow (stamped at emit)', () => {
    for (const name of WORKFLOWS) {
      expect(renderCiWorkflow(workflowTemplate(name), ROOT_WEB)).toContain('@livx.cc/appwrap@^__APPWRAP_VERSION__');
    }
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

  test('false for an external consumer project (no framework source) → workflows may scaffold with --ci', () => {
    const root = mkdtempSync(join(tmpdir(), 'consumer-'));
    try {
      writeFileSync(join(root, 'package.json'), '{}');
      expect(isFrameworkRepo(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
