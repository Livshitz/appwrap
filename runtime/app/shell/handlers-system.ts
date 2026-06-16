import { Application, Color, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

declare const android: any, androidx: any;

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

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
