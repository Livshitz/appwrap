import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  androidScreenOrientation,
  deriveBuild,
  iosOrientations,
  mergeManifest,
  normalizeOrientation,
  resolveBuildNumber,
  stampAndroidOrientation,
  stampAndroidQueries,
  stampPlistBackgroundTasks,
  stampPlistOrientations,
} from '../src/derive';

describe('resolveBuildNumber — named strategies + precedence', () => {
  const NOW = new Date(Date.UTC(2026, 5, 22, 14, 5)); // 2026-06-22 14:05 UTC
  const UINT32_MAX = 4294967295;

  test("'timestamp' → 10-digit YYMMDDHHMM, ≤ UInt32 (iOS CFBundleVersion safe)", () => {
    const n = resolveBuildNumber({ version: '1.2.3', buildNumber: 'timestamp' }, undefined, NOW);
    expect(n).toBe(2606221405);
    expect(String(n)).toHaveLength(10);
    expect(n).toBeLessThanOrEqual(UINT32_MAX);
  });

  test("'epoch' → unix seconds (~1.78e9, Android-safe)", () => {
    const n = resolveBuildNumber({ version: '1.2.3', buildNumber: 'epoch' }, undefined, NOW);
    expect(n).toBe(Math.floor(NOW.getTime() / 1000));
    expect(n).toBeGreaterThan(1.7e9);
    expect(n).toBeLessThan(1.8e9);
  });

  test('explicit number passes through (number or numeric string)', () => {
    expect(resolveBuildNumber({ version: '1.2.3', buildNumber: 4242 }, undefined, NOW)).toBe(4242);
    expect(resolveBuildNumber({ version: '1.2.3', buildNumber: '4242' }, undefined, NOW)).toBe(4242);
  });

  test('env override WINS over a strategy', () => {
    expect(resolveBuildNumber({ version: '1.2.3', buildNumber: 'timestamp' }, '999', NOW)).toBe(999);
  });

  test('unknown string falls back to deriveBuild (never crashes)', () => {
    expect(resolveBuildNumber({ version: '1.4.12', buildNumber: 'bogus' }, undefined, NOW)).toBe(
      deriveBuild('1.4.12')
    );
  });

  test('absent buildNumber → deriveBuild default', () => {
    expect(resolveBuildNumber({ version: '0.2.1' }, undefined, NOW)).toBe(201);
  });

  test('empty/whitespace env is ignored (does not win)', () => {
    expect(resolveBuildNumber({ version: '0.2.1', buildNumber: 'epoch' }, '', NOW)).toBe(
      Math.floor(NOW.getTime() / 1000)
    );
  });
});

describe('mergeManifest — precedence (config > manifest > default)', () => {
  const MF = {
    name: 'Manifest Name',
    short_name: 'MNShort',
    background_color: '#111111',
    theme_color: '#222222',
    orientation: 'portrait-primary',
  };

  test('manifest fills gaps when config is silent', () => {
    const cfg: any = {};
    mergeManifest(cfg, MF);
    expect(cfg.name).toBe('Manifest Name');
    expect(cfg.backgroundColor).toBe('#111111');
    expect(cfg.themeColor).toBe('#222222');
    expect(cfg.orientation).toBe('portrait'); // normalized from portrait-primary
  });

  test('explicit config value WINS over the manifest', () => {
    const cfg: any = {
      name: 'Config Name',
      backgroundColor: '#abcdef',
      themeColor: '#fedcba',
      orientation: 'landscape',
    };
    mergeManifest(cfg, MF);
    expect(cfg.name).toBe('Config Name');
    expect(cfg.backgroundColor).toBe('#abcdef');
    expect(cfg.themeColor).toBe('#fedcba');
    expect(cfg.orientation).toBe('landscape');
  });

  test('name falls back short_name when name absent', () => {
    const cfg: any = {};
    mergeManifest(cfg, { short_name: 'Only Short' });
    expect(cfg.name).toBe('Only Short');
  });

  test('no manifest → cfg untouched (template defaults apply downstream)', () => {
    const cfg: any = { name: 'X' };
    mergeManifest(cfg, null);
    expect(cfg).toEqual({ name: 'X' });
    expect(cfg.orientation).toBeUndefined();
  });

  test('manifest without orientation leaves it undefined (free-rotation default, no over-constrain)', () => {
    const cfg: any = {};
    mergeManifest(cfg, { name: 'A' });
    expect(cfg.orientation).toBeUndefined();
  });
});

describe('normalizeOrientation', () => {
  const cases: Array<[string | undefined | null, string]> = [
    ['portrait', 'portrait'],
    ['portrait-primary', 'portrait'],
    ['portrait-secondary', 'portrait'],
    ['landscape', 'landscape'],
    ['landscape-primary', 'landscape'],
    ['landscape-secondary', 'landscape'],
    ['PORTRAIT-PRIMARY', 'portrait'], // case-insensitive
    ['  landscape  ', 'landscape'], // trimmed
    ['any', 'any'],
    ['natural', 'any'],
    ['', 'any'],
    [undefined, 'any'],
    [null, 'any'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(normalizeOrientation(input)).toBe(expected as any);
    });
  }
});

describe('orientation → native mapping table', () => {
  test('portrait → portrait-only', () => {
    expect(iosOrientations('portrait')).toEqual(['UIInterfaceOrientationPortrait']);
    expect(androidScreenOrientation('portrait')).toBe('portrait');
  });
  test('landscape → landscape-only (both edges)', () => {
    expect(iosOrientations('landscape')).toEqual([
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ]);
    expect(androidScreenOrientation('landscape')).toBe('landscape');
  });
  test('any → all (free rotation, no upside-down on iOS)', () => {
    expect(iosOrientations('any')).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ]);
    expect(androidScreenOrientation('any')).toBe('unspecified');
  });
});

// Mirror the template Info.plist: an iPhone array + an ~ipad variant array.
const PLIST = `<dict>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UISupportedInterfaceOrientations~ipad</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationPortraitUpsideDown</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UIBackgroundModes</key>
	<array>
		<string>audio</string>
	</array>
</dict>`;

describe('stampPlistOrientations', () => {
  test('rewrites BOTH orientation arrays (iPhone + ~ipad) to portrait, leaves others', () => {
    const out = stampPlistOrientations(PLIST, iosOrientations('portrait'));
    // both orientation arrays collapsed to portrait-only
    const arrays = out.match(/UISupportedInterfaceOrientations(?:~ipad)?<\/key>\s*<array>([\s\S]*?)<\/array>/g)!;
    expect(arrays).toHaveLength(2);
    for (const a of arrays) {
      expect(a).toContain('UIInterfaceOrientationPortrait');
      expect(a).not.toContain('LandscapeLeft');
      expect(a).not.toContain('UpsideDown');
    }
    // untouched: the audio background mode array survives
    expect(out).toContain('<string>audio</string>');
  });

  test('landscape stamps both edges', () => {
    const out = stampPlistOrientations(PLIST, iosOrientations('landscape'));
    expect(out).toContain('<string>UIInterfaceOrientationLandscapeLeft</string>');
    expect(out).toContain('<string>UIInterfaceOrientationLandscapeRight</string>');
    expect(out).not.toMatch(/UISupportedInterfaceOrientations<\/key>\s*<array>[\s\S]*?Portrait/);
  });

  test('idempotent: re-stamping the same value is a fixed point', () => {
    const once = stampPlistOrientations(PLIST, iosOrientations('portrait'));
    const twice = stampPlistOrientations(once, iosOrientations('portrait'));
    expect(twice).toBe(once);
  });
});

// Mirror the template AndroidManifest main <activity> tag.
const MANIFEST = `<application android:name="com.tns.NativeScriptApplication">
		<activity
			android:name="com.tns.NativeScriptActivity"
			android:configChanges="orientation|screenSize"
			android:launchMode="singleTask"
			android:exported="true">
			<intent-filter>
				<action android:name="android.intent.action.MAIN" />
			</intent-filter>
		</activity>
		<activity android:name="com.tns.ErrorReportActivity"/>
	</application>`;

describe('stampAndroidOrientation', () => {
  test('injects android:screenOrientation on the MAIN activity only', () => {
    const out = stampAndroidOrientation(MANIFEST, androidScreenOrientation('portrait'));
    expect(out).toContain('android:screenOrientation="portrait"');
    // exactly one occurrence — the second (ErrorReport) activity is untouched
    expect(out.match(/android:screenOrientation/g)).toHaveLength(1);
    // injected right after android:name on the first activity
    expect(out).toMatch(/android:name="com.tns.NativeScriptActivity"\s*\n\s*android:screenOrientation="portrait"/);
  });

  test('landscape value', () => {
    expect(stampAndroidOrientation(MANIFEST, androidScreenOrientation('landscape'))).toContain(
      'android:screenOrientation="landscape"'
    );
  });

  test('unspecified (any) removes the attribute', () => {
    const portrait = stampAndroidOrientation(MANIFEST, 'portrait');
    const cleared = stampAndroidOrientation(portrait, androidScreenOrientation('any'));
    expect(cleared).not.toContain('android:screenOrientation');
    expect(cleared).toBe(MANIFEST); // back to the original template
  });

  test('idempotent: re-stamping the same value is a fixed point', () => {
    const once = stampAndroidOrientation(MANIFEST, 'landscape');
    const twice = stampAndroidOrientation(once, 'landscape');
    expect(twice).toBe(once);
  });
});

describe('stampAndroidQueries — canOpenUrl visibility (operates on the REAL manifest template)', () => {
  // Drive the actual transform the CLI runs, against the real shipped template (not a fixture).
  const TEMPLATE = join(import.meta.dir, '../../../runtime/App_Resources/Android/src/main/AndroidManifest.xml');
  const MANIFEST = readFileSync(TEMPLATE, 'utf8');

  test('queryUrlSchemes AND queryPackages land as both child kinds in ONE <queries> block', () => {
    const out = stampAndroidQueries(MANIFEST, ['com.whatsapp'], ['whatsapp']);
    // exactly one <queries> element
    expect(out.match(/<queries>/g)?.length).toBe(1);
    expect(out.match(/<\/queries>/g)?.length).toBe(1);
    // both children present, inside that block
    expect(out).toContain('<package android:name="com.whatsapp"/>');
    expect(out).toContain(
      '<intent><action android:name="android.intent.action.VIEW"/><data android:scheme="whatsapp"/></intent>'
    );
    const block = out.match(/<queries>[\s\S]*?<\/queries>/)![0];
    expect(block).toContain('com.whatsapp');
    expect(block).toContain('android:scheme="whatsapp"');
  });

  test('queryUrlSchemes ALONE drives Android scheme visibility (cross-platform symmetry)', () => {
    const out = stampAndroidQueries(MANIFEST, undefined, ['tg']);
    expect(out).toContain('<data android:scheme="tg"/>');
    expect(out).toContain('<queries>');
  });

  test('absent → empty block, no <queries> element', () => {
    const out = stampAndroidQueries(MANIFEST, undefined, undefined);
    expect(out).not.toContain('<queries>');
    expect(out).toContain('<!-- appwrap:queries -->\n\t<!-- /appwrap:queries -->');
  });

  test('idempotent — re-stamping does not duplicate', () => {
    const once = stampAndroidQueries(MANIFEST, ['com.whatsapp'], ['whatsapp']);
    const twice = stampAndroidQueries(once, ['com.whatsapp'], ['whatsapp']);
    expect(twice).toBe(once);
    expect(twice.match(/<queries>/g)?.length).toBe(1);
  });
});

describe('stampPlistBackgroundTasks — headless background tasks (operates on the REAL Info.plist template)', () => {
  // Drive the real transform against the actual shipped template (with its existing `audio` bg mode).
  const TEMPLATE = join(import.meta.dir, '../../../runtime/App_Resources/iOS/Info.plist');
  const PLIST = readFileSync(TEMPLATE, 'utf8');

  test('stamps BGTaskSchedulerPermittedIdentifiers + MERGES fetch/processing into UIBackgroundModes (keeps audio)', () => {
    const out = stampPlistBackgroundTasks(PLIST, ['sync', 'cleanup']);
    // permitted identifiers block
    expect(out).toContain('<key>BGTaskSchedulerPermittedIdentifiers</key>');
    expect(out).toContain('<string>sync</string>');
    expect(out).toContain('<string>cleanup</string>');
    // background modes merged into the SINGLE existing array (no duplicate key)
    expect(out.match(/<key>UIBackgroundModes<\/key>/g)).toHaveLength(1);
    expect(out).toContain('<string>fetch</string>');
    expect(out).toContain('<string>processing</string>');
    expect(out).toContain('<string>audio</string>'); // pre-existing mode preserved
    // still a single valid <dict>/<plist>
    expect(out.match(/<\/plist>/g)).toHaveLength(1);
  });

  test('absent/empty ids → strips the identifiers block AND removes the two modes it adds (audio stays)', () => {
    const stamped = stampPlistBackgroundTasks(PLIST, ['sync']);
    const cleared = stampPlistBackgroundTasks(stamped, undefined);
    expect(cleared).not.toContain('BGTaskSchedulerPermittedIdentifiers');
    expect(cleared).not.toContain('<string>fetch</string>');
    expect(cleared).not.toContain('<string>processing</string>');
    expect(cleared).toContain('<string>audio</string>'); // untouched pre-existing mode
    expect(cleared).toBe(PLIST); // round-trips back to the original template
  });

  test('idempotent — re-stamping the same ids is a fixed point (no duplicate identifiers/modes)', () => {
    const once = stampPlistBackgroundTasks(PLIST, ['sync']);
    const twice = stampPlistBackgroundTasks(once, ['sync']);
    expect(twice).toBe(once);
    expect(twice.match(/<string>fetch<\/string>/g)).toHaveLength(1);
    expect(twice.match(/BGTaskSchedulerPermittedIdentifiers/g)).toHaveLength(1);
  });

  test('on a plist WITHOUT a UIBackgroundModes array, creates one with fetch+processing', () => {
    const minimal = `<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>X</string>\n</dict>\n</plist>\n`;
    const out = stampPlistBackgroundTasks(minimal, ['sync']);
    expect(out).toContain('<key>UIBackgroundModes</key>');
    expect(out).toContain('<string>fetch</string>');
    expect(out).toContain('<string>processing</string>');
    expect(out.match(/<key>UIBackgroundModes<\/key>/g)).toHaveLength(1);
  });
});
