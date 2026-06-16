import { Application, isAndroid } from '@nativescript/core';

declare const android: any, NSProcessInfo: any, UIAccessibilityIsReduceMotionEnabled: any;

/**
 * Runtime environment hints the page can't reliably detect itself, surfaced natively so a PWA can
 * scale its rendering down inside the shell. Injected at document-start as `window.__APPWRAP__` (see
 * envGlobalsJs) so it's readable BEFORE the page's own scripts decide what to draw.
 *
 *  • isEmulator  — running on an emulator/simulator. Its GPU is software-rasterized, so a full-screen
 *                  CSS/canvas animation that's free on real hardware pegs the host CPU. Apps should
 *                  cap DPR / disable heavy backgrounds when set.
 *  • reduceMotion— the OS "reduce motion" accessibility setting is on. Apps should disable non-essential
 *                  animation (mirrors the `prefers-reduced-motion` media query, but works pre-paint).
 */
export interface AppwrapEnv {
  native: boolean;
  platform: 'android' | 'ios';
  isEmulator: boolean;
  reduceMotion: boolean;
}

export function detectEnv(): AppwrapEnv {
  return isAndroid
    ? { native: true, platform: 'android', isEmulator: androidIsEmulator(), reduceMotion: androidReduceMotion() }
    : { native: true, platform: 'ios', isEmulator: iosIsSimulator(), reduceMotion: iosReduceMotion() };
}

/** Document-start snippet: merge the detected hints onto `window.__APPWRAP__` (idempotent). */
export function envGlobalsJs(): string {
  const env = detectEnv();
  return `;(function(){try{window.__APPWRAP__=Object.assign({},window.__APPWRAP__,${JSON.stringify(env)});}catch(e){}})();`;
}

// ── Android ──────────────────────────────────────────────────────────
function androidIsEmulator(): boolean {
  try {
    const B = android.os.Build;
    const has = (v: any, s: string) => String(v || '').toLowerCase().includes(s);
    return (
      has(B.FINGERPRINT, 'generic') || has(B.FINGERPRINT, 'emulator') || has(B.FINGERPRINT, 'unknown') ||
      has(B.MODEL, 'google_sdk') || has(B.MODEL, 'emulator') || has(B.MODEL, 'android sdk built for') ||
      has(B.MANUFACTURER, 'genymotion') || has(B.BRAND, 'generic') ||
      has(B.HARDWARE, 'goldfish') || has(B.HARDWARE, 'ranchu') || String(B.PRODUCT || '') === 'google_sdk'
    );
  } catch (e) {
    console.warn('AppWrap: emulator detect failed', e);
    return false;
  }
}

function androidReduceMotion(): boolean {
  try {
    const ctx = Application.android.context || Application.android.foregroundActivity;
    // ANIMATOR_DURATION_SCALE == 0 ⇒ user disabled animations (Settings → Accessibility / Developer).
    const scale = android.provider.Settings.Global.getFloat(
      ctx.getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1.0
    );
    return scale === 0;
  } catch (e) {
    console.warn('AppWrap: reduce-motion detect failed', e);
    return false;
  }
}

// ── iOS ──────────────────────────────────────────────────────────────
function iosIsSimulator(): boolean {
  try {
    return NSProcessInfo.processInfo.environment.objectForKey('SIMULATOR_DEVICE_NAME') != null;
  } catch (e) {
    return false;
  }
}

function iosReduceMotion(): boolean {
  try {
    return !!UIAccessibilityIsReduceMotionEnabled();
  } catch (e) {
    return false;
  }
}
