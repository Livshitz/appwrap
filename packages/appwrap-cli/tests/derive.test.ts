import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  androidScreenOrientation,
  stampAppBoundDomains,
  applyBuildNumberFlag,
  deriveBuild,
  iosOrientations,
  mergeManifest,
  normalizeOrientation,
  resolveBuildNumber,
  stampAndroidOrientation,
  stampAndroidQueries,
  stampPlistBackgroundTasks,
  stampPlistOrientations,
  stampPrivacyTracking,
  stripEmptyBackgroundModes,
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

describe('applyBuildNumberFlag — flag flows to the stamped CFBundleVersion', () => {
  const NOW = new Date(Date.UTC(2026, 5, 22, 14, 5));

  // The regression: `appwrap release ios --build-number N` stamped the default timestamp because the
  // flag was applied only to a child-process env copy, never the env that stamping reads. This proves
  // the flag lands on the env BEFORE stamping (sync → buildNumberOf → resolveBuildNumber) reads it.
  test('--build-number N → resolveBuildNumber returns N (over a timestamp default)', () => {
    const env: { APPWRAP_BUILD_NUMBER?: string } = {};
    const applied = applyBuildNumberFlag('18', env);
    expect(applied).toBe('18');
    expect(env.APPWRAP_BUILD_NUMBER).toBe('18');
    // This is exactly what buildNumberOf does: resolveBuildNumber(cfg, process.env.APPWRAP_BUILD_NUMBER).
    expect(resolveBuildNumber({ version: '1.2.3', buildNumber: 'timestamp' }, env.APPWRAP_BUILD_NUMBER, NOW)).toBe(18);
  });

  // Real consumer shape: appwrap.config.ts does `buildNumber: process.env.APPWRAP_BUILD_NUMBER || <stamp>`,
  // evaluated at import time — so cfg.buildNumber is already FROZEN to a numeric timestamp string before
  // the flag mutates process.env. Proves env precedence still wins over the frozen field (the actual trap).
  test('--build-number N wins over a frozen numeric-timestamp cfg.buildNumber', () => {
    const env: { APPWRAP_BUILD_NUMBER?: string } = {};
    applyBuildNumberFlag('18', env);
    expect(resolveBuildNumber({ version: '1.2.3', buildNumber: '2606221405' }, env.APPWRAP_BUILD_NUMBER, NOW)).toBe(18);
    // …and with no flag, the frozen timestamp is preserved unchanged.
    expect(resolveBuildNumber({ version: '1.2.3', buildNumber: '2606221405' }, undefined, NOW)).toBe(2606221405);
  });

  test('no flag → env untouched, stamping keeps the default strategy', () => {
    const env: { APPWRAP_BUILD_NUMBER?: string } = {};
    expect(applyBuildNumberFlag(undefined, env)).toBeUndefined();
    expect(applyBuildNumberFlag('', env)).toBeUndefined();
    expect(env.APPWRAP_BUILD_NUMBER).toBeUndefined();
    expect(resolveBuildNumber({ version: '1.2.3', buildNumber: 'timestamp' }, env.APPWRAP_BUILD_NUMBER, NOW)).toBe(2606221405);
  });

  test('non-positive-integer flag throws (caller prints + exits)', () => {
    expect(() => applyBuildNumberFlag('abc', {})).toThrow(/positive integer/);
    expect(() => applyBuildNumberFlag('-1', {})).toThrow(/positive integer/);
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
  // Drive the real transform against the actual shipped template (which ships NO UIBackgroundModes —
  // modes are opt-in per module/config).
  const TEMPLATE = join(import.meta.dir, '../../../runtime/App_Resources/iOS/Info.plist');
  const PLIST = readFileSync(TEMPLATE, 'utf8');

  test('template ships no UIBackgroundModes by default', () => {
    expect(PLIST).not.toContain('<key>UIBackgroundModes</key>');
  });

  test('stamps BGTaskSchedulerPermittedIdentifiers + CREATES UIBackgroundModes with fetch/processing', () => {
    const out = stampPlistBackgroundTasks(PLIST, ['sync', 'cleanup']);
    // permitted identifiers block
    expect(out).toContain('<key>BGTaskSchedulerPermittedIdentifiers</key>');
    expect(out).toContain('<string>sync</string>');
    expect(out).toContain('<string>cleanup</string>');
    // background modes in a SINGLE array (no duplicate key)
    expect(out.match(/<key>UIBackgroundModes<\/key>/g)).toHaveLength(1);
    expect(out).toContain('<string>fetch</string>');
    expect(out).toContain('<string>processing</string>');
    // still a single valid <dict>/<plist>
    expect(out.match(/<\/plist>/g)).toHaveLength(1);
  });

  test('absent/empty ids → strips the identifiers block, the two modes, AND the emptied key', () => {
    const stamped = stampPlistBackgroundTasks(PLIST, ['sync']);
    const cleared = stampPlistBackgroundTasks(stamped, undefined);
    expect(cleared).not.toContain('BGTaskSchedulerPermittedIdentifiers');
    expect(cleared).not.toContain('<string>fetch</string>');
    expect(cleared).not.toContain('<string>processing</string>');
    expect(cleared).not.toContain('<key>UIBackgroundModes</key>'); // emptied key removed
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

describe('stripEmptyBackgroundModes', () => {
  test('removes an empty UIBackgroundModes key+array', () => {
    const src = `<dict>\n  <key>UIBackgroundModes</key>\n  <array>\n  </array>\n</dict>\n</plist>\n`;
    expect(stripEmptyBackgroundModes(src)).not.toContain('UIBackgroundModes');
  });
  test('leaves a non-empty array untouched + idempotent', () => {
    const src = `<dict>\n\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>\n</dict>`;
    expect(stripEmptyBackgroundModes(src)).toBe(src);
  });
});

describe('stampAppBoundDomains — WKAppBoundDomains gate (operates on the REAL Info.plist template)', () => {
  const TEMPLATE = join(import.meta.dir, '../../../runtime/App_Resources/iOS/Info.plist');
  const PLIST = readFileSync(TEMPLATE, 'utf8');

  test('empty/undefined → no WKAppBoundDomains key, round-trips to the original template', () => {
    expect(stampAppBoundDomains(PLIST, undefined)).toBe(PLIST);
    expect(stampAppBoundDomains(PLIST, [])).toBe(PLIST);
    expect(PLIST).not.toContain('WKAppBoundDomains');
  });

  test('adds the key + array, single valid <dict>/<plist>', () => {
    const out = stampAppBoundDomains(PLIST, ['shadowstep.bodify.bod.ee']);
    expect(out).toContain('<key>WKAppBoundDomains</key>');
    expect(out).toContain('<string>shadowstep.bodify.bod.ee</string>');
    expect(out.match(/<\/plist>/g)).toHaveLength(1);
    expect(out.match(/<key>WKAppBoundDomains<\/key>/g)).toHaveLength(1);
  });

  test('multiple domains stamped', () => {
    const out = stampAppBoundDomains(PLIST, ['a.example.com', 'b.example.com']);
    expect(out).toContain('<string>a.example.com</string>');
    expect(out).toContain('<string>b.example.com</string>');
  });

  test('idempotent replace — re-stamping same domains is a fixed point; new domains replace old', () => {
    const once = stampAppBoundDomains(PLIST, ['a.example.com']);
    const twice = stampAppBoundDomains(once, ['a.example.com']);
    expect(twice).toBe(once);
    expect(twice.match(/<key>WKAppBoundDomains<\/key>/g)).toHaveLength(1);
    const replaced = stampAppBoundDomains(once, ['b.example.com']);
    expect(replaced).toContain('<string>b.example.com</string>');
    expect(replaced).not.toContain('<string>a.example.com</string>');
  });

  test('stamp then clear round-trips back to the original template', () => {
    const stamped = stampAppBoundDomains(PLIST, ['a.example.com']);
    expect(stampAppBoundDomains(stamped, undefined)).toBe(PLIST);
  });
});

describe('stampPrivacyTracking — ATT declarations into the real store-readiness manifest', () => {
  // Read the SHIPPING template so the test fails if its structure drifts away from the stamper's regex.
  const TEMPLATE = readFileSync(
    join(import.meta.dir, '../../../runtime/App_Resources/iOS/PrivacyInfo.xcprivacy'),
    'utf8'
  );

  test('module INACTIVE: NSPrivacyTracking stays false, domains empty (template default preserved)', () => {
    const out = stampPrivacyTracking(TEMPLATE, false, ['analytics.example.com']);
    expect(out).toContain('<key>NSPrivacyTracking</key>\n\t<false/>');
    expect(out).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
    expect(out).not.toContain('analytics.example.com'); // domains ignored when tracking off
    // The store-readiness required-reason APIs survive untouched.
    expect(out).toContain('NSPrivacyAccessedAPICategoryUserDefaults');
    expect(out).toContain('NSPrivacyCollectedDataTypeDeviceID');
  });

  test('module ACTIVE with domains: NSPrivacyTracking true + populated NSPrivacyTrackingDomains', () => {
    const out = stampPrivacyTracking(TEMPLATE, true, ['analytics.example.com', 'ads.example.net']);
    expect(out).toContain('<key>NSPrivacyTracking</key>\n\t<true/>');
    expect(out).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array>/);
    expect(out).toContain('<string>analytics.example.com</string>');
    expect(out).toContain('<string>ads.example.net</string>');
    // Still ONE manifest — required-reason declarations preserved (extends, not replaces).
    expect(out).toContain('NSPrivacyAccessedAPICategoryDiskSpace');
    expect(out.match(/<key>NSPrivacyTracking<\/key>/g)).toHaveLength(1);
  });

  test('module ACTIVE, no domains: tracking true with an empty domains array', () => {
    const out = stampPrivacyTracking(TEMPLATE, true, []);
    expect(out).toContain('<key>NSPrivacyTracking</key>\n\t<true/>');
    expect(out).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
  });

  test('idempotent + reversible: active→inactive resets cleanly to the false default', () => {
    const active = stampPrivacyTracking(TEMPLATE, true, ['a.example.com']);
    const again = stampPrivacyTracking(active, true, ['a.example.com']);
    expect(again).toBe(active); // idempotent
    const reset = stampPrivacyTracking(active, false, []);
    expect(reset).toContain('<key>NSPrivacyTracking</key>\n\t<false/>');
    expect(reset).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
    expect(reset).not.toContain('a.example.com');
  });
});
