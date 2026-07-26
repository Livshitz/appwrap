import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Static invariants for iOS safe-area / env(safe-area-inset-*) support.
 *
 * The iOS shell source can't be imported here (it references WKWebView/UIKit globals at module
 * scope), so these are SOURCE-LEVEL assertions of the three conditions WebKit requires for a
 * wrapped page's `env(safe-area-inset-*)` to be non-zero:
 *   1. the WKWebView frame extends under the bars (NS `iosOverflowSafeArea = true` — default is
 *      false, which routes layout through shrinkToSafeArea and zeroes the view's safeAreaInsets),
 *   2. `scrollView.contentInsetAdjustmentBehavior = .never` (2) — otherwise WebKit consumes the
 *      insets as contentInset instead of exposing them to CSS,
 *   3. the injected viewport meta keeps/adds `viewport-fit=cover` (never strips the page's own).
 * Field bug this pins: loader:'server' app on a notch device rendered under the status bar with
 * env() = 0, so the site's own (correct) safe-area padding collapsed.
 */
const shellDir = join(import.meta.dir, '..', 'app', 'shell');
const iosSrc = readFileSync(join(shellDir, 'custom-webview.ios.ts'), 'utf8');

describe('iOS WKWebView exposes real safe-area insets to page CSS', () => {
  test('CustomWebView opts into NS full-bleed layout (iosOverflowSafeArea)', () => {
    expect(iosSrc).toMatch(/this\.iosOverflowSafeArea\s*=\s*true/);
  });

  test('scrollView contentInsetAdjustmentBehavior is .never', () => {
    expect(iosSrc).toMatch(/scrollView\.contentInsetAdjustmentBehavior\s*=\s*2/);
  });

  test('injected viewport meta preserves/adds viewport-fit=cover', async () => {
    const { NATIVE_FEEL_JS } = await import('../app/shell/web-quirks');
    // Adds cover only when the page's meta doesn't already declare a viewport-fit (never overrides).
    expect(NATIVE_FEEL_JS).toContain("if (!/viewport-fit/.test(c)) c += ', viewport-fit=cover'");
    // WebKit honors the LAST viewport meta — normalizing the first (or an injected one) is silently
    // reverted by a page's own later meta (device-verified: env() stayed 0 with perfect native insets).
    expect(NATIVE_FEEL_JS).toContain('metas[metas.length - 1]');
    // SPA head managers rewrite the meta after load — the observer re-normalizes.
    expect(NATIVE_FEEL_JS).toContain('MutationObserver');
  });
});
