/**
 * `iosInfoPlist` — arbitrary Info.plist keys from the config, asserted on the COMPILED plist for the
 * same reason every test in permissions-plist.test.ts is: a config that reads as if it declared
 * something while the plist carries nothing IS the bug.
 *
 * Its first consumer is `NSSupportsLiveActivities`, which is ActivityKit's ONE requirement — no
 * entitlement, no portal step. Without the key the app builds, signs and installs, and every
 * Live Activity request is refused on the device with nothing in the build saying why.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = resolve(import.meta.dir, '../src/cli.ts');

function generate(config: Record<string, unknown>): { plist: string; dir: string; stderr: string; ok: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'appwrap-plist-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<html></html>');
  writeFileSync(
    join(dir, 'appwrap.config.ts'),
    `export default ${JSON.stringify({ id: 'cc.livx.plisttest', name: 'Plist', version: '1.0.0', pwaDist: 'dist', ...config }, null, 2)};\n`,
  );
  const r = Bun.spawnSync(['bun', CLI, 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const plist = r.exitCode === 0 ? readFileSync(join(dir, 'native/App_Resources/iOS/Info.plist'), 'utf8') : '';
  return { plist, dir, stderr: r.stderr.toString() + r.stdout.toString(), ok: r.exitCode === 0 };
}
const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

describe('iosInfoPlist reaches the plist', () => {
  test('a boolean lands as <true/>, and the key is not merely accepted by the config loader', () => {
    const g = generate({ iosInfoPlist: { NSSupportsLiveActivities: true } });
    try {
      expect(g.ok).toBe(true);
      expect(g.plist).toMatch(/<key>NSSupportsLiveActivities<\/key>\s*<true\/>/);
      // …and it is INSIDE the idempotent block, which is what makes removing the config key remove
      // the plist key rather than leaving it stamped forever.
      const block = g.plist.slice(g.plist.indexOf('appwrap:begin'), g.plist.indexOf('appwrap:end'));
      expect(block).toContain('NSSupportsLiveActivities');
      // An UNKNOWN key would have warned instead of stamping — the exact silent no-op this guards.
      expect(g.stderr).not.toContain('iosInfoPlist');
    } finally { cleanup(g.dir); }
  });

  test('strings, numbers and arrays each take their plist shape', () => {
    const g = generate({ iosInfoPlist: { AWString: 'hi', AWNumber: 7, AWArray: ['a', 'b'] } });
    try {
      expect(g.plist).toMatch(/<key>AWString<\/key>\s*<string>hi<\/string>/);
      expect(g.plist).toMatch(/<key>AWNumber<\/key>\s*<integer>7<\/integer>/);
      expect(g.plist).toMatch(/<key>AWArray<\/key>\s*<array>\s*<string>a<\/string>\s*<string>b<\/string>\s*<\/array>/);
    } finally { cleanup(g.dir); }
  });

  test('a key the template already declares is REFUSED, not silently duplicated', () => {
    // Two <key>s in one dict is an invalid plist that Xcode tolerates and the App Store rejects —
    // a failure that would land at the very end of a ten-minute release lane.
    const g = generate({ iosInfoPlist: { CFBundleName: 'Nope' } });
    try {
      expect(g.ok).toBe(false);
      expect(g.stderr).toContain('CFBundleName');
    } finally { cleanup(g.dir); }
  });

  test('absent config leaves the plist exactly as it was', () => {
    const g = generate({});
    try { expect(g.plist).not.toContain('NSSupportsLiveActivities'); } finally { cleanup(g.dir); }
  });
});
