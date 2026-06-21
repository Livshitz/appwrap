import { Application, isIOS } from '@nativescript/core';
import { onDeepLink, onShortcut } from './shell/events';
import { iosOrientationMask } from './shell/orientation';
import { installForegroundNotificationDelegate } from './shell/handlers-extended';
import { onApnsToken, onApnsError, onRemoteMessage } from './shell/handlers-push';

/** APNs device token (NSData) → lowercase hex string the push backend expects. */
function apnsTokenToHex(deviceToken: NSData): string {
  const bytes = new Uint8Array(interop.bufferFromData(deviceToken));
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

if (isIOS) {
  // Custom delegate for URL-scheme opens. NativeScript tracks lifecycle via
  // UIApplication notifications, so adding a delegate only extends behavior.
  const DelegateClass = (UIResponder as any).extend(
    {
      applicationDidFinishLaunchingWithOptions(_app: UIApplication, launchOptions: NSDictionary<string, any>) {
        // Set the notification delegate NOW so a cold-launch tap's deep link is delivered.
        installForegroundNotificationDelegate();
        const url = launchOptions?.objectForKey(UIApplicationLaunchOptionsURLKey);
        if (url) onDeepLink(url.absoluteString ?? String(url));
        // Cold-launch from a home-screen quick action — Apple delivers it ONLY here in launchOptions
        // (performActionForShortcutItem is NOT called for the launch action). Buffered until handshake.
        const shortcut = launchOptions?.objectForKey(UIApplicationLaunchOptionsShortcutItemKey);
        if (shortcut) onShortcut(String(shortcut.type));
        return true;
      },
      // Warm activation of a quick action (app already running/backgrounded).
      applicationPerformActionForShortcutItemCompletionHandler(
        _app: UIApplication,
        shortcutItem: UIApplicationShortcutItem,
        completionHandler: (done: boolean) => void
      ) {
        onShortcut(String(shortcutItem.type));
        completionHandler(true);
      },
      applicationOpenURLOptions(_app: UIApplication, url: NSURL, _options: NSDictionary<string, any>) {
        console.log('AppWrap: openURL', url.absoluteString);
        onDeepLink(url.absoluteString);
        return true;
      },
      // Drives `kit.screen.orientation.lock` — UIKit reads this on every rotation.
      applicationSupportedInterfaceOrientationsForWindow(_app: UIApplication, _window: any) {
        return iosOrientationMask();
      },
      // ── Remote push (APNs) — delivered to the AppDelegate, bridged to kit.push. ──
      applicationDidRegisterForRemoteNotificationsWithDeviceToken(_app: UIApplication, deviceToken: NSData) {
        onApnsToken(apnsTokenToHex(deviceToken));
      },
      applicationDidFailToRegisterForRemoteNotificationsWithError(_app: UIApplication, error: NSError) {
        onApnsError(error?.localizedDescription ?? 'APNs registration failed');
      },
      // Background/silent + content-available pushes (a tapped alert routes via the UN delegate).
      applicationDidReceiveRemoteNotificationFetchCompletionHandler(
        _app: UIApplication,
        userInfo: NSDictionary<any, any>,
        completionHandler: (result: UIBackgroundFetchResult) => void
      ) {
        onRemoteMessage(userInfo, false);
        completionHandler(UIBackgroundFetchResult.NewData);
      },
    },
    { protocols: [UIApplicationDelegate] }
  );
  Application.ios.delegate = DelegateClass;
}

Application.run({ moduleName: 'main-page' });
