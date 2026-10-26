/**
 * `ModuleManifest.ios.pods` + `ios.infoPlist` — a pack module's iOS native deps and Info.plist keys,
 * asserted on the GENERATED Podfile / Info.plist (native/ is regenerated each sync, so a hand edit there
 * is lost; these fields are the only durable way for a pack to add them).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = resolve(import.meta.dir, '../src/cli.ts');

type Mod = { name: string; ios?: Record<string, unknown> };
function generate(mods: Mod[], active: string[], extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'appwrap-podplist-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<html></html>');
  mkdirSync(join(dir, 'pack'));
  const modules = mods.map((m) => ({ group: m.name, capabilities: { [m.name]: { ios: true } }, ...m }));
  writeFileSync(join(dir, 'pack', 'manifest.ts'), `export default ${JSON.stringify({ manifestSchemaVersion: 1, modules })};\n`);
  writeFileSync(
    join(dir, 'appwrap.config.ts'),
    `export default ${JSON.stringify({ id: 'cc.livx.podtest', name: 'Pod', version: '1.0.0', pwaDist: 'dist', modulePacks: ['./pack'], modules: active, ...extra })};\n`,
  );
  const run = () => Bun.spawnSync(['bun', CLI, 'init', '--force'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const r = run();
  const read = (f: string) => (r.exitCode === 0 ? readFileSync(join(dir, 'native/App_Resources/iOS', f), 'utf8') : '');
  return { dir, ok: r.exitCode === 0, out: r.stderr.toString() + r.stdout.toString(), podfile: read('Podfile'), plist: read('Info.plist'), run };
}
const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });
const podLines = (p: string) => p.split('\n').filter((l) => l.startsWith('pod '));

describe('ios.pods', () => {
  test('an active module adds its pod once (deduped across modules), and the template stays intact', () => {
    const g = generate([
      { name: 'fbA', ios: { pods: ["'FBSDKCoreKit', '18.0.0'"] } },
      { name: 'fbB', ios: { pods: ["'FBSDKCoreKit', '18.0.0'"] } },
    ], ['fbA', 'fbB']);
    try {
      expect(g.ok).toBe(true);
      expect(podLines(g.podfile)).toEqual(["pod 'FBSDKCoreKit', '18.0.0'"]);
      expect(g.podfile).toContain('post_install do |installer|');
      // idempotent: a second sync doesn't append a second block
      expect(g.run().exitCode).toBe(0);
      expect(podLines(readFileSync(join(g.dir, 'native/App_Resources/iOS/Podfile'), 'utf8'))).toHaveLength(1);
    } finally { cleanup(g.dir); }
  });

  test('an inactive module adds no pod', () => {
    const g = generate([{ name: 'fbA', ios: { pods: ["'FBSDKCoreKit'"] } }], []);
    try {
      expect(g.ok).toBe(true);
      expect(podLines(g.podfile)).toEqual([]);
      expect(g.podfile).not.toContain('appwrap-modules');
    } finally { cleanup(g.dir); }
  });
});

describe('ios.infoPlist', () => {
  const skan = [{ SKAdNetworkIdentifier: 'v9wttpbfk9.skadnetwork' }, { SKAdNetworkIdentifier: 'n38lu8286q.skadnetwork' }];
  test('nested values (array of dicts, booleans, escaped strings) land inside the appwrap block', () => {
    const g = generate([{ name: 'meta', ios: { infoPlist: { SKAdNetworkItems: skan, FacebookAutoLogAppEventsEnabled: true, FacebookDisplayName: 'A & B' } } }], ['meta']);
    try {
      expect(g.ok).toBe(true);
      const block = g.plist.slice(g.plist.indexOf('appwrap:begin'), g.plist.indexOf('appwrap:end'));
      expect(block).toMatch(/<key>SKAdNetworkItems<\/key>\s*<array>\s*<dict>\s*<key>SKAdNetworkIdentifier<\/key>\s*<string>v9wttpbfk9\.skadnetwork<\/string>\s*<\/dict>\s*<dict>/);
      expect(block).toMatch(/<key>FacebookAutoLogAppEventsEnabled<\/key>\s*<true\/>/);
      expect(block).toContain('<string>A &amp; B</string>');
      // the plist is still valid XML plist
      const lint = Bun.spawnSync(['plutil', '-lint', join(g.dir, 'native/App_Resources/iOS/Info.plist')]);
      expect(lint.exitCode).toBe(0);
    } finally { cleanup(g.dir); }
  });

  test('an inactive module stamps nothing', () => {
    const g = generate([{ name: 'meta', ios: { infoPlist: { FacebookAppID: '1' } } }], []);
    try { expect(g.ok).toBe(true); expect(g.plist).not.toContain('FacebookAppID'); } finally { cleanup(g.dir); }
  });

  test('two modules declaring the same key FAIL the sync', () => {
    const g = generate([{ name: 'a', ios: { infoPlist: { FacebookAppID: '1' } } }, { name: 'b', ios: { infoPlist: { FacebookAppID: '2' } } }], ['a', 'b']);
    try { expect(g.ok).toBe(false); expect(g.out).toContain('"FacebookAppID" is declared by both module'); } finally { cleanup(g.dir); }
  });

  test('a key the template, appwrap or the config already sets FAILS the sync', () => {
    for (const [infoPlist, extra] of [
      [{ CFBundleName: 'x' }, {}],                     // template
      [{ CFBundleURLTypes: [] }, { urlScheme: 'pod' }], // appwrap's own stamp
      [{ AWKey: true }, { iosInfoPlist: { AWKey: false } }], // config iosInfoPlist
    ] as const) {
      const g = generate([{ name: 'meta', ios: { infoPlist } }], ['meta'], extra);
      try { expect(g.ok).toBe(false); expect(g.out).toContain("from module 'meta' is already declared"); } finally { cleanup(g.dir); }
    }
  });
});
