import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

export interface MotionSample {
  /** Acceleration incl. gravity, m/s². */
  ax: number;
  ay: number;
  az: number;
  /** Rotation rate, rad/s (absent when no gyro). */
  rx?: number;
  ry?: number;
  rz?: number;
}

/** the adapters' default rate when a watcher passes no hz. */
const DEFAULT_HZ = 10;

export class MotionModule {
  /** live watchers → the hz each asked. ONE native stream serves them all. */
  private hzs = new Map<symbol, number>();
  /** hz the native stream runs at now (0 = stopped). */
  private runningHz = 0;
  /** serializes start/stop so concurrent watch()/unsubscribe never interleave on the adapter. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('motion');
  }

  /** Stream motion samples; resolves an unsubscribe once streaming starts. `opts.hz` sets the emit
   * rate (default 10, clamped 5–60 native-side) — bump it for crisp tilt (e.g. a game asks 60).
   * Every adapter keeps ONE stream and ignores a second `motion.start`, so the module owns the
   * sharing: the stream runs at the HIGHEST rate any live watcher asked (restarted when that
   * changes) and stops only when the last watcher leaves. Without this a 20 Hz watcher opened first
   * (Blank's shake-to-summon) capped a 60 Hz game at 20 Hz, and either unsubscribe killed both. */
  async watch(cb: (sample: MotionSample) => void, opts?: { hz?: number }): Promise<Unsubscribe> {
    const id = Symbol('motion');
    const off = this.kit.on('motion.data', (p) => cb(p as MotionSample));
    this.hzs.set(id, opts?.hz || DEFAULT_HZ);
    try {
      await this.sync();
    } catch (e) {
      off();
      this.hzs.delete(id);
      throw e;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      off();
      this.hzs.delete(id);
      this.sync().catch((e) => console.warn('[native-kit] motion.stop failed', e));
    };
  }

  /** Bring the native stream to the rate the live watchers need (none → stop). */
  private sync(): Promise<void> {
    const run = async () => {
      const want = this.hzs.size ? Math.max(...this.hzs.values()) : 0;
      if (want === this.runningHz) return;
      if (this.runningHz) {
        this.runningHz = 0;
        await this.kit.invoke('motion.stop');
      }
      if (!want) return;
      await this.kit.invoke('motion.start', { hz: want });
      this.runningHz = want;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }
}
