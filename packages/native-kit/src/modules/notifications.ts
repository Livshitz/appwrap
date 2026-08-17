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
  /**
   * Display name of the notification's SENDER (e.g. a mini-app's name). When set,
   * iOS renders a communication-style notification (iOS 15+) and Android posts on a
   * per-sender channel, both showing this name as the "from" identity — the original
   * `title` is demoted to the subtitle. Falls back to a plain notification otherwise.
   */
  sender?: string;
  /**
   * Sender avatar — an image URL or data-URI. Rendered as the circular avatar on
   * iOS (INImage) and the large icon on Android. Ignored if it can't be loaded.
   */
  icon?: string;
  /**
   * App-icon badge count to apply when this notification is DELIVERED (iOS sets the
   * springboard badge on delivery, even while the app is closed). Absent = leave the
   * badge unchanged. Set 0 to clear on delivery.
   */
  badge?: number;
  /**
   * Deliver WITHOUT the alert sound. Default (omitted/false) plays the system alert sound on
   * both platforms — a scheduled notification is an alert, and a silent one is almost never
   * what the caller meant. Android honours this on API 29+ only.
   */
  silent?: boolean;
  /**
   * Custom alert sound — either a file name the app already bundles, or an http(s) URL to audio in
   * any format (mp3 included). iOS never fetches a sound itself and only plays LinearPCM in a
   * caf/aiff/wav container under 30s, so the shell downloads a URL once, transcodes it, caches it in
   * `Library/Sounds`, and hands the OS the resulting file name. Anything that fails along the way
   * falls back to the DEFAULT alert — never to silence. iOS only; Android uses its channel sound.
   */
  sound?: string;
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
