import { Application, isIOS } from '@nativescript/core';
import { onDeepLink, onShortcut, onUserActivity } from './shell/events';
import { iosOrientationMask } from './shell/orientation';
import { installForegroundNotificationDelegate } from './shell/handlers-extended';
import { onApnsToken, onApnsError, onRemoteMessage } from './shell/handlers-push';
import { registerBackgroundLaunchHandlers } from './shell/background-bootstrap.generated';

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
  /** A quick action set with a `url` (app.setShortcuts) opens that deep link; else it is the `app.shortcut` id. */
  const shortcutFired = (item: UIApplicationShortcutItem) => {
    const url = item.userInfo?.objectForKey('url');
    if (url) onDeepLink(String(url));
    else onShortcut(String(item.type));
  };
  /** Universal links (https://<associated-domain>/...) arrive as a browsing user activity, NOT a URL open.
   * Any other activity (a CallKit Recents redial: INStartCallIntent) goes to a module pack (setUserActivityHandler). */
  const activityFired = (userActivity: NSUserActivity): boolean => {
    if (userActivity.activityType === NSUserActivityTypeBrowsingWeb && userActivity.webpageURL) {
      console.log('AppWrap: universalLink', userActivity.webpageURL.absoluteString);
      onDeepLink(userActivity.webpageURL.absoluteString);
      return true;
    }
    console.log('AppWrap: userActivity', userActivity.activityType);
    return onUserActivity(userActivity);
  };
  const urlContextsFired = (contexts: NSSet<UIOpenURLContext> | null) => {
    const all = contexts?.allObjects;
    for (let i = 0; i < (all?.count ?? 0); i++) {
      const url = (all.objectAtIndex(i) as UIOpenURLContext).URL;
      console.log('AppWrap: openURL', url.absoluteString);
      onDeepLink(url.absoluteString);
    }
  };

  // UIScene lifecycle (iOS 27 traps apps that don't adopt it). The CLI stamps UIApplicationSceneManifest,
  // so UIKit asks the app delegate for a scene config and then sends URL opens / user activities / quick
  // actions to the SCENE delegate instead of the app delegate. @nativescript/core's SceneDelegate creates
  // the window and boots the app, but it can't be subclassed ("already extended native object"), so this
  // delegate WRAPS one: lifecycle calls are forwarded, the scene-routed events go to the shell paths.
  @NativeClass()
  class AppWrapSceneDelegate extends UIResponder implements UIWindowSceneDelegate {
    static ObjCProtocols = [UIWindowSceneDelegate];
    private _ns: any;
    private get ns(): any {
      return (this._ns ??= (global as any).SceneDelegate.new());
    }
    get window(): UIWindow {
      return this.ns.window;
    }
    set window(w: UIWindow) {
      this.ns.window = w;
    }

    // Cold launch: the URL / activity / quick action that launched the app rides in connectionOptions.
    sceneWillConnectToSessionOptions(scene: UIScene, session: UISceneSession, options: UISceneConnectionOptions): void {
      this.ns.sceneWillConnectToSessionOptions(scene, session, options);
      urlContextsFired(options?.URLContexts);
      const acts = options?.userActivities?.allObjects;
      for (let i = 0; i < (acts?.count ?? 0); i++) activityFired(acts.objectAtIndex(i));
      if (options?.shortcutItem) shortcutFired(options.shortcutItem);
    }
    sceneDidBecomeActive(scene: UIScene): void { this.ns.sceneDidBecomeActive(scene); }
    sceneWillResignActive(scene: UIScene): void { this.ns.sceneWillResignActive(scene); }
    sceneWillEnterForeground(scene: UIScene): void { this.ns.sceneWillEnterForeground(scene); }
    sceneDidEnterBackground(scene: UIScene): void { this.ns.sceneDidEnterBackground(scene); }
    sceneDidDisconnect(scene: UIScene): void { this.ns.sceneDidDisconnect(scene); }
    sceneOpenURLContexts(_scene: UIScene, contexts: NSSet<UIOpenURLContext>): void {
      urlContextsFired(contexts);
    }
    sceneContinueUserActivity(_scene: UIScene, userActivity: NSUserActivity): void {
      activityFired(userActivity);
    }
    windowScenePerformActionForShortcutItemCompletionHandler(
      _scene: UIWindowScene,
      shortcutItem: UIApplicationShortcutItem,
      completionHandler: (done: boolean) => void
    ): void {
      shortcutFired(shortcutItem);
      completionHandler(true);
    }
  }
  @NativeClass()
  class AppWrapAppDelegate extends UIResponder implements UIApplicationDelegate {
    static ObjCProtocols = [UIApplicationDelegate];

    // Scene lifecycle: every scene gets AppWrapSceneDelegate (the window + scene-routed URL/activity/shortcut events).
    applicationConfigurationForConnectingSceneSessionOptions(
      _app: UIApplication,
      session: UISceneSession,
      _options: UISceneConnectionOptions
    ): UISceneConfiguration {
      const config = UISceneConfiguration.configurationWithNameSessionRole('Default Configuration', session.role);
      config.sceneClass = UIWindowScene as any;
      config.delegateClass = AppWrapSceneDelegate as any;
      return config;
    }
    applicationDidFinishLaunchingWithOptions(_app: UIApplication, launchOptions: NSDictionary<string, any>): boolean {
      // Set the notification delegate NOW so a cold-launch tap's deep link is delivered.
      installForegroundNotificationDelegate();
      // BGTaskScheduler launch handlers MUST be registered here (Apple's rule) — no-op unless the
      // backgroundTask module is active (the CLI wires the generated bootstrap to the real impl).
      registerBackgroundLaunchHandlers();
      const url = launchOptions?.objectForKey(UIApplicationLaunchOptionsURLKey) as NSURL | null;
      if (url) onDeepLink(url.absoluteString ?? String(url));
      // Cold-launch from a home-screen quick action — Apple delivers it ONLY here in launchOptions
      // (performActionForShortcutItem is NOT called for the launch action). Buffered until handshake.
      const shortcut = launchOptions?.objectForKey(UIApplicationLaunchOptionsShortcutItemKey) as UIApplicationShortcutItem | null;
      if (shortcut) shortcutFired(shortcut);
      return true;
    }
    // Pre-scene fallbacks below (scene apps get these via AppWrapSceneDelegate). Warm quick action.
    applicationPerformActionForShortcutItemCompletionHandler(
      _app: UIApplication,
      shortcutItem: UIApplicationShortcutItem,
      completionHandler: (done: boolean) => void
    ): void {
      shortcutFired(shortcutItem);
      completionHandler(true);
    }
    applicationOpenURLOptions(_app: UIApplication, url: NSURL, _options: NSDictionary<string, any>): boolean {
      onDeepLink(url.absoluteString);
      return true;
    }
    // Pre-scene fallback (no UIApplicationSceneManifest): universal links / CallKit redial.
    applicationContinueUserActivityRestorationHandler(
      _app: UIApplication,
      userActivity: NSUserActivity,
      _restorationHandler: (restorableObjects: NSArray<any>) => void
    ): boolean {
      return activityFired(userActivity);
    }
    // Drives `kit.screen.orientation.lock` — UIKit reads this on every rotation.
    applicationSupportedInterfaceOrientationsForWindow(_app: UIApplication, _window: UIWindow): UIInterfaceOrientationMask {
      // iosOrientationMask() returns the raw bitmask as a number; the protocol types it as the enum.
      return iosOrientationMask() as UIInterfaceOrientationMask;
    }
    // ── Remote push (APNs) — delivered to the AppDelegate, bridged to kit.push. ──
    applicationDidRegisterForRemoteNotificationsWithDeviceToken(_app: UIApplication, deviceToken: NSData): void {
      onApnsToken(apnsTokenToHex(deviceToken));
    }
    applicationDidFailToRegisterForRemoteNotificationsWithError(_app: UIApplication, error: NSError): void {
      onApnsError(error?.localizedDescription ?? 'APNs registration failed');
    }
    // Background/silent + content-available pushes (a tapped alert routes via the UN delegate).
    applicationDidReceiveRemoteNotificationFetchCompletionHandler(
      _app: UIApplication,
      userInfo: NSDictionary<any, any>,
      completionHandler: (result: UIBackgroundFetchResult) => void
    ): void {
      onRemoteMessage(userInfo, false);
      completionHandler(UIBackgroundFetchResult.NewData);
    }
  }
  Application.ios.delegate = AppWrapAppDelegate;
}

Application.run({ moduleName: 'main-page' });
