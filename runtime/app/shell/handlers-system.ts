import { Application, ApplicationSettings, Color, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

declare const android: any, androidx: any, java: any;

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

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

  bridge.register('browser.open', ({ url, toolbarColor }: { url: string; toolbarColor?: string }) => {
    const target = String(url ?? '');
    if (!target) throw err('NATIVE_ERROR', 'browser.open: empty url');
    if (isIOS) {
      Utils.dispatchToMainThread(() => {
        const vc = SFSafariViewController.alloc().initWithURL(NSURL.URLWithString(target));
        if (toolbarColor) vc.preferredControlTintColor = new Color(String(toolbarColor)).ios;
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
