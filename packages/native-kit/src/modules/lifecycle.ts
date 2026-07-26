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

  /**
   * The deep link the app was COLD-LAUNCHED from (url-scheme open / notification tap that started the
   * app), if any — exposed synchronously from the handshake so the app can route to the target route
   * BEFORE first paint and skip the brief home flash. Returns null on a normal launch or on web.
   * Available once `kit.ready()` has resolved. Warm deep links (app already open) do NOT appear here —
   * subscribe to {@link onDeepLink} for those.
   */
  get launchDeepLink(): string | null {
    return this.kit.handshakeInfo?.deepLink ?? null;
  }
}
