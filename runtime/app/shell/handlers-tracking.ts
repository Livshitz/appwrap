import { isIOS } from '@nativescript/core';
import { bridge } from './bridge';

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Map the ATT status enum (ATTrackingManagerAuthorizationStatus: 0..3) to the kit's string union. */
function statusToString(raw: number): 'notDetermined' | 'restricted' | 'denied' | 'authorized' {
  switch (raw) {
    case ATTrackingManagerAuthorizationStatus.Authorized: return 'authorized';
    case ATTrackingManagerAuthorizationStatus.Denied: return 'denied';
    case ATTrackingManagerAuthorizationStatus.Restricted: return 'restricted';
    default: return 'notDetermined';
  }
}

/**
 * App Tracking Transparency (iOS, `tracking` module). Strippable own-handler file (registered only
 * when the module is active) — a build without `tracking` compiles NO ATT code. Bridges the three kit
 * calls to ATTrackingManager / ASIdentifierManager.
 *
 * iOS-only: the capability is gated `ios:true`/`android:false`, so the kit short-circuits these on
 * other platforms (`capability !== 'native'`) before they ever reach the bridge. The isIOS guard is
 * defence-in-depth so the handler is a no-op if ever loaded elsewhere.
 *
 * DEVICE-UNVERIFIED (compile-verified-only): the ATT prompt + IDFA round-trip cannot be exercised on a
 * USB dev-sideload in this environment. The FFI selectors are verified against @nativescript/types-ios
 * (ATTrackingManager.requestTrackingAuthorizationWithCompletionHandler / .trackingAuthorizationStatus,
 * ASIdentifierManager.sharedManager().advertisingIdentifier). Same honesty bar as the other recent
 * native modules (oauth/billing-sheet): the compile path is proven, on-device behavior is not.
 */
export function registerTrackingHandlers(): void {
  if (!isIOS) return;

  // requestPermission — show the ATT prompt; completion fires async with the chosen status. The
  // completion runs off the main thread; we just translate + resolve. Dismiss-bound on the kit side
  // (timeoutMs:'none') — the user decides at their leisure.
  bridge.register('tracking.requestPermission', () =>
    new Promise((resolve, reject) => {
      try {
        ATTrackingManager.requestTrackingAuthorizationWithCompletionHandler((status: number) => {
          resolve(statusToString(status));
        });
      } catch (e: any) {
        reject(err('NATIVE_ERROR', e?.message ?? 'tracking.requestPermission failed'));
      }
    })
  );

  // status — current authorization WITHOUT prompting.
  bridge.register('tracking.status', () => statusToString(ATTrackingManager.trackingAuthorizationStatus));

  // idfa — the advertising identifier, ONLY while authorized; else undefined. iOS returns an all-zero
  // UUID when not authorized, so we gate on the status AND filter the placeholder.
  bridge.register('tracking.idfa', () => {
    if (ATTrackingManager.trackingAuthorizationStatus !== ATTrackingManagerAuthorizationStatus.Authorized) return undefined;
    const id = ASIdentifierManager.sharedManager().advertisingIdentifier?.UUIDString;
    if (!id || id === '00000000-0000-0000-0000-000000000000') return undefined;
    return id;
  });
}
