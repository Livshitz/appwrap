/**
 * Spatial-audio stamping, asserted on the COMPILED artifacts of a real `appwrap init` (as
 * permissions-plist.test.ts does). CMHeadphoneMotionManager kills the process on start without
 * NSMotionUsageDescription, and `backgroundAudio` is useless unless the shell also activates a playback session.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = resolve(import.meta.dir, '../src/cli.ts');

function generate(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'appwrap-spatial-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<html></html>');
  writeFileSync(
    join(dir, 'appwrap.config.ts'),
    `export default ${JSON.stringify({ id: 'cc.livx.spatialtest', name: 'Spatial', version: '1.0.0', pwaDist: 'dist', ...config }, null, 2)};\n`
  );
  const r = Bun.spawnSync(['bun', CLI, 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`appwrap init failed:\n${r.stderr.toString()}${r.stdout.toString()}`);
  const read = (rel: string) => readFileSync(join(dir, 'native', rel), 'utf8');
  try {
    return {
      plist: read('App_Resources/iOS/Info.plist'),
      shell: read('app/shell/config.ts'),
      modules: read('app/shell/active-modules.generated.ts'),
      optional: read('app/shell/optional-handlers.generated.ts'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const usage = (plist: string, key: string) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null;
const bgModes = (plist: string) => plist.match(/<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';

describe('headphoneMotion', () => {
  test('enabled → NSMotionUsageDescription stamped (default copy) + handler compiled in', () => {
    const g = generate({ modules: ['headphoneMotion'] });
    expect(usage(g.plist, 'NSMotionUsageDescription')).toBe('Follow your head movement with your headphones for spatial audio.');
    expect(g.optional).toContain('registerHeadphoneMotionHandlers');
    expect(g.modules).toContain('headphoneMotion');
  });

  test('permissions.motion overrides the usage copy', () => {
    const g = generate({ modules: ['headphoneMotion'], permissions: { motion: 'Spatial audio follows your head.' } });
    expect(usage(g.plist, 'NSMotionUsageDescription')).toBe('Spatial audio follows your head.');
  });

  test('not enabled → no NSMotionUsageDescription, handler stripped', () => {
    const g = generate({ modules: ['share'] });
    expect(usage(g.plist, 'NSMotionUsageDescription')).toBeNull();
    expect(g.optional).not.toContain('registerHeadphoneMotionHandlers');
  });
});

describe('backgroundAudio', () => {
  test('true → `audio` UIBackgroundMode + shell boots a playback session', () => {
    const g = generate({ modules: ['share'], backgroundAudio: true });
    expect(bgModes(g.plist)).toContain('<string>audio</string>');
    expect(g.shell).toContain('backgroundAudio: true,');
  });

  test('absent → no `audio` mode, no boot session', () => {
    const g = generate({ modules: ['share'] });
    expect(bgModes(g.plist)).not.toContain('<string>audio</string>');
    expect(g.shell).toContain('backgroundAudio: false,');
  });
});
