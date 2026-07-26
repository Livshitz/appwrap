import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

export interface GeoPosition {
  lat: number;
  lng: number;
  accuracy?: number;
}

export class GeoModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('geo');
  }

  /** Requests permission on first use. */
  current(): Promise<GeoPosition> {
    return this.kit.invoke('geo.current', undefined, { timeoutMs: 60_000 });
  }

  /** Stream position updates; resolves an unsubscribe once the watch is running. */
  async watch(cb: (pos: GeoPosition) => void): Promise<Unsubscribe> {
    const off = this.kit.on('geo.position', (p) => cb(p as GeoPosition));
    try {
      await this.kit.invoke('geo.watch.start', undefined, { timeoutMs: 60_000 });
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
        .invoke('geo.watch.stop')
        .catch((e) => console.warn('[native-kit] geo.watch.stop failed', e));
    };
  }
}
