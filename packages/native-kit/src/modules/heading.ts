import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

export interface HeadingSample {
  /** Compass heading in degrees, 0–360 (0 = north, 90 = east). */
  deg: number;
  /** Heading accuracy in degrees (± this many deg), when the platform reports it. */
  accuracy?: number;
}

export class HeadingModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('heading');
  }

  /** Stream compass heading updates; resolves an unsubscribe once streaming starts. Requests
   * sensor permission (iOS gesture gate) on first use. Mirrors {@link MotionModule.watch}. */
  async watch(cb: (sample: HeadingSample) => void, opts?: { hz?: number }): Promise<Unsubscribe> {
    const off = this.kit.on('heading.data', (p) => cb(p as HeadingSample));
    try {
      await this.kit.invoke('heading.start', opts?.hz ? { hz: opts.hz } : undefined);
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
        .invoke('heading.stop')
        .catch((e) => console.warn('[native-kit] heading.stop failed', e));
    };
  }
}
