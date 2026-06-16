import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/**
 * Step counting. `count()` returns the day's step total; foreground updates come from polling it,
 * and background/while-killed steps are included automatically (the OS records them — no live JS
 * runs while suspended). Opt-in module — enable with `"modules": ["health"]` in appwrap.json.
 *
 * Platform reach:
 *  - **iOS** (HealthKit): today's total from the Health app — aggregates iPhone + Apple Watch + other
 *    sources, recorded by the OS regardless of the app, so it's global and survives an app kill. No
 *    `start()` needed. Requires the `com.apple.developer.healthkit` entitlement + `requestAccess()`.
 *  - **Android** (Health Connect): today's total from the system store — Wear-inclusive, survives a
 *    kill, mirrors iOS. Needs the `READ_STEPS` permission (granted via `requestAccess()`). Falls back
 *    to the `TYPE_STEP_COUNTER` sensor (since `start()`, no kill-survival) when Health Connect isn't
 *    installed.
 */
export class HealthModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('health');
  }

  /** Trigger the OS permission prompt (iOS motion usage · Android ACTIVITY_RECOGNITION).
   * Interactive — generous timeout so it waits for the user to respond to the prompt. */
  requestAccess(): Promise<boolean> {
    return this.kit.invoke<boolean>('health.requestAccess', undefined, { timeoutMs: 60_000 });
  }

  /** Begin counting. Required on Android (registers the sensor listener); a no-op availability
   * check on iOS (which reads history and needs no session). */
  start(): Promise<void> {
    return this.kit.invoke<void>('health.start');
  }

  /** End the counting session (Android: unregisters the listener). */
  stop(): Promise<void> {
    return this.kit.invoke<void>('health.stop');
  }

  /** The day's step count from the platform health store — iOS HealthKit / Android Health Connect
   * (both Wear-inclusive, survive a kill). Android falls back to the step sensor (since `start()`). */
  async count(): Promise<number> {
    const r = await this.kit.invoke<{ steps: number }>('health.count');
    return r?.steps ?? 0;
  }

  /** Start a session and stream the live count (foreground) by polling every `intervalMs`.
   * Resolves an unsubscribe that stops both the poll and the session. */
  async watch(cb: (steps: number) => void, intervalMs = 2000): Promise<Unsubscribe> {
    await this.start();
    const tick = async () => {
      try {
        cb(await this.count());
      } catch (e) {
        console.warn('[native-kit] health.count failed', e);
      }
    };
    await tick();
    const id = setInterval(tick, intervalMs);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(id);
      this.stop().catch((e) => console.warn('[native-kit] health.stop failed', e));
    };
  }
}
