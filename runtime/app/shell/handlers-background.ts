import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';
import { setPendingBackgroundTaskId } from './background-context';
import { CustomWebView } from './custom-webview';
// Android-only WorkManager Worker (@JavaProxy + `extends androidx.work.Worker`). Kept in a `.android.ts`
// file so it's NEVER evaluated on iOS — a top-level Android native class in a shared module dereferences
// `@JavaProxy`/`androidx` at module load, which are undefined on iOS → the whole ES module graph fails to
// instantiate → hard launch crash. iOS resolves the `.ios.ts` stub; registerAndroid() is the only user.
import { AppwrapBackgroundWorker } from './background-worker';

// BackgroundTasks (iOS), NSDate, and the `android`/`java` namespaces resolve from the full SDK
// (@nativescript/types-ios + types-android) — no declares needed.
declare const androidx: any; // no NS types: androidx (not in types-android)

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Headless background execution with a HEADLESS JS HANDLER contract.
 *
 * Bridge methods (called from the app's foreground OR the offscreen background WebView):
 *  - `backgroundTask.schedule` → ask the OS to (re)schedule a wake for an id.
 *  - `backgroundTask.cancel`   → drop a scheduled wake.
 *  - `backgroundTask.finish`   → the JS handler is done → complete the OS task + reschedule.
 *
 * Headless runner (the OS-wake path): {@link registerBackgroundTaskLaunchHandlers} (iOS, called from
 * the AppDelegate at didFinishLaunching) registers a BGTask launch handler per PERMITTED id. On fire
 * it stamps the wake id ({@link setPendingBackgroundTaskId}), builds an OFFSCREEN WebView (reusing
 * `CustomWebView` → same scheme handler + bridge wiring as the visible one), loads the app so the
 * handshake reports the id, and awaits `backgroundTask.finish`. Android runs the same loop inside a
 * `WorkManager` Worker (see {@link AppwrapBackgroundWorker}).
 *
 * ⚠ DEVICE-UNVERIFIED: the native background-wake path (offscreen WebView under BGTask / WorkManager)
 * COMPILES ONLY — it has NOT been run on a device this session. The any-typed FFI hides selector
 * typos and the cold-launch headless-WebView lifecycle is the genuinely device-gated unknown. The
 * bridge contract (schedule/cancel/finish ⇄ kit) and the dispatch logic are unit-tested in the kit.
 */
export function registerBackgroundTaskHandlers(): void {
  if (isIOS) registerIos();
  else if (isAndroid) registerAndroid();
}

/** Permitted task ids (iOS BGTaskSchedulerPermittedIdentifiers / the app's declared set). Read from
 * the stamped Info.plist on iOS; on Android any id WorkManager enqueues is valid. */
function permittedIosIds(): string[] {
  try {
    const arr = NSBundle.mainBundle.objectForInfoDictionaryKey('BGTaskSchedulerPermittedIdentifiers');
    const out: string[] = [];
    const n = arr?.count ?? 0;
    for (let i = 0; i < n; i++) out.push(String(arr.objectAtIndex(i)));
    return out;
  } catch {
    return [];
  }
}

// ── shared headless-run plumbing ────────────────────────────────────────────
// One offscreen WebView per in-flight task id, kept alive (ARC/GC + the bridge attach) until the JS
// handler reports finish. The `finish` handler resolves the matching pending run.
interface PendingRun { resolve: (success: boolean) => void; webView: CustomWebView | null; }
const pendingRuns = new Map<string, PendingRun>();

/** Build an offscreen WebView, attach the bridge, and load the app so its handshake reports `id`. The
 * returned promise resolves when the JS handler calls `backgroundTask.finish` (or `abort()` fires).
 * REUSES `CustomWebView` (scheme handler + bridge injection) — no duplicated transport. */
export function runHeadless(id: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    setPendingBackgroundTaskId(id); // the next handshake reports this wake id
    const webView = new CustomWebView();
    pendingRuns.set(id, { resolve, webView });
    // Detach the bridge from whatever (visible) WebView it held, attach the offscreen one so this run's
    // invokes (incl. backgroundTask.finish) route here. A cold background launch has no visible view.
    bridge.attach(webView);
    Utils.dispatchToMainThread(() => {
      try {
        loadAppInto(webView, id);
      } catch (e) {
        finishRun(id, false); // load failed → report failure, let the OS reschedule
      }
    });
  });
}

// An offscreen WebView's native peer (`.ios`/`.android`) is created lazily; off the visual tree it may
// never materialize (the device-gated cold-launch risk). Bound the poll so we can't spin forever —
// ~2s (40 × 50ms), then give up and let the OS reschedule rather than leak a timer / drain battery.
const LOAD_PEER_MAX_ATTEMPTS = 40;

/** Point an (offscreen) WebView at the app entry — mirrors main-page.loadBundle's loader branches so
 * the same www/app:// / server URL serves the background run. Retries until the native peer exists,
 * bounded by {@link LOAD_PEER_MAX_ATTEMPTS} → finish(false) on exhaustion. */
function loadAppInto(webView: CustomWebView, id: string, attempt = 0): void {
  const retry = (peerMissing: boolean): boolean => {
    if (!peerMissing) return false;
    if (attempt >= LOAD_PEER_MAX_ATTEMPTS) { finishRun(id, false); return true; }
    setTimeout(() => loadAppInto(webView, id, attempt + 1), 50);
    return true;
  };
  if (isIOS) {
    const wk = webView.ios as WKWebView;
    if (retry(!wk)) return;
    if (SHELL_CONFIG.loader === 'server' && SHELL_CONFIG.serverUrl) {
      wk.loadRequest(NSURLRequest.requestWithURL(NSURL.URLWithString(SHELL_CONFIG.serverUrl)));
    } else {
      wk.loadRequest(NSURLRequest.requestWithURL(NSURL.URLWithString(`app://local/${SHELL_CONFIG.entry}`)));
    }
  } else {
    if (retry(!webView.android)) return;
    webView.src = SHELL_CONFIG.loader === 'server' && SHELL_CONFIG.serverUrl
      ? SHELL_CONFIG.serverUrl
      : `https://appwrap.local/${SHELL_CONFIG.entry}`;
  }
}

/** Resolve an in-flight headless run (called by `backgroundTask.finish`, the safety abort, or a load
 * failure). Tears the offscreen WebView's bridge attachment down. Idempotent. */
export function finishRun(id: string, success: boolean): void {
  const run = pendingRuns.get(id);
  if (!run) return;
  pendingRuns.delete(id);
  try { if (bridge.getWebView() === run.webView) bridge.detach(); } catch { /* noop */ }
  run.resolve(success);
}

// ── iOS ─────────────────────────────────────────────────────────────────────
function registerIos(): void {
  const scheduler = () => BGTaskScheduler.sharedScheduler;

  // schedule: app-refresh by default; processing when it needs network/charging (iOS routes those via
  // BGProcessingTaskRequest, which exposes requiresNetworkConnectivity / requiresExternalPower).
  bridge.register('backgroundTask.schedule', (p: any) => {
    const id = String(p?.id ?? '');
    if (!id) throw err('NATIVE_ERROR', 'backgroundTask.schedule: missing id');
    submitIosRequest(id, p);
  });

  bridge.register('backgroundTask.cancel', (p: any) => {
    const id = String(p?.id ?? '');
    if (id) scheduler().cancelTaskRequestWithIdentifier(id);
  });

  // finish: the JS handler is done → resolve the headless run, which (in the launch handler) completes
  // the BGTask + resubmits the next request. Also reschedule here so a finish from the FOREGROUND
  // (manual handler run) keeps the OS wake alive.
  bridge.register('backgroundTask.finish', (p: any) => {
    const id = String(p?.id ?? '');
    const success = p?.success !== false;
    if (id) finishRun(id, success);
  });
}

/** Submit a BGTaskScheduler request for `id`. Processing request when network/charging constrained,
 * else a lighter app-refresh request. `minIntervalMs` → earliestBeginDate floor. */
function submitIosRequest(id: string, p: any): void {
  const needsProcessing = !!p?.requiresNetwork || !!p?.requiresCharging;
  let req: BGProcessingTaskRequest | BGAppRefreshTaskRequest;
  if (needsProcessing) {
    const proc = BGProcessingTaskRequest.alloc().initWithIdentifier(id);
    proc.requiresNetworkConnectivity = !!p?.requiresNetwork;
    proc.requiresExternalPower = !!p?.requiresCharging;
    req = proc;
  } else {
    req = BGAppRefreshTaskRequest.alloc().initWithIdentifier(id);
  }
  if (p?.minIntervalMs) {
    // earliestBeginDate is a JS Date (NS marshals it to NSDate) — `now + interval`.
    req.earliestBeginDate = new Date(Date.now() + Number(p.minIntervalMs));
  }
  // submitTaskRequestError throws via the out-error; NS surfaces it as a thrown JS error.
  // (out-error param omitted — NS marshals the ObjC error into a thrown JS exception.)
  BGTaskScheduler.sharedScheduler.submitTaskRequestError(req);
}

/**
 * Register a BGTask LAUNCH handler per permitted id — MUST run at `applicationDidFinishLaunchingWith
 * Options` (Apple's rule), so the AppDelegate calls this (see the generated background bootstrap). On
 * fire: stamp the wake id, set the task's expirationHandler to abort the run, run the headless WebView
 * loop, then `setTaskCompleted(success:)` + resubmit the next request. @internal (called from app.ts).
 */
export function registerBackgroundTaskLaunchHandlers(): void {
  if (!isIOS) return;
  // This runs INSIDE applicationDidFinishLaunchingWithOptions, so ANY throw here crashes app launch.
  // Guard hard: a background-task convenience must NEVER take down boot. If BGTaskScheduler is
  // unavailable (framework not resolved) or a registration throws (Apple's strict rules), log and
  // continue WITHOUT background wakes rather than crash. Each id is isolated so one bad id can't stop
  // the rest. (`typeof` is a safe undefined-check — no ReferenceError on an absent native global.)
  if (typeof BGTaskScheduler === 'undefined' || !BGTaskScheduler) {
    console.log('[backgroundTask] BGTaskScheduler unavailable — skipping launch-handler registration');
    return;
  }
  for (const id of permittedIosIds()) {
    try {
      // The launch handler runs on the queue we pass (null = a default background queue). It receives the
      // BGTask; we drive the JS handler, then complete + reschedule.
      BGTaskScheduler.sharedScheduler.registerForTaskWithIdentifierUsingQueueLaunchHandler(
        id,
        null as any, // interop: pass nil queue → OS default background queue (param is non-optional)
        (task: BGTask) => {
          // The OS budget is nearly spent → abort the run (the kit also self-aborts at ~25s). Reporting
          // failure lets the OS learn the task overran.
          task.expirationHandler = () => finishRun(id, false);
          runHeadless(id)
            .then((success) => {
              try { submitIosRequest(id, {}); } catch { /* a failed resubmit shouldn't crash the wake */ }
              task.setTaskCompletedWithSuccess(success);
            })
            .catch(() => {
              try { submitIosRequest(id, {}); } catch { /* noop */ }
              task.setTaskCompletedWithSuccess(false);
            });
        }
      );
    } catch (e: any) {
      console.log(`[backgroundTask] launch-handler registration failed for '${id}': ${e?.message ?? e}`);
    }
  }
}

// ── Android (WorkManager) ────────────────────────────────────────────────────
function registerAndroid(): void {
  const ctx = () => Utils.android.getApplicationContext();
  const WM = () => androidx.work.WorkManager.getInstance(ctx());

  bridge.register('backgroundTask.schedule', (p: any) => {
    const id = String(p?.id ?? '');
    if (!id) throw err('NATIVE_ERROR', 'backgroundTask.schedule: missing id');
    // WorkManager periodic floor is 15 min; clamp a smaller hint up so enqueue doesn't reject it.
    const ms = Math.max(15 * 60_000, Number(p?.minIntervalMs ?? 15 * 60_000));
    const builder = new androidx.work.PeriodicWorkRequest.Builder(
      (AppwrapBackgroundWorker as any).class,
      ms, java.util.concurrent.TimeUnit.MILLISECONDS
    );
    // The id rides as input data → the Worker reads it to drive the matching JS handler.
    builder.setInputData(
      new androidx.work.Data.Builder().putString('appwrap.taskId', id).build()
    );
    const constraints = new androidx.work.Constraints.Builder();
    if (p?.requiresNetwork) constraints.setRequiredNetworkType(androidx.work.NetworkType.CONNECTED);
    if (p?.requiresCharging) constraints.setRequiresCharging(true);
    builder.setConstraints(constraints.build());
    WM().enqueueUniquePeriodicWork(id, androidx.work.ExistingPeriodicWorkPolicy.UPDATE, builder.build());
  });

  bridge.register('backgroundTask.cancel', (p: any) => {
    const id = String(p?.id ?? '');
    if (id) WM().cancelUniqueWork(id);
  });

  // finish: resolve the run → the Worker's CountDownLatch releases → doWork returns success/failure.
  // WorkManager reschedules periodic work itself (no resubmit needed, unlike iOS BGTask).
  bridge.register('backgroundTask.finish', (p: any) => {
    const id = String(p?.id ?? '');
    finishRun(id, p?.success !== false);
  });
}

// The WorkManager headless Worker (@JavaProxy `AppwrapBackgroundWorker`) lives in
// `background-worker.android.ts` — see the import at the top of this file for WHY it can't be here.
