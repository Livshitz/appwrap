import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

// SKStoreReviewController comes from the StoreKit typings referenced in references.d.ts. `com` is the
// Android namespace.
declare const com: any;

/**
 * In-app store review prompt — opt-in, strippable (its own handler file + group). Lives apart from
 * the always-bundled parity/system handlers because the Android path references the Play In-App
 * Review classes (`com.google.android.play:review`), a gradle dep that must NOT land in builds that
 * don't enable `reviews` (missing-class crash / dead weight otherwise).
 *
 * iOS: SKStoreReviewController — the OS rate-limits display (may show nothing). Fire-and-forget.
 * Android: Play In-App Review (ReviewManager). HONEST LIMIT — the dialog only actually surfaces for a
 * Play-Store-track install; on a bare emulator / sideload the API resolves WITHOUT showing UI (same
 * class as android-billing). We call the API and resolve gracefully; we never fabricate "shown".
 *
 * DEVICE-UNVERIFIED (any-typed FFI, no device run this session): the Android ReviewManager
 * requestReviewFlow → launchReviewFlow task/listener chain. Compile-clean only.
 */
export function registerReviewsHandlers(): void {
  if (isIOS) registerIos();
  else if (isAndroid) registerAndroid();
}

function registerIos(): void {
  bridge.register('reviews.requestReview', () => {
    Utils.dispatchToMainThread(() => {
      const scene = UIApplication.sharedApplication.keyWindow?.windowScene;
      if (scene && SKStoreReviewController.requestReviewInWindowScene) {
        SKStoreReviewController.requestReviewInWindowScene(scene);
      } else {
        SKStoreReviewController.requestReview();
      }
    });
  });
}

function registerAndroid(): void {
  bridge.register('reviews.requestReview', () =>
    new Promise<void>((resolve) => {
      Utils.dispatchToMainThread(() => {
        try {
          const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
          if (!activity) { resolve(); return; }
          const manager = com.google.android.play.core.review.ReviewManagerFactory.create(activity);
          const request = manager.requestReviewFlow();
          // requestReviewFlow() → Task<ReviewInfo>; on success launchReviewFlow() → Task<Void>.
          // Both tasks COMPLETE even when the OS shows nothing (no Play track / rate-limited), so we
          // resolve on completion regardless — never block, never fabricate a "shown" signal.
          request.addOnCompleteListener(new com.google.android.gms.tasks.OnCompleteListener({
            onComplete(infoTask: any) {
              if (!infoTask.isSuccessful()) { resolve(); return; }
              try {
                const flow = manager.launchReviewFlow(activity, infoTask.getResult());
                flow.addOnCompleteListener(new com.google.android.gms.tasks.OnCompleteListener({
                  onComplete() { resolve(); },
                }));
              } catch (e) {
                console.warn('AppWrap: reviews.launchReviewFlow failed', e);
                resolve();
              }
            },
          }));
        } catch (e) {
          // Play services / review lib absent (e.g. non-GMS device) → honest no-op, don't reject.
          console.warn('AppWrap: reviews.requestReview unavailable', e);
          resolve();
        }
      });
    })
  );
}
