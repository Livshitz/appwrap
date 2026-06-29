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

export class MotionModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('motion');
  }

  /** Stream motion samples; resolves an unsubscribe once streaming starts. `opts.hz` sets the emit
   * rate (default 10, clamped 5–60 native-side) — bump it for crisp tilt (e.g. a game asks 60). */
  async watch(cb: (sample: MotionSample) => void, opts?: { hz?: number }): Promise<Unsubscribe> {
    const off = this.kit.on('motion.data', (p) => cb(p as MotionSample));
    try {
      await this.kit.invoke('motion.start', opts?.hz ? { hz: opts.hz } : undefined);
    } catch (e) {
      off();
      throw e;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      off();
      this.kit
        .invoke('motion.stop')
        .catch((e) => console.warn('[native-kit] motion.stop failed', e));
    };
  }
}
