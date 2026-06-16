import type { NativeKit } from '../core/NativeKit';

export interface ScheduleOptions {
  id?: number;
  title: string;
  body?: string;
  /** Seconds from now (default 1). */
  delaySec?: number;
  /**
   * Deep-link URL fired when the notification is tapped (e.g. 'app://item/7').
   * Delivered through the same `deeplink.open` event as an external open, so
   * `kit.lifecycle.onDeepLink` routes it with no extra wiring.
   */
  deepLink?: string;
}

export class NotificationsModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('notifications');
  }

  /** 'granted' | 'denied' | 'default' */
  requestPermission(): Promise<string> {
    return this.kit.invoke('notifications.requestPermission', undefined, { timeoutMs: 60_000 });
  }

  schedule(options: ScheduleOptions): Promise<{ id: number }> {
    return this.kit.invoke('notifications.schedule', options);
  }

  /** Count of pending (scheduled, not yet delivered) notifications. */
  pending(): Promise<number> {
    return this.kit.invoke('notifications.pending');
  }

  setBadge(count: number): Promise<void> {
    return this.kit.invoke('notifications.setBadge', { count });
  }

  clear(): Promise<void> {
    return this.kit.invoke('notifications.clear');
  }
}
