import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFingerprint, applyOverrides, decideIosBuildSkip, newestBuildInputMtime, stampShellConfig, type BuildCache } from '../src/cli';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'appwrap-regen-'));
}

describe('buildFingerprint includes app + override sources', () => {
  test('changes when an appwrap.overrides file changes', () => {
    const cwd = scratch();
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true });
      writeFileSync(join(cwd, 'dist', 'index.html'), '<html></html>');
      writeFileSync(join(cwd, 'appwrap.config.ts'), 'export default {}');
      const ovDir = join(cwd, 'appwrap.overrides', 'app');
      mkdirSync(ovDir, { recursive: true });
      const ovFile = join(ovDir, 'custom.ts');
      writeFileSync(ovFile, 'export const a = 1;');

      const fp1 = buildFingerprint(cwd, {});
      // Edit the override file. Set mtime explicitly a second ahead so the test doesn't race
      // sub-millisecond FS mtime granularity — a real edit always advances mtime.
      writeFileSync(ovFile, 'export const a = 2;');
      const t = new Date(Date.now() + 1000);
      utimesSync(ovFile, t, t);
      const fp2 = buildFingerprint(cwd, {});
      expect(fp2).not.toBe(fp1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('changes when an override file is added (new source)', () => {
    const cwd = scratch();
    try {
      mkdirSync(join(cwd, 'appwrap.overrides'), { recursive: true });
      writeFileSync(join(cwd, 'appwrap.config.ts'), 'export default {}');
      const fp1 = buildFingerprint(cwd, {});
      writeFileSync(join(cwd, 'appwrap.overrides', 'new.ts'), 'x');
      const fp2 = buildFingerprint(cwd, {});
      expect(fp2).not.toBe(fp1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// Regression: runtime/ is compiled straight into bundle.js, but was NOT fingerprinted — so editing it
// printed "Skipping build — inputs unchanged" and shipped an artifact carrying the PREVIOUS runtime.
// A silent stale build that reads as a pass. Both `deploy ios` and `deploy android` share this fn.
describe('buildFingerprint includes the appwrap runtime/ template', () => {
  const runtimeFile = resolve(import.meta.dir, '../../../runtime/app/shell/config.ts');

  test('changes when a runtime/ source file changes', () => {
    const cwd = scratch();
    const before = statSync(runtimeFile).mtime;
    try {
      writeFileSync(join(cwd, 'appwrap.config.ts'), 'export default {}');
      const fp1 = buildFingerprint(cwd, {});
      // Touch a real runtime source (mtime a second ahead — a real edit always advances mtime).
      const t = new Date(Date.now() + 1000);
      utimesSync(runtimeFile, t, t);
      expect(buildFingerprint(cwd, {})).not.toBe(fp1);
    } finally {
      utimesSync(runtimeFile, before, before); // restore — never leave the shared tree perturbed
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The control: the fix must not defeat the cache by always rebuilding.
  test('is stable across calls when nothing changed', () => {
    const cwd = scratch();
    try {
      writeFileSync(join(cwd, 'appwrap.config.ts'), 'export default {}');
      expect(buildFingerprint(cwd, {})).toBe(buildFingerprint(cwd, {}));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('applyOverrides prunes stale override files', () => {
  test('removes a file that no longer exists in the overrides source', () => {
    const cwd = scratch();
    const outDir = join(cwd, 'native');
    try {
      mkdirSync(outDir, { recursive: true });
      const ovDir = join(cwd, 'appwrap.overrides', 'app');
      mkdirSync(ovDir, { recursive: true });
      writeFileSync(join(ovDir, 'old.ts'), 'export const old = 1;');

      // First pass: copies old.ts + records the overrides manifest.
      applyOverrides(cwd, outDir, {} as any);
      expect(existsSync(join(outDir, 'app', 'old.ts'))).toBe(true);

      // Remove the source file (rename/relocate scenario) then re-sync.
      rmSync(join(ovDir, 'old.ts'));
      writeFileSync(join(ovDir, 'new.ts'), 'export const neu = 1;');
      applyOverrides(cwd, outDir, {} as any);

      // Stale copy pruned; the new one present.
      expect(existsSync(join(outDir, 'app', 'old.ts'))).toBe(false);
      expect(existsSync(join(outDir, 'app', 'new.ts'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('does not touch files absent from the prior manifest (user/other data)', () => {
    const cwd = scratch();
    const outDir = join(cwd, 'native');
    try {
      mkdirSync(join(outDir, 'platforms'), { recursive: true });
      writeFileSync(join(outDir, 'platforms', 'keep.txt'), 'user build output');
      mkdirSync(join(cwd, 'appwrap.overrides'), { recursive: true });
      writeFileSync(join(cwd, 'appwrap.overrides', 'a.ts'), 'x');

      applyOverrides(cwd, outDir, {} as any);
      // Remove overrides entirely; prune must not reach unrelated files.
      rmSync(join(cwd, 'appwrap.overrides', 'a.ts'));
      applyOverrides(cwd, outDir, {} as any);

      expect(existsSync(join(outDir, 'platforms', 'keep.txt'))).toBe(true);
      expect(existsSync(join(outDir, 'a.ts'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── iOS --resume must not ship a stale .ipa ──────────────────────────────────────────────────────
// `--resume` with no build cache used to skip the build with NO fingerprint/staleness comparison at
// all, so a changed input still shipped the PREVIOUS .ipa while printing success. Android never had
// that branch. These pin the invariant: a skip always requires positive evidence the .ipa is current.
describe('decideIosBuildSkip — --resume cannot skip a build whose inputs changed', () => {
  const IPA = '/out/native.ipa';
  const base = { force: false, resume: false, fp: 'fp1', ipaPath: IPA, ipaMtime: 1000, cache: null as BuildCache | null, newestInputMtime: () => 500 };
  const cacheFor = (fingerprint: string): BuildCache => ({ fingerprint, artifactPath: IPA, builtAt: 'x' });

  test('THE BUG: --resume, no cache, an input is NEWER than the .ipa → must NOT skip', () => {
    const d = decideIosBuildSkip({ ...base, resume: true, ipaMtime: 1000, newestInputMtime: () => 2000 });
    expect(d.skip).toBe(false);              // pre-fix this was `true` → stale .ipa shipped
    expect(d.reason).toMatch(/--resume ignored/); // and it must say so out loud, not rebuild silently
  });

  test('--resume, no cache, .ipa newer than every input → may skip (the legitimate workflow)', () => {
    const d = decideIosBuildSkip({ ...base, resume: true, ipaMtime: 2000, newestInputMtime: () => 1000 });
    expect(d.skip).toBe(true);
    expect(d.adoptCache).toBe(true);         // records a fingerprint so the NEXT run is fingerprint-gated
  });

  test('no-change control: cache fingerprint matches → skips (the cache still works)', () => {
    const d = decideIosBuildSkip({ ...base, cache: cacheFor('fp1') });
    expect(d.skip).toBe(true);
    expect(d.reason).toMatch(/inputs unchanged/);
  });

  test('cache fingerprint differs → rebuilds, and --resume cannot override that', () => {
    expect(decideIosBuildSkip({ ...base, cache: cacheFor('OLD') }).skip).toBe(false);
    expect(decideIosBuildSkip({ ...base, resume: true, cache: cacheFor('OLD') }).skip).toBe(false);
  });

  test('--force always rebuilds; no .ipa on disk never skips', () => {
    expect(decideIosBuildSkip({ ...base, force: true, cache: cacheFor('fp1') }).skip).toBe(false);
    expect(decideIosBuildSkip({ ...base, resume: true, ipaPath: undefined }).skip).toBe(false);
  });
});

describe('newestBuildInputMtime — the evidence the --resume gate runs on', () => {
  test('tracks the newest build input, incl. a runtime/ edit', () => {
    const cwd = scratch();
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true });
      writeFileSync(join(cwd, 'dist', 'index.html'), '<html></html>');
      writeFileSync(join(cwd, 'appwrap.config.ts'), 'export default {}');
      const before = newestBuildInputMtime(cwd, {});
      const f = join(cwd, 'dist', 'index.html');
      const t = new Date(Date.now() + 10_000);
      utimesSync(f, t, t);
      expect(newestBuildInputMtime(cwd, {})).toBeGreaterThan(before);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// Regression: `appwrap dev ios --url <new>` restamped native/app/shell/config.ts correctly, but that
// STAMPED file was not a fingerprint input — and `--url` touches nothing else. So the fingerprint
// matched, the build was skipped, and the PREVIOUS .ipa (carrying the PREVIOUS serverUrl) was
// reinstalled + relaunched under a "✓ Deployed" print. Observed on para-li: the phone kept loading the
// old LAN dev URL across three consecutive deploys of a different URL.
describe('buildFingerprint includes the stamped shell config (dev --url)', () => {
  function fixture(): string {
    const cwd = scratch();
    mkdirSync(join(cwd, 'native/app/shell'), { recursive: true });
    writeFileSync(join(cwd, 'appwrap.config.ts'), 'export default {}');
    return cwd;
  }
  const base = { id: 'x', name: 'X', version: '1.0.0', loader: 'server' as const };

  test('changes when only serverUrl changes', () => {
    const cwd = fixture();
    try {
      stampShellConfig(join(cwd, 'native'), { ...base, serverUrl: 'https://10.0.0.1:4012/?native=1' });
      const fp1 = buildFingerprint(cwd, {});
      stampShellConfig(join(cwd, 'native'), { ...base, serverUrl: 'https://example.com/?native=1' });
      expect(buildFingerprint(cwd, {})).not.toBe(fp1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Negative control — the stamp is rewritten unconditionally every run, so hashing its MTIME would
  // bust the cache on every deploy and silently disable the build-skip. Content only.
  test('does NOT change when the same config is re-stamped', () => {
    const cwd = fixture();
    try {
      const cfg = { ...base, serverUrl: 'https://example.com/?native=1' };
      stampShellConfig(join(cwd, 'native'), cfg);
      const fp1 = buildFingerprint(cwd, {});
      const t = new Date(Date.now() + 10_000);
      stampShellConfig(join(cwd, 'native'), cfg);
      utimesSync(join(cwd, 'native/app/shell/config.ts'), t, t);
      expect(buildFingerprint(cwd, {})).toBe(fp1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
