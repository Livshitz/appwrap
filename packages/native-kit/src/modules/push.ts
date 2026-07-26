import type { NativeKit } from '../core/NativeKit';
import { KitError, type Capability, type Unsubscribe } from '../core/types';

/** Which transport produced the token — the consumer's backend needs this to pick the right sender. */
export type PushPlatform = 'apns' | 'fcm';

/** A device push token + its transport. The kit's job ENDS here: ship this to YOUR backend
 * (FCM-direct / OneSignal / custom) — the framework never sends, so it's push-platform-agnostic. */
export interface PushToken {
  platform: PushPlatform;
  token: string;
  /** The app's bundle/package id. On iOS this is the APNs `apns-topic` your backend MUST send
   * (APNs rejects a mismatch with `DeviceTokenNotForTopic`); on Android it's the package id —
   * informational, since FCM doesn't use apns-topic. Optional: absent on web / un-provisioned
   * builds and older shells that don't supply it (a missing topic is tolerated). */
  topic?: string;
}

/** A remote message surfaced to the page. `data` is the sender's custom payload; `title`/`body`
 * are present when the sender included a display (aps.alert / FCM notification). */
export interface PushMessage {
  data: Record<string, unknown>;
  title?: string;
  body?: string;
}

/**
 * Remote push — ONE API across iOS (APNs) and Android (FCM). DEVICE SIDE ONLY:
 * the kit acquires the token + surfaces incoming messages/taps; SENDING is your
 * backend's job (see {@link PushToken}). Provider-agnostic by construction.
 *
 * ```ts
 * if (kit.push.capability === 'native') {
 *   if (await kit.push.requestPermission() === 'granted') {
 *     const { platform, token, topic } = await kit.push.register();
 *     // `topic` = the iOS bundle id → your backend sets it as the APNs apns-topic header.
 *     await fetch('/api/push/register', { method:'POST', body: JSON.stringify({ platform, token, topic }) });
 *   }
 *   kit.push.onMessage((m) => …);   // foreground delivery
 *   kit.push.onTap((m) => …);       // user opened a notification
 * }
 * ```
 */
export class PushModule {
  constructor(private kit: NativeKit) {}

  /** 'native' on a push-enabled shell (APNs/FCM configured), else 'none'. Web push (VAPID)
   * is the app's own concern — the kit reports 'none' rather than pretend to own it. */
  get capability(): Capability {
    return this.kit.is.native ? this.kit.capability('push') : 'none';
  }

  /** Prompt for notification authorization. 'granted' | 'denied'. */
  requestPermission(): Promise<'granted' | 'denied'> {
    return this.kit.invoke('push.requestPermission', undefined, { timeoutMs: 60_000 });
  }

  /** Current authorization WITHOUT prompting — for opt-in funnel analytics.
   * 'notDetermined' means the user hasn't been asked yet. */
  permissionStatus(): Promise<'granted' | 'denied' | 'notDetermined'> {
    return this.kit.invoke('push.permissionStatus');
  }

  /** Register with APNs/FCM and resolve the device token. Call after permission is granted. */
  register(): Promise<PushToken> {
    return this.kit.invoke('push.register', undefined, { timeoutMs: 30_000 });
  }

  /** Stop receiving remote pushes (iOS unregisterForRemoteNotifications / FCM deleteToken). */
  unregister(): Promise<void> {
    return this.kit.invoke('push.unregister');
  }

  /** Foreground message delivery (app open, no tap). */
  onMessage(cb: (m: PushMessage) => void): Unsubscribe {
    return this.kit.on('push.message', (p) => cb(p as PushMessage));
  }

  /** User tapped a notification — carries the same payload + drives navigation. */
  onTap(cb: (m: PushMessage) => void): Unsubscribe {
    return this.kit.on('push.tap', (p) => cb(p as PushMessage));
  }
}
