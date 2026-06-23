import { Application, ApplicationSettings, Color, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

declare const androidx: any; // no NS types: androidx

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

// SFSafariViewController is a same-app presented surface — on "Done" it can leave the WebView frozen
// (orphaned tracking window / throttled renderer), so recover from its didFinish. Strong-ref the
// delegate while the browser is up (ARC would otherwise free it). Mirrors the OAuth delegate pattern.
let activeSafariDelegate: NSObject | null = null;
@NativeClass()
class SafariDelegate extends NSObject implements SFSafariViewControllerDelegate {
  static ObjCProtocols = [SFSafariViewControllerDelegate];
  static new(): SafariDelegate { return <SafariDelegate>super.new(); }
  safariViewControllerDidFinish(_controller: SFSafariViewController): void {
    activeSafariDelegate = null;
    bridge.getWebView()?.recoverAfterNativeSurface();
  }
}

/** Running on a simulator/emulator? (mirrors env.ts detection; kept local to avoid a cross-import). */
function detectEmulator(): boolean {
  if (isIOS) {
    return NSProcessInfo.processInfo.environment.objectForKey('SIMULATOR_DEVICE_NAME') != null;
  }
  const B = android.os.Build;
  const fp = String(B.FINGERPRINT ?? '');
  return (
    fp.startsWith('generic') ||
    fp.includes('vbox') ||
    fp.includes('test-keys') ||
    String(B.MODEL ?? '').includes('Emulator') ||
    String(B.MANUFACTURER ?? '').includes('Genymotion') ||
    String(B.HARDWARE ?? '').includes('goldfish') ||
    String(B.HARDWARE ?? '').includes('ranchu')
  );
}

/**
 * Install-level environment for analytics/identification. First-party & non-tracking:
 *  - iOS installId = identifierForVendor (NOT IDFA — no ATT prompt needed); source from the
 *    App Store receipt path (sandboxReceipt ⇒ TestFlight). iOS has no clean first/last-install API.
 *  - Android installId = a random UUID persisted in app storage (cleared on uninstall, like IDFV);
 *    source from the installer package name; first/last-install from PackageInfo.
 */
function appEnvironment() {
  const isEmulator = detectEmulator();
  if (isIOS) {
    let source = 'sideload';
    if (isEmulator) source = 'simulator';
    // A dev/ad-hoc build carries embedded.mobileprovision; TestFlight & App Store builds do NOT.
    // Both TestFlight AND dev builds have a `sandboxReceipt`, so the receipt name alone can't tell
    // them apart — the provisioning profile is the reliable discriminator.
    else if (NSBundle.mainBundle.pathForResourceOfType('embedded', 'mobileprovision')) source = 'sideload';
    else {
      const receipt = NSBundle.mainBundle.appStoreReceiptURL;
      const name = receipt?.lastPathComponent ?? '';
      if (name === 'sandboxReceipt') source = 'testflight';
      else if (receipt && NSFileManager.defaultManager.fileExistsAtPath(receipt.path)) source = 'appstore';
    }
    const idfv = UIDevice.currentDevice.identifierForVendor;
    return { source, installId: idfv ? idfv.UUIDString : undefined, isEmulator };
  }
  // Android
  const ctx = Utils.android.getApplicationContext();
  const pm = ctx.getPackageManager();
  const pkg = ctx.getPackageName();
  let source = isEmulator ? 'simulator' : 'sideload';
  let firstInstallAt: number | undefined;
  let lastUpdateAt: number | undefined;
  try {
    const installer = android.os.Build.VERSION.SDK_INT >= 30
      ? pm.getInstallSourceInfo(pkg)?.getInstallingPackageName()
      : pm.getInstallerPackageName(pkg);
    if (!isEmulator && (installer === 'com.android.vending' || installer === 'com.google.android.feedback')) source = 'playstore';
    const pi = pm.getPackageInfo(pkg, 0);
    firstInstallAt = Number(pi.firstInstallTime);
    lastUpdateAt = Number(pi.lastUpdateTime);
  } catch (e) {
    console.warn('AppWrap: app.environment install info failed', e);
  }
  let installId = ApplicationSettings.getString('kit:__installId', '');
  if (!installId) {
    installId = String(java.util.UUID.randomUUID().toString());
    ApplicationSettings.setString('kit:__installId', installId);
  }
  return { source, installId, firstInstallAt, lastUpdateAt, isEmulator };
}

/**
 * System / navigation handlers shared by both platforms (each method branches
 * internally rather than relying on the iOS-first + Android-override split):
 *   app.openUrl       — hand a URL to the OS default handler (leaves the app)
 *   app.openSettings  — open this app's page in the OS Settings app
 *   browser.open      — in-app browser (SFSafariViewController / Chrome Custom Tabs)
 */
export function registerSystemHandlers(): void {
  bridge.register('app.openUrl', ({ url }: { url: string }) => {
    const target = String(url ?? '');
    if (!target) throw err('NATIVE_ERROR', 'app.openUrl: empty url');
    if (isIOS) {
      Utils.dispatchToMainThread(() => {
        const nsUrl = NSURL.URLWithString(target);
        UIApplication.sharedApplication.openURLOptionsCompletionHandler(nsUrl, NSDictionary.new() as any, null);
      });
    } else if (isAndroid) {
      const intent = new android.content.Intent(
        android.content.Intent.ACTION_VIEW,
        android.net.Uri.parse(target)
      );
      intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
      Utils.android.getApplicationContext().startActivity(intent);
    }
  });

  bridge.register('app.openSettings', () => {
    if (isIOS) {
      Utils.dispatchToMainThread(() => {
        const nsUrl = NSURL.URLWithString(UIApplicationOpenSettingsURLString);
        UIApplication.sharedApplication.openURLOptionsCompletionHandler(nsUrl, NSDictionary.new() as any, null);
      });
    } else if (isAndroid) {
      const ctx = Utils.android.getApplicationContext();
      const intent = new android.content.Intent(
        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        android.net.Uri.fromParts('package', ctx.getPackageName(), null)
      );
      intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(intent);
    }
  });

  bridge.register('app.environment', () => appEnvironment());

  // Probe whether the OS can open a URL. Custom schemes need declaring up-front (iOS
  // LSApplicationQueriesSchemes via appwrap.json.queryUrlSchemes; Android <queries> via
  // queryPackages) — common schemes (http/https/tel/mailto/sms) resolve without declaration.
  bridge.register('app.canOpenUrl', ({ url }: { url: string }) => {
    const target = String(url ?? '');
    if (!target) return false;
    if (isIOS) {
      const nsUrl = NSURL.URLWithString(target);
      return !!nsUrl && UIApplication.sharedApplication.canOpenURL(nsUrl);
    }
    if (isAndroid) {
      const pm = Utils.android.getApplicationContext().getPackageManager();
      const intent = new android.content.Intent(
        android.content.Intent.ACTION_VIEW,
        android.net.Uri.parse(target)
      );
      return pm.resolveActivity(intent, 0) != null;
    }
    return false;
  });

  // Home-screen long-press quick actions. iOS: UIApplication.shortcutItems. Android: dynamic
  // ShortcutManager shortcuts (API 25+; no-op below) whose launch intent carries appwrap_shortcut=<id>.
  bridge.register('app.setShortcuts', ({ items }: { items: Array<{ id: string; title: string; subtitle?: string }> }) => {
    const list = (items ?? []).filter((i) => i && i.id && i.title);
    if (isIOS) {
      Utils.dispatchToMainThread(() => {
        const arr = NSMutableArray.alloc().init();
        for (const i of list) {
          const item = UIApplicationShortcutItem.alloc().initWithTypeLocalizedTitleLocalizedSubtitleIconUserInfo(
            String(i.id), String(i.title), i.subtitle ? String(i.subtitle) : null, null, null
          );
          arr.addObject(item);
        }
        UIApplication.sharedApplication.shortcutItems = arr as any;
      });
    } else if (isAndroid) {
      if (android.os.Build.VERSION.SDK_INT < 25) return; // ShortcutManager is API 25+
      const ctx = Utils.android.getApplicationContext();
      const sm = ctx.getSystemService(android.content.Context.SHORTCUT_SERVICE); // API 25+ string const
      if (!sm) return;
      const launchClass = (Application.android.foregroundActivity ?? Application.android.startActivity)?.getClass();
      const shortcuts = new java.util.ArrayList();
      for (const i of list) {
        const intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
        if (launchClass) intent.setClassName(ctx, launchClass.getName());
        intent.putExtra('appwrap_shortcut', String(i.id));
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK | android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP);
        const b = new android.content.pm.ShortcutInfo.Builder(ctx, String(i.id))
          .setShortLabel(String(i.title))
          .setLongLabel(String(i.subtitle ?? i.title))
          .setIntent(intent);
        shortcuts.add(b.build());
      }
      sm.setDynamicShortcuts(shortcuts);
    }
  });

  // Privacy screen — hide content in the app-switcher / block screenshots. iOS: cover the key window
  // with a blur while inactive/backgrounded (wired via the app lifecycle below). Android: FLAG_SECURE.
  bridge.register('screen.setPrivacy', ({ enabled }: { enabled: boolean }) => {
    setPrivacyScreen(!!enabled);
  });

  bridge.register('browser.open', ({ url, toolbarColor }: { url: string; toolbarColor?: string }) => {
    const target = String(url ?? '');
    if (!target) throw err('NATIVE_ERROR', 'browser.open: empty url');
    if (isIOS) {
      Utils.dispatchToMainThread(() => {
        const vc = SFSafariViewController.alloc().initWithURL(NSURL.URLWithString(target));
        if (toolbarColor) vc.preferredControlTintColor = new Color(String(toolbarColor)).ios;
        activeSafariDelegate = SafariDelegate.new();
        vc.delegate = activeSafariDelegate as SFSafariViewControllerDelegate;
        Utils.ios.getRootViewController().presentViewControllerAnimatedCompletion(vc, true, null);
      });
    } else if (isAndroid) {
      Utils.dispatchToMainThread(() => {
        const builder = new androidx.browser.customtabs.CustomTabsIntent.Builder();
        if (toolbarColor) builder.setToolbarColor(new Color(String(toolbarColor)).android);
        const tabs = builder.build();
        const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
        tabs.launchUrl(activity, android.net.Uri.parse(target));
      });
    }
  });
}

// ── privacy screen ────────────────────────────────────────────────────
// iOS keeps the enabled flag + lazily wires the lifecycle hooks once. The cover MUST go on at
// `willResignActive` — that fires BEFORE the app-switcher snapshot, whereas NS's suspendEvent
// (≈ didEnterBackground) fires AFTER it, so suspendEvent alone would leak the first snapshot. We
// observe the raw UIApplicationWillResignActiveNotification for the cover, removing it on
// becomeActive. Android flips FLAG_SECURE immediately (also blocks screenshots).
let privacyEnabled = false;
let privacyCover: UIView | null = null;
let privacyLifecycleWired = false;

function setPrivacyScreen(enabled: boolean): void {
  privacyEnabled = enabled;
  if (isIOS) {
    wireIosPrivacyLifecycle();
    if (!enabled) Utils.dispatchToMainThread(removeIosPrivacyCover); // disabling mid-foreground
  } else if (isAndroid) {
    Utils.dispatchToMainThread(() => {
      const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
      const FLAG_SECURE = android.view.WindowManager.LayoutParams.FLAG_SECURE;
      const window = activity?.getWindow();
      if (!window) return;
      if (enabled) window.setFlags(FLAG_SECURE, FLAG_SECURE);
      else window.clearFlags(FLAG_SECURE);
    });
  }
}

function wireIosPrivacyLifecycle(): void {
  if (privacyLifecycleWired) return;
  privacyLifecycleWired = true;
  const center = NSNotificationCenter.defaultCenter;
  // willResignActive → cover BEFORE the OS captures the app-switcher snapshot (the critical timing).
  center.addObserverForNameObjectQueueUsingBlock(
    UIApplicationWillResignActiveNotification, null, null, () => { if (privacyEnabled) addIosPrivacyCover(); }
  );
  // didBecomeActive → reveal again once the user returns.
  center.addObserverForNameObjectQueueUsingBlock(
    UIApplicationDidBecomeActiveNotification, null, null, () => removeIosPrivacyCover()
  );
}

function addIosPrivacyCover(): void {
  const window = UIApplication.sharedApplication.keyWindow;
  if (!window || privacyCover) return;
  const effect = UIBlurEffect.effectWithStyle(UIBlurEffectStyle.SystemMaterial);
  const blur = UIVisualEffectView.alloc().initWithEffect(effect);
  blur.frame = window.bounds;
  blur.autoresizingMask = UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
  window.addSubview(blur);
  privacyCover = blur;
}

function removeIosPrivacyCover(): void {
  privacyCover?.removeFromSuperview();
  privacyCover = null;
}
