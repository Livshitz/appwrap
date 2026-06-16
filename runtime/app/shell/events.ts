import { Application, Connectivity, isAndroid } from '@nativescript/core';
import { bridge } from './bridge';
import { connectivityStatus } from './handlers-extended';

let pendingDeepLink: string | null = null;
let pendingPushTap: { data: Record<string, string> } | null = null;
// True only once the PWA's JS has handshaked — i.e. the WebView is actually
// running our bundle and about to subscribe. Native page-load is too early:
// a deeplink.open emitted then lands in a WebView with no listener and is lost
// (the cold-start-from-notification bug). So we gate delivery on the handshake.
let pwaReady = false;

/** Called by the iOS delegate (cold start or while running) and Android intents. */
export function onDeepLink(url: string): void {
  if (pwaReady) bridge.emit('deeplink.open', { url });
  else pendingDeepLink = url; // buffer until the PWA handshakes
}

/** Android: a tray notification (FCM) was tapped → re-launched the activity with the data payload as
 * intent extras. Buffered until handshake like deep links (cold-start-from-notification). iOS routes
 * taps via the AppDelegate (handlers-push onRemoteMessage). */
export function onPushTap(payload: { data: Record<string, string> }): void {
  if (pwaReady) bridge.emit('push.tap', payload);
  else pendingPushTap = payload;
}

/**
 * The PWA completed app.handshake → its JS is live and registers its
 * lifecycle listeners right after kit.ready() resolves. Flush any deep link
 * that arrived during launch (cold start), after a beat for listener install.
 */
export function onPwaHandshake(): void {
  if (pwaReady) return;
  pwaReady = true;
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    setTimeout(() => bridge.emit('deeplink.open', { url }), 500);
  }
  if (pendingPushTap) {
    const payload = pendingPushTap;
    pendingPushTap = null;
    setTimeout(() => bridge.emit('push.tap', payload), 500);
  }
}

/** Wire lifecycle + connectivity event forwarding (the PWA subscribes to these). */
export function startEventForwarding(): void {
  Application.on(Application.suspendEvent, () => bridge.emit('app.pause'));
  Application.on(Application.resumeEvent, () => bridge.emit('app.resume'));
  Application.on(Application.orientationChangedEvent, (args: any) =>
    bridge.emit('screen.orientation.change', args?.newValue === 'landscape' ? 'landscape' : 'portrait')
  );

  Connectivity.startMonitoring(() => bridge.emit('network.change', connectivityStatus()));

  if (isAndroid) wireAndroidDeepLinks();
}

/** Intents: launch intent (cold start) + onNewIntent (warm, singleTask). Carries both VIEW deep links
 * and FCM notification-tap extras. */
function wireAndroidDeepLinks(): void {
  const emitFromIntent = (intent: any) => {
    try {
      const data = intent?.getData?.();
      if (data) onDeepLink(String(data.toString()));
      const tap = readFcmTapExtras(intent);
      if (tap) onPushTap(tap);
    } catch (e) {
      console.warn('AppWrap: intent read failed', e);
    }
  };

  Application.android.on(Application.android.activityNewIntentEvent as any, (args: any) =>
    emitFromIntent(args.intent)
  );
  emitFromIntent(Application.android.startActivity?.getIntent?.());
}

/** A tapped FCM notification re-launches the activity with the message's data payload as string
 * extras, alongside FCM's own `google.*`/`gcm.*`/`from`/`collapse_key` bookkeeping keys. Detect via
 * those markers; return the app's data keys only. Null when this isn't an FCM-originated intent. */
function readFcmTapExtras(intent: any): { data: Record<string, string> } | null {
  try {
    const extras = intent?.getExtras?.();
    if (!extras || (!extras.containsKey('google.message_id') && !extras.containsKey('from'))) return null;
    const data: Record<string, string> = {};
    const it = extras.keySet().iterator();
    while (it.hasNext()) {
      const k = String(it.next());
      if (k.startsWith('google.') || k.startsWith('gcm.') || k === 'from' || k === 'collapse_key') continue;
      const v = extras.get(k);
      if (v != null) data[k] = String(v);
    }
    return { data };
  } catch (e) {
    console.warn('AppWrap: FCM extras read failed', e);
    return null;
  }
}
