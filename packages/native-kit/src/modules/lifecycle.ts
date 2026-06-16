import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/**
 * App lifecycle + deep links — pure event surface.
 * Native: shell emits on suspend/resume and on URL-scheme opens.
 * Web: visibilitychange maps to pause/resume; deep links never fire.
 */
export class LifecycleModule {
  constructor(private kit: NativeKit) {}

  onPause(cb: () => void): Unsubscribe {
    return this.kit.on('app.pause', () => cb());
  }

  onResume(cb: () => void): Unsubscribe {
    return this.kit.on('app.resume', () => cb());
  }

  onDeepLink(cb: (url: string) => void): Unsubscribe {
    return this.kit.on('deeplink.open', (p) => cb((p as { url: string }).url));
  }
}
