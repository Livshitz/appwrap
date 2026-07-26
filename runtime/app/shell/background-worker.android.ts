import { Utils } from '@nativescript/core';
import { runHeadless, finishRun } from './handlers-background';

// androidx (WorkManager) isn't in @nativescript/types-android — it's an AndroidX library, not the
// platform SDK — so it stays `any`. `java` resolves from the SDK typings; `NativeClass`/`JavaProxy`
// are ambient NativeScript runtime globals.
declare const androidx: any;
declare const java: any;

/**
 * WorkManager headless Worker — created by WorkManager on a background launch. `doWork()` posts to the
 * MAIN looper (the WebView must be built + driven on the UI thread), runs the headless WebView loop for
 * the input task id, and blocks the worker thread on a `CountDownLatch` until `backgroundTask.finish`
 * (or a timeout). Returns success/failure; WorkManager handles periodic rescheduling.
 *
 * ANDROID-ONLY (`.android.ts`): a top-level `@JavaProxy` / `extends androidx.work.Worker` class
 * dereferences Android-only globals at module load. In a SHARED file that evaluates on iOS too, that
 * throws during ES-module instantiation → hard launch crash. Isolating it here keeps it off iOS.
 * ⚠ DEVICE-UNVERIFIED — compiles only (see handlers-background.ts header).
 */
@NativeClass()
@JavaProxy('cc.livx.appwrap.AppwrapBackgroundWorker')
export class AppwrapBackgroundWorker extends androidx.work.Worker {
  constructor(context: any, params: any) {
    super(context, params);
  }

  doWork(): any {
    const id = this.getInputData().getString('appwrap.taskId') ?? '';
    if (!id) return androidx.work.ListenableWorker.Result.failure();

    const latch = new java.util.concurrent.CountDownLatch(1);
    const result = { success: false };
    Utils.dispatchToMainThread(() => {
      runHeadless(id)
        .then((ok: boolean) => { result.success = ok; latch.countDown(); })
        .catch(() => { latch.countDown(); });
    });
    // Block the worker thread (bounded — below the WorkManager 10-min ceiling) until the JS handler
    // finishes. A timeout returns failure so WorkManager retries on its schedule.
    const completed = latch.await(9, java.util.concurrent.TimeUnit.MINUTES);
    if (!completed) finishRun(id, false);
    return completed && result.success
      ? androidx.work.ListenableWorker.Result.success()
      : androidx.work.ListenableWorker.Result.failure();
  }
}
