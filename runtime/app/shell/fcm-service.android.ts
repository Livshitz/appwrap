import { Utils } from '@nativescript/core';
import { onFcmMessage } from './handlers-push';

/**
 * Hand-rolled FirebaseMessagingService (plugin-free) — receives FCM messages while the app process
 * is alive and forwards them to the JS bridge as `push.message`. Covers DATA payloads + foreground
 * delivery of notification payloads (which FCM withholds from the tray while the app is foreground).
 *
 * GATING is load-bearing: this class extends a Firebase base that only exists on the classpath when
 * push is wired. It's bundled solely via `fcm-bootstrap.generated.ts` (the CLI imports it only when
 * google-services.json is present) and the `<service>` is stamped into AndroidManifest only then —
 * so a non-push Android build never compiles a class extending an absent base.
 *
 * Tray-notification taps are routed separately (events.ts reads the launch Intent's FCM extras →
 * `push.tap`); this service is the foreground/data path.
 */
@NativeClass()
@JavaProxy('cc.livx.appwrap.AppwrapMessagingService')
export class AppwrapMessagingService extends com.google.firebase.messaging.FirebaseMessagingService {
  onMessageReceived(message: com.google.firebase.messaging.RemoteMessage): void {
    super.onMessageReceived(message);
    try {
      const data: Record<string, string> = {};
      const map = message.getData();
      const keys = map.keySet().toArray();
      for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i]);
        data[k] = String(map.get(k));
      }
      const notif = message.getNotification();
      const title = notif ? notif.getTitle() : undefined;
      const body = notif ? notif.getBody() : undefined;
      // bridge.emit evaluates JS on the live WebView (main-thread only); the service runs on a binder
      // thread. No-ops gracefully if the WebView isn't up (process booted headlessly for a data msg).
      Utils.dispatchToMainThread(() => onFcmMessage(data, title || undefined, body || undefined));
    } catch (e) {
      console.log('[push] onMessageReceived error: ' + e);
    }
  }
}
