import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODULES } from '../../../runtime/app/shell/capabilities.manifest';

// Android shareTarget parity: the SEND filters must live on the LIGHTWEIGHT translucent
// AppwrapShareActivity (module Kotlin source, direct-sync + fallback), NOT the main activity —
// so a share never boots the full app/WebView.
describe('android shareTarget parity wiring', () => {
  const mod = MODULES.find((m) => m.name === 'shareTarget')!;

  test('SEND filters sit on the lightweight activity, not the main activity', () => {
    expect(mod.android?.manifestActivity).toBeUndefined();
    const xml = mod.android?.manifestApplication ?? '';
    expect(xml).toContain('cc.appwrap.share.AppwrapShareActivity');
    expect(xml).toContain('android.intent.action.SEND');
    expect(xml).toContain('android.intent.action.SEND_MULTIPLE');
    expect(xml).toContain('Theme.Translucent'); // no visible activity — parity with the iOS drawer
    expect(xml).toContain('android:exported="true"'); // API 31+: filtered activities must be explicit
  });

  test('module ships Kotlin source with the build-time tokens the CLI stamps', () => {
    expect(mod.android?.kotlin).toBe(true);
    const kt = resolve(
      import.meta.dir,
      '../../../runtime/modules-native/shareTarget/App_Resources/Android/src/main/java/cc/appwrap/share/AppwrapShareActivity.kt'
    );
    expect(existsSync(kt)).toBe(true);
    const src = readFileSync(kt, 'utf8');
    // Both tokens must appear so substituteModuleTokens (which now walks Android/src/main/java) can
    // stamp the app's directSync config + urlScheme; the manifest class name must match the file.
    expect(src).toContain('__SHARE_SYNC_B64__');
    expect(src).toContain('__URL_SCHEME__');
    expect(src).toContain('package cc.appwrap.share');
    expect(src).toContain('class AppwrapShareActivity');
  });
});
