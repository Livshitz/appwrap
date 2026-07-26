import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import { SHELL_CONFIG } from './config';
import { isNonDefaultOverride } from './env-switcher';

/**
 * Keep the screen awake while the shell is pointed at a NON-PRODUCTION backend, so a long on-device test
 * session isn't killed by auto-lock. Companion to `env-banner.ts`: same trigger, same reconcile points.
 *
 * WHY THE BACKEND, NOT THE BUILD: `SHELL_CONFIG.debug` is a BUILD-TIME fact, and it misses the case that
 * actually matters — a RELEASE/TestFlight binary (`debug:false`) whose env-switcher is pointed at lab or a
 * local dev server is a test session in every way that counts, and it auto-locks mid-test. Conversely the
 * signal must never fire for a real user. `isNonDefaultOverride()` is exactly that line: it is true only
 * when a persisted `kit:serverUrlOverride` resolves to a host DIFFERENT from the build-time default
 * (`SHELL_CONFIG.serverUrl`). A real user never sets an override, so this cannot leak into production —
 * and it is the SAME predicate the amber env banner keys off, so "banner visible" ⟺ "screen stays awake",
 * by construction rather than by two rules kept in sync by hand.
 *
 * `debug` is retained as an OR, not a replacement: a debug build has its own reason to stay awake (the
 * inspect/iterate loop) even on the default env. This subsumes the iOS-only `idleTimerDisabled` block that
 * used to sit inline in main-page.ts; the debug-gated Android half still lives in `custom-webview.android.ts`
 * (`wv.setKeepScreenOn(true)`), which is harmlessly redundant with this module's Android path in a debug
 * build — both are idempotent "keep on" assertions, and only this one also covers the env-override case.
 *
 * Inert for `loader !== 'server'` / no envSwitcher config: `isNonDefaultOverride()` returns false via
 * `isEnvSwitcherEnabled()`, so a non-switcher app reduces to the plain `debug` behaviour (no crash).
 */

/** Desired wake-lock state: a non-default backend override (the banner's signal), or a debug build. */
export function shouldKeepAwake(): boolean {
  return !!SHELL_CONFIG.debug || isNonDefaultOverride();
}

let androidRetries = 0; // bounds the boot "activity not ready" retry so it can't spin forever

/** Apply the wake lock natively. iOS: the app-wide idle timer. Android: the window's KEEP_SCREEN_ON flag.
 *
 * The Android boot retry mirrors `env-banner.ts`: at `onPageLoaded` on a relaunch the Activity is not
 * necessarily attached yet, so `foregroundActivity` can be null. Returning silently there would drop the
 * wake lock in exactly the common case (relaunch straight into lab) — so retry, bounded (~2s), and
 * re-read the DESIRED state at each attempt so a switch/reset landing mid-window wins over a stale one. */
function applyKeepAwake(on: boolean): void {
  if (isIOS) {
    Utils.dispatchToMainThread(() => {
      try { UIApplication.sharedApplication.idleTimerDisabled = on; } catch (e) { /* no-op */ }
    });
  } else if (isAndroid) {
    const activity = Application.android?.foregroundActivity || Application.android?.startActivity;
    if (!activity) {
      if (androidRetries++ < 20) setTimeout(() => applyKeepAwake(shouldKeepAwake()), 100);
      return;
    }
    androidRetries = 0;
    activity.runOnUiThread(new java.lang.Runnable({
      run() {
        try {
          const window = activity.getWindow();
          if (!window) return;
          const flag = android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
          on ? window.addFlags(flag) : window.clearFlags(flag);
        } catch (e) { /* no-op */ }
      },
    }));
  }
}

/**
 * Reconcile the wake lock to the EXACT desired state — including turning it OFF. For explicit env
 * transitions only (`applySwitch`, alongside `refreshEnvBanner`), where clearing on a reset-to-default is
 * the whole point. Idempotent.
 */
export function refreshEnvKeepAwake(): void {
  applyKeepAwake(shouldKeepAwake());
}

/**
 * Assert the wake lock if this env wants it — but NEVER write `false`. For the boot and resume paths.
 *
 * WHY ASSERT-ONLY, not a full reconcile: the hosted app may hold the screen on ITSELF — either via the
 * PUBLIC `ui.keepAwake` bridge API (handlers-extended / handlers-android), or via the web Screen Wake Lock
 * API (`navigator.wakeLock`), which Android WebView honours by keeping the same KEEP_SCREEN_ON state. That
 * is not hypothetical: the AGF app holds a `navigator.wakeLock` for the duration of a live room, and the
 * flag is observable on its window (`dumpsys window` → `fl=KEEP_SCREEN_ON`) with no override set at all.
 * A full reconcile on resume would write `false` on the default env and silently CLOBBER that app's own
 * lock after any background trip. Writing `false` here would also buy nothing: a fresh process
 * starts with the idle timer enabled and a fresh Activity window has no KEEP_SCREEN_ON flag, so "off" is
 * already the state at boot. Only the ON direction needs re-asserting.
 *
 * ON DOES need re-asserting: neither platform guarantees the lock survives a background trip. Android
 * drops the window flag outright if the Activity is recreated (config change / process-death restore) —
 * a NEW window has no flag, and `initialized` in main-page.ts would not re-run the boot path.
 */
export function reassertEnvKeepAwake(): void {
  if (shouldKeepAwake()) applyKeepAwake(true);
}
