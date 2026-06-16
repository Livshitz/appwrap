import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

export type Orientation = 'portrait' | 'landscape';
/** What to lock to. 'any' releases the lock (same as {@link OrientationController.unlock}). */
export type OrientationLock =
  | 'portrait'
  | 'portrait-upside-down'
  | 'landscape'
  | 'landscape-left'
  | 'landscape-right'
  | 'any';

/** Screen-level controls. Today: orientation; brightness/keepAwake live on `kit.ui`. */
export class ScreenModule {
  readonly orientation: OrientationController;

  constructor(kit: NativeKit) {
    this.orientation = new OrientationController(kit);
  }
}

/**
 * Lock/observe the device orientation — ONE API across platforms.
 *
 * Native pins the app (iOS supported-orientations + geometry update, Android
 * `setRequestedOrientation`). On web the Screen Orientation API needs fullscreen
 * and is widely unsupported (desktop, iOS Safari) — `lock` rejects with
 * `KitError('UNSUPPORTED')` there; gate on {@link capability} or catch it.
 */
export class OrientationController {
  constructor(private kit: NativeKit) {}

  /** 'native' on a shell · 'web' where the Screen Orientation API exists · else 'none'. */
  get capability() {
    return this.kit.capability('orientation');
  }

  lock(orientation: OrientationLock): Promise<void> {
    return this.kit.invoke('screen.orientation.lock', { orientation });
  }

  /** Release the lock (rotate freely again). */
  unlock(): Promise<void> {
    return this.kit.invoke('screen.orientation.unlock');
  }

  current(): Promise<Orientation> {
    return this.kit.invoke('screen.orientation.current');
  }

  onChange(cb: (orientation: Orientation) => void): Unsubscribe {
    return this.kit.on('screen.orientation.change', (p) => cb(p as Orientation));
  }
}
