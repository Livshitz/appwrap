import type { NativeKit } from '../core/NativeKit';

/**
 * A headless background-task handler. Runs (possibly cold, with no visible WebView) when the OS wakes
 * the app for `ctx.id`. `ctx.signal` aborts when the OS budget is nearly spent (~25s, below the iOS
 * ~30s ceiling) or the OS calls the expiration handler — observe it for any long await and bail
 * promptly, or the OS may kill the app and refuse future wakes. Resolve when done; a rejection is
 * reported to the OS as a failed run (it still reschedules).
 */
export type BackgroundTaskHandler = (ctx: { id: string; signal: AbortSignal }) => Promise<void>;

/** Constraints for {@link BackgroundTaskModule.schedule}. The OS treats these as HINTS — actual wake
 * timing is the OS's call (it batches by power/network/usage), so a wake is opportunistic, not a timer. */
export interface ScheduleBackgroundTaskOptions {
  /** Task id — must be one of `appwrap.json.backgroundTasks` (iOS requires identifiers declared at
   * build time). The same id is matched against the wake handshake + the registered handler. */
  id: string;
  /** Earliest the OS should consider waking again (a floor, not a guarantee). iOS clamps app-refresh
   * to its own minimum; Android `WorkManager` periodic work has a 15-min platform minimum. */
  minIntervalMs?: number;
  /** Only run when the network is reachable (iOS `BGProcessingTaskRequest.requiresNetworkConnectivity`
   * / Android `NetworkType.CONNECTED`). */
  requiresNetwork?: boolean;
  /** Only run while charging (iOS `BGProcessingTaskRequest.requiresExternalPower` / Android
   * `setRequiresCharging`). */
  requiresCharging?: boolean;
}

/** Wall-clock guard below the iOS ~30s background budget. The kit aborts the signal at this point so a
 * handler that ignores the OS expiration still releases the task before the OS force-kills the app. */
const SAFETY_TIMEOUT_MS = 25_000;

/**
 * Headless background execution with a JS-handler contract — ONE API across platforms.
 *
 * Flow: at EVERY launch the app calls {@link register} (idempotent) for each task id. When the OS woke
 * the app for a task, the handshake carries that id ({@link import('../core/types').Handshake.backgroundTaskId});
 * the kit invokes the matching handler with an {@link AbortSignal}, arms a {@link SAFETY_TIMEOUT_MS}
 * abort, and on resolve/reject/timeout calls `backgroundTask.finish` so the shell completes the OS
 * task + reschedules (BGTask is one-shot — it MUST resubmit). Registration may land before OR after
 * {@link NativeKit.ready} resolves; both orderings dispatch (a pending wake is replayed to a late
 * registration, and an early registration is dispatched the moment ready resolves with a wake id).
 *
 * Native (iOS `BGTaskScheduler` + an offscreen `WKWebView`, Android `WorkManager` + a headless
 * `WebView`) reports `capability === 'native'`. Web is honestly `'none'`: a PWA's background-sync
 * lives in a service worker the kit doesn't own — {@link schedule}/{@link cancel} resolve as no-ops
 * and {@link register} records nothing.
 */
export class BackgroundTaskModule {
  private handlers = new Map<string, BackgroundTaskHandler>();
  /** A wake id seen before its handler was registered — replayed on the late {@link register}. */
  private pendingWakeId: string | null = null;
  /** Ids already dispatched this session — guards against a double-fire (replay + ready both matching). */
  private dispatched = new Set<string>();

  constructor(private kit: NativeKit) {}

  /** Called by {@link NativeKit.ready} once the handshake resolves (never triggers the handshake
   * itself — same lazy contract as the rest of the kit). A background launch carries the wake id in
   * the handshake: if its handler already registered (early) → dispatch now; else remember it for the
   * late {@link register}. @internal */
  __onReady(backgroundTaskId?: string): void {
    if (!backgroundTaskId) return;
    if (this.handlers.has(backgroundTaskId)) this.dispatch(backgroundTaskId);
    else this.pendingWakeId = backgroundTaskId;
  }

  /** 'native' on a shell · 'none' on web (PWA background-sync is the app's service-worker concern). */
  get capability() {
    return this.kit.capability('backgroundTask');
  }

  /**
   * Record the handler for `id`. Call at boot on EVERY launch (idempotent — re-registering replaces).
   * If the app was woken for this id (the handshake carried it), the handler dispatches immediately,
   * whether the wake was already known (ready resolved first) or arrives later.
   */
  register(id: string, handler: BackgroundTaskHandler): void {
    this.handlers.set(id, handler);
    if (this.pendingWakeId === id) {
      this.pendingWakeId = null;
      this.dispatch(id);
    }
  }

  /** Ask the OS to (re)schedule a wake for `id`. No-op resolve on web. */
  schedule(opts: ScheduleBackgroundTaskOptions): Promise<void> {
    return this.kit.invoke<void>('backgroundTask.schedule', opts);
  }

  /** Cancel a scheduled task. No-op resolve on web. */
  cancel(id: string): Promise<void> {
    return this.kit.invoke<void>('backgroundTask.cancel', { id });
  }

  /** Run the registered handler under an abort-guarded budget, then report completion to the shell so
   * it finishes the OS task + reschedules. Idempotent per id per session. */
  private async dispatch(id: string): Promise<void> {
    if (this.dispatched.has(id)) return;
    this.dispatched.add(id);
    const handler = this.handlers.get(id);
    if (!handler) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAFETY_TIMEOUT_MS);
    let success = true;
    try {
      await handler({ id, signal: controller.signal });
    } catch (e) {
      success = false;
      console.warn('[native-kit] backgroundTask handler rejected', id, e);
    } finally {
      clearTimeout(timer);
      // Tell the shell to complete the OS task + resubmit the next request. The handler's own work is
      // done; a finish-report failure must not mask it, so swallow (logged) — the OS budget is spent
      // either way.
      await this.kit
        .invoke<void>('backgroundTask.finish', { id, success })
        .catch((e) => console.warn('[native-kit] backgroundTask.finish failed', id, e));
    }
  }
}
