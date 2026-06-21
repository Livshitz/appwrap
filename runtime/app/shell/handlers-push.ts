import { Application, Http, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';

/**
 * Remote push (APNs/FCM) — DEVICE SIDE. Acquires the token + surfaces incoming
 * messages/taps; the SEND backend is the consumer's (kit.push returns a raw token).
 *
 * iOS needs zero extra deps (UIApplication/UNUserNotificationCenter are baseline) — only the
 * `aps-environment` entitlement, which the CLI stamps when `appwrap.json.push` is enabled (gated
 * so it never breaks a personal-team build that can't hold the push entitlement).
 *
 * Android token/permission use Firebase Messaging classes guarded at runtime — present only when
 * the FCM plugin + google-services.json are wired (CLI, gated). Incoming Android delivery
 * (onMessage/onTap) needs a FirebaseMessagingService → lands with the messaging plugin (1b).
 */

// ── bridge the async iOS AppDelegate APNs callbacks back to a pending push.register() ──
let pendingRegister: { resolve: (t: PushToken) => void; reject: (e: Error) => void } | null = null;
let cachedToken: string | null = null;

interface PushToken { platform: 'apns' | 'fcm'; token: string; }

/** POST the device token to the app's configured backend NATIVELY (no WKWebView fetch → no app://
 * cross-origin/CORS wall). The backend stores it + sends pushes. No-op when no URL is configured. */
function registerTokenWithBackend(platform: 'ios' | 'android', token: string): void {
  const url = SHELL_CONFIG.pushRegistrationUrl;
  if (!url) return;
  // NativeScript Http (NOT the global fetch — unreliable in the NS runtime). Native HTTP, no CORS.
  // Guarded: never let a backend-register hiccup break token resolution (this runs before resolve()).
  try {
    Http.request({
      url, method: 'POST', headers: { 'Content-Type': 'application/json' },
      content: JSON.stringify({ token, platform }),
    })
      .then((res) => console.log('[push] token registered with backend → ' + res.statusCode))
      .catch((e: any) => console.log('[push] backend register failed: ' + (e?.message ?? e)));
  } catch (e: any) {
    console.log('[push] backend register threw: ' + (e?.message ?? e));
  }
}

/** iOS AppDelegate → APNs device token arrived. Resolve any pending register() + cache. */
export function onApnsToken(hexToken: string): void {
  cachedToken = hexToken;
  // Log the FULL token so it's readable headlessly (`appwrap logs ios`) to send a test push —
  // mirrors the Android FCM boot-log. The token alone isn't a secret (you still need the APNs key).
  console.log('[push] APNs token: ' + hexToken);
  registerTokenWithBackend('ios', hexToken);
  if (pendingRegister) {
    pendingRegister.resolve({ platform: 'apns', token: hexToken });
    pendingRegister = null;
  }
}

/** iOS AppDelegate → APNs registration failed. */
export function onApnsError(message: string): void {
  if (pendingRegister) {
    pendingRegister.reject(Object.assign(new Error(message), { code: 'NATIVE_ERROR' }));
    pendingRegister = null;
  }
}

/** iOS AppDelegate / UN delegate → a remote notification arrived (tapped = user opened it). */
export function onRemoteMessage(userInfo: any, tapped: boolean): void {
  bridge.emit(tapped ? 'push.tap' : 'push.message', parseApnsPayload(userInfo));
}

/** Android FirebaseMessagingService (fcm-service.android.ts) → a message arrived while the app
 * process is alive. Forwarded as push.message (the foreground/data path; tray-notification taps come
 * via events.ts → push.tap). */
export function onFcmMessage(data: Record<string, string>, title?: string, body?: string): void {
  bridge.emit('push.message', { data, title, body });
}

/** APNs userInfo (NSDictionary or auto-marshalled object) → { data, title?, body? }. */
function parseApnsPayload(userInfo: any): { data: Record<string, unknown>; title?: string; body?: string } {
  const data: Record<string, unknown> = {};
  let title: string | undefined;
  let body: string | undefined;
  const get = (o: any, k: string) => (o && typeof o.objectForKey === 'function' ? o.objectForKey(k) : o?.[k]);
  try {
    const aps = get(userInfo, 'aps');
    const alert = get(aps, 'alert');
    if (alert) {
      if (typeof alert === 'string') body = alert;
      else { title = get(alert, 'title'); body = get(alert, 'body'); }
    }
    // Custom (non-aps) top-level keys → data.
    const keys = userInfo?.allKeys;
    if (keys?.count != null) {
      for (let i = 0; i < keys.count; i++) {
        const k = String(keys.objectAtIndex(i));
        if (k !== 'aps') data[k] = String(userInfo.objectForKey(k));
      }
    } else if (userInfo && typeof userInfo === 'object') {
      for (const k of Object.keys(userInfo)) if (k !== 'aps') data[k] = (userInfo as any)[k];
    }
  } catch {
    /* best-effort parse — never throw on an inbound message */
  }
  return { data, title: title ? String(title) : undefined, body: body ? String(body) : undefined };
}

export function registerPushHandlers(): void {
  bridge.register('push.requestPermission', () => {
    if (isIOS) {
      return new Promise<string>((resolve) => {
        UNUserNotificationCenter.currentNotificationCenter().requestAuthorizationWithOptionsCompletionHandler(
          UNAuthorizationOptions.Alert | UNAuthorizationOptions.Badge | UNAuthorizationOptions.Sound,
          (granted) => resolve(granted ? 'granted' : 'denied')
        );
      });
    }
    if (isAndroid) return androidRequestPermission();
    throw unsupported();
  });

  bridge.register('push.permissionStatus', () => {
    if (isIOS) {
      return new Promise<string>((resolve) => {
        UNUserNotificationCenter.currentNotificationCenter().getNotificationSettingsWithCompletionHandler(
          (settings) => {
            switch (settings.authorizationStatus) {
              case UNAuthorizationStatus.Authorized:
              case UNAuthorizationStatus.Provisional:
              case UNAuthorizationStatus.Ephemeral:
                return resolve('granted');
              case UNAuthorizationStatus.Denied:
                return resolve('denied');
              default:
                return resolve('notDetermined');
            }
          }
        );
      });
    }
    if (isAndroid) return androidPermissionStatus();
    throw unsupported();
  });

  bridge.register('push.register', () => {
    if (isIOS) {
      return new Promise<PushToken>((resolve, reject) => {
        if (cachedToken) return resolve({ platform: 'apns', token: cachedToken });
        pendingRegister = { resolve, reject };
        Utils.dispatchToMainThread(() => UIApplication.sharedApplication.registerForRemoteNotifications());
        setTimeout(() => {
          if (pendingRegister) {
            pendingRegister.reject(Object.assign(new Error('APNs registration timed out'), { code: 'TIMEOUT' }));
            pendingRegister = null;
          }
        }, 25_000);
      });
    }
    if (isAndroid) return androidGetToken();
    throw unsupported();
  });

  bridge.register('push.unregister', () => {
    if (isIOS) {
      Utils.dispatchToMainThread(() => UIApplication.sharedApplication.unregisterForRemoteNotifications());
      cachedToken = null;
      return;
    }
    if (isAndroid) return androidDeleteToken();
  });

  // Debug: auto-acquire + log the FCM token at boot so it's readable HEADLESSLY (adb logcat / appwrap
  // logs) without a UI tap — the dev loop needs the token to send a test push. Android only (iOS push
  // is off on personal teams); no-op when push isn't configured for this platform.
  if (SHELL_CONFIG.debug && isAndroid && SHELL_CONFIG.pushAndroid) {
    androidGetToken()
      .then((t) => console.log('[push] FCM token: ' + t.token))
      .catch((e) => console.log('[push] FCM token error: ' + (e?.message || e)));
  }
}

function unsupported(): Error {
  return Object.assign(new Error('push unsupported on this platform'), { code: 'UNSUPPORTED' });
}

// ── Android (Firebase Messaging) — guarded; classes exist only when FCM is wired ──
function fcm(): any {
  const FM = (global as any).com?.google?.firebase?.messaging?.FirebaseMessaging;
  if (!FM) throw Object.assign(new Error('FCM not configured — wire google-services.json + the messaging plugin'), { code: 'UNSUPPORTED' });
  return FM.getInstance();
}

function androidRequestPermission(): Promise<string> {
  // Android 13+ (API 33) gates notifications behind POST_NOTIFICATIONS; below that it's implicit.
  return new Promise((resolve) => {
    try {
      const ctx = Utils.android.getApplicationContext();
      const sdk = android.os.Build.VERSION.SDK_INT;
      if (sdk < 33) return resolve('granted');
      const pm = android.content.pm.PackageManager;
      const granted = ctx.checkSelfPermission('android.permission.POST_NOTIFICATIONS') === pm.PERMISSION_GRANTED;
      if (granted) return resolve('granted');
      const activity = Application.android.foregroundActivity || Application.android.startActivity;
      Application.android.on(Application.android.activityRequestPermissionsEvent as any, (args: any) => {
        if (args.requestCode !== 7613) return;
        const ok = args.grantResults?.length && args.grantResults[0] === pm.PERMISSION_GRANTED;
        resolve(ok ? 'granted' : 'denied');
      });
      activity.requestPermissions(['android.permission.POST_NOTIFICATIONS'], 7613);
    } catch (e: any) {
      resolve('denied');
    }
  });
}

function androidPermissionStatus(): string {
  // No "not-determined" concept on Android — report the effective on/off state.
  // < API 33 has no runtime perm, but the user can still disable notifications in Settings.
  try {
    const ctx = Utils.android.getApplicationContext();
    const enabled = androidx.core.app.NotificationManagerCompat.from(ctx).areNotificationsEnabled();
    return enabled ? 'granted' : 'denied';
  } catch (e) {
    console.warn('AppWrap: push.permissionStatus failed', e);
    return 'notDetermined';
  }
}

function androidGetToken(): Promise<PushToken> {
  return new Promise((resolve, reject) => {
    try {
      const OnCompleteListener = (global as any).com.google.android.gms.tasks.OnCompleteListener;
      const task = fcm().getToken();
      task.addOnCompleteListener(new OnCompleteListener({
        onComplete(t: any) {
          if (t.isSuccessful()) {
            const tok = String(t.getResult());
            registerTokenWithBackend('android', tok); // parity with iOS onApnsToken
            resolve({ platform: 'fcm', token: tok });
          } else reject(Object.assign(new Error('FCM token fetch failed'), { code: 'NATIVE_ERROR' }));
        },
      }));
    } catch (e: any) {
      reject(e);
    }
  });
}

function androidDeleteToken(): Promise<void> {
  return new Promise((resolve) => {
    try { fcm().deleteToken(); } catch { /* best-effort */ }
    resolve();
  });
}
