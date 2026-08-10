/**
 * Permission stamping, asserted on the COMPILED artifacts (Info.plist / AndroidManifest.xml / the
 * stamped shell config) — never on the config object, because a config that reads as if it declared a
 * permission while the plist carries nothing IS the bug these tests exist for.
 *
 * INCIDENT: Copy Bin (cc.livx.copybin) was rejected under App Store Guideline 2.1(a) — TCC killed it on
 * the reviewer's iPad ("must contain an NSCameraUsageDescription key"). The app never calls the camera;
 * it has a plain <input type="file" accept="image/*">, and WKWebView's picker offers "Take Photo". The
 * config declared `modules: ['clipboard','share','shareTarget']`, and with `modules` present a
 * `permissions{}` entry only overrode a module's usage COPY — declaring a domain no module owned stamped
 * NOTHING. A declaration that is silently inert, and a store rejection.
 *
 * These run the real `appwrap init` (a spawned CLI, ~1s each) rather than a unit seam: the whole defect
 * lived between "the config said so" and "the plist carried it".
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = resolve(import.meta.dir, '../src/cli.ts');

/** Scaffold a throwaway app, run `appwrap init`, and hand back the generated artifacts. */
function generate(config: Record<string, unknown>): { plist: string; manifest: string; shell: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'appwrap-perms-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<html></html>');
  writeFileSync(
    join(dir, 'appwrap.config.ts'),
    `export default ${JSON.stringify({ id: 'cc.livx.permstest', name: 'Perms', version: '1.0.0', pwaDist: 'dist', ...config }, null, 2)};\n`
  );
  const r = Bun.spawnSync(['bun', CLI, 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`appwrap init failed:\n${r.stderr.toString()}${r.stdout.toString()}`);
  const read = (rel: string) => readFileSync(join(dir, 'native', rel), 'utf8');
  return {
    plist: read('App_Resources/iOS/Info.plist'),
    manifest: read('App_Resources/Android/src/main/AndroidManifest.xml'),
    shell: read('app/shell/config.ts'),
    dir,
  };
}

/** The usage string stamped for an Info.plist key, or null when the key is absent. */
function usageFor(plist: string, key: string): string | null {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe('a declared permission is never inert', () => {
  // The exact defect: `modules` present, a domain no active module owns. Pre-fix this stamped nothing.
  test('`permissions{}` stamps its own iOS key when no module owns the domain', () => {
    const g = generate({ modules: ['clipboard', 'share'], permissions: { location: 'Show nearby stores.' } });
    try {
      expect(usageFor(g.plist, 'NSLocationWhenInUseUsageDescription')).toBe('Show nearby stores.');
    } finally { cleanup(g.dir); }
  });

  test('`permissions{}` stamps its own Android permission when no module owns the domain', () => {
    const g = generate({ modules: ['clipboard', 'share'], permissions: { contacts: 'Invite your friends.' } });
    try {
      expect(g.manifest).toContain('android.permission.READ_CONTACTS');
    } finally { cleanup(g.dir); }
  });

  // Legacy (no `modules`) read permissions{} already — it must keep doing so.
  test('legacy mode (no `modules`) still stamps permissions{}', () => {
    const g = generate({ permissions: { microphone: 'Record a voice note.' } });
    try {
      expect(usageFor(g.plist, 'NSMicrophoneUsageDescription')).toBe('Record a voice note.');
    } finally { cleanup(g.dir); }
  });
});

describe('the webview baseline (the Copy Bin crash)', () => {
  // Copy Bin's exact config. WKWebView's <input type="file"> picker offers "Take Photo" in EVERY build,
  // and TCC hard-kills the host process for a camera access with no usage string.
  test('NSCameraUsageDescription is stamped even for an app that declares no camera anything', () => {
    const g = generate({ modules: ['clipboard', 'share', 'shareTarget'], urlScheme: 'copybin' });
    try {
      expect(usageFor(g.plist, 'NSCameraUsageDescription')).toBeTruthy();
    } finally { cleanup(g.dir); }
  });

  test('an app with no `modules` at all also gets it', () => {
    const g = generate({});
    try {
      expect(usageFor(g.plist, 'NSCameraUsageDescription')).toBeTruthy();
    } finally { cleanup(g.dir); }
  });

  test('`permissions: { camera: false }` opts out', () => {
    const g = generate({ modules: ['clipboard'], permissions: { camera: false } });
    try {
      expect(usageFor(g.plist, 'NSCameraUsageDescription')).toBeNull();
    } finally { cleanup(g.dir); }
  });

  // The baseline is iOS-only: the Android chooser's capture path handles an UNDECLARED CAMERA
  // permission by falling back to the plain picker (file-chooser.android.ts), so there is nothing to
  // fix there — and a gratuitous runtime permission would change the Play listing.
  test('it does NOT add android.permission.CAMERA', () => {
    const g = generate({ modules: ['clipboard', 'share'] });
    try {
      expect(g.manifest).not.toContain('android.permission.CAMERA');
    } finally { cleanup(g.dir); }
  });
});

describe('module-derived stamping is unchanged', () => {
  test("an owning module's usage copy wins over the baseline default", () => {
    const g = generate({ modules: ['camera'] });
    try {
      expect(usageFor(g.plist, 'NSCameraUsageDescription')).toBe('Capture a photo.');
    } finally { cleanup(g.dir); }
  });

  test('`permissions{}` still overrides an owning module’s copy (and stamps the key once)', () => {
    const g = generate({ modules: ['camera'], permissions: { camera: 'Scan your receipt.' } });
    try {
      expect(usageFor(g.plist, 'NSCameraUsageDescription')).toBe('Scan your receipt.');
      expect(g.plist.match(/NSCameraUsageDescription/g)?.length).toBe(1);
    } finally { cleanup(g.dir); }
  });
});

describe('the plist baseline does not widen what the web layer may use', () => {
  // The shell's document-start guard rejects getUserMedia for undeclared capabilities. It used to read
  // the guard state off Info.plist presence — which, with an always-present camera usage string, would
  // hand getUserMedia({video}) to every page an app renders. Declaration and plist are stamped apart.
  test('baseline-only camera leaves SHELL_CONFIG.webCaps.camera false', () => {
    const g = generate({ modules: ['clipboard', 'share'] });
    try {
      expect(usageFor(g.plist, 'NSCameraUsageDescription')).toBeTruthy();
      expect(g.shell).toContain('"camera":false');
    } finally { cleanup(g.dir); }
  });

  test('an app that declares the camera gets the capability', () => {
    const g = generate({ modules: ['camera'] });
    try {
      expect(g.shell).toContain('"camera":true');
    } finally { cleanup(g.dir); }
  });
});
