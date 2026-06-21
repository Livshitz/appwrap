import { ApplicationSettings, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';
import { onPwaHandshake } from './events';
import { showToast } from './toast';
import { showBanner, dismissBanner } from './banner';
import { setStatusBarStyle } from './status-bar';
import { buildCapabilityMap } from './capabilities.manifest';
import { ACTIVE_MODULE_NAMES } from './active-modules.generated';
import { consumePendingBackgroundTaskId } from './background-context';

/** Build identifier for the native shell bundle — bump per deploy to spot stale bundles. */
export const SHELL_BUILD = 'updates-devmenu-3';

/** Version status the web side (native-kit `kit.updates`) reports via `app.reportWebVersion`. */
export interface WebVersionInfo { current?: string; latest?: string; build?: string | number; updateAvailable?: boolean; }
let lastWebVersion: WebVersionInfo = {};
/** Latest version status the web reported — read by the dev-menu App Info screen. */
export function getReportedWebVersion(): WebVersionInfo { return lastWebVersion; }

/** Register all protocol-v1 handlers. */
export function registerHandlers(): void {
  bridge.register('app.handshake', () => {
    // The PWA's JS is now live → flush any deep link buffered during launch.
    onPwaHandshake();
    // Capability map is composed from the active module set (appwrap.json `modules` → the generated
    // ACTIVE_MODULE_NAMES) + the always-on core, deduped. Opt-out capabilities report 'none' so the
    // kit degrades gracefully. Push is special — gated by per-platform build config, not the manifest.
    const capabilities = buildCapabilityMap(new Set(ACTIVE_MODULE_NAMES), isIOS ? 'ios' : 'android') as Record<string, 'native' | 'none'>;
    capabilities.push = (isIOS ? SHELL_CONFIG.pushIos : SHELL_CONFIG.pushAndroid) ? 'native' : 'none';
    // Background launch: the headless runner (handlers-background) set the wake id before loading this
    // (offscreen) WebView. Report it so `kit.backgroundTask` dispatches the registered handler. Consumed
    // (read-once) so a later foreground handshake in the same process never re-reports a stale wake.
    const backgroundTaskId = consumePendingBackgroundTaskId();
    return {
      protocol: 1,
      platform: isIOS ? 'ios' : 'android',
      app: { id: SHELL_CONFIG.appId, name: SHELL_CONFIG.name, version: SHELL_CONFIG.version, build: SHELL_BUILD, loader: SHELL_CONFIG.loader },
      debug: { lastNotifTap: safeJson(ApplicationSettings.getString('kit:__notifTap', '')) },
      capabilities,
      ...(backgroundTaskId ? { backgroundTaskId } : {}),
    };
  });

  bridge.register('haptics.impact', ({ style = 'medium' }: { style?: string }) => {
    if (isIOS) {
      const styles: Record<string, UIImpactFeedbackStyle> = {
        light: UIImpactFeedbackStyle.Light,
        medium: UIImpactFeedbackStyle.Medium,
        heavy: UIImpactFeedbackStyle.Heavy,
        soft: UIImpactFeedbackStyle.Soft,
        rigid: UIImpactFeedbackStyle.Rigid,
      };
      const generator = UIImpactFeedbackGenerator.alloc().initWithStyle(
        styles[style] ?? UIImpactFeedbackStyle.Medium
      );
      generator.impactOccurred();
    } else if (isAndroid) {
      vibrateAndroid(style === 'heavy' ? 60 : style === 'light' ? 15 : 30);
    }
  });

  bridge.register('haptics.notify', ({ type = 'success' }: { type?: string }) => {
    if (isIOS) {
      const types: Record<string, UINotificationFeedbackType> = {
        success: UINotificationFeedbackType.Success,
        warning: UINotificationFeedbackType.Warning,
        error: UINotificationFeedbackType.Error,
      };
      const gen = UINotificationFeedbackGenerator.alloc().init();
      gen.notificationOccurred(types[type] ?? UINotificationFeedbackType.Success);
    } else if (isAndroid) {
      vibrateAndroid(type === 'error' ? 120 : 60);
    }
  });

  bridge.register('share.share', async ({ title, text, url }: { title?: string; text?: string; url?: string }) => {
    const content = [text, url].filter(Boolean).join('\n');
    if (isIOS) {
      const items = NSMutableArray.new();
      if (content) items.addObject(content);
      const controller = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities(
        items as any,
        null
      );
      const rootVC = Utils.ios.getRootViewController();
      // iPad requires a popover anchor
      if (controller.popoverPresentationController) {
        controller.popoverPresentationController.sourceView = rootVC.view;
      }
      rootVC.presentViewControllerAnimatedCompletion(controller, true, null);
    } else if (isAndroid) {
      const intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
      intent.setType('text/plain');
      if (title) intent.putExtra(android.content.Intent.EXTRA_SUBJECT, title);
      intent.putExtra(android.content.Intent.EXTRA_TEXT, content);
      const chooser = android.content.Intent.createChooser(intent, title ?? 'Share');
      chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
      Utils.android.getApplicationContext().startActivity(chooser);
    }
  });

  bridge.register(
    'share.files',
    ({ files, text }: { files: Array<{ name: string; mimeType: string; base64: string }>; title?: string; text?: string }) => {
      if (!isIOS) return; // Android file share needs a FileProvider (parked)
      const items = NSMutableArray.new();
      if (text) items.addObject(text);
      const tmp = NSTemporaryDirectory();
      (files ?? []).forEach((f, i) => {
        const data = NSData.alloc().initWithBase64EncodedStringOptions(f.base64, 0 as unknown as NSDataBase64DecodingOptions);
        if (!data) return;
        const filePath = tmp + i + '-' + (f.name || 'file'); // index-prefix: avoid same-name collisions in one call
        data.writeToFileAtomically(filePath, true);
        items.addObject(NSURL.fileURLWithPath(filePath));
      });
      const controller = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities(
        items as any,
        null
      );
      const rootVC = Utils.ios.getRootViewController();
      if (controller.popoverPresentationController) {
        controller.popoverPresentationController.sourceView = rootVC.view; // iPad anchor
      }
      rootVC.presentViewControllerAnimatedCompletion(controller, true, null);
    }
  );

  bridge.register('storage.get', ({ key }: { key: string }) =>
    JSON.parse(ApplicationSettings.getString(`kit:${key}`, 'null'))
  );
  bridge.register('storage.set', ({ key, value }: { key: string; value?: unknown }) =>
    ApplicationSettings.setString(`kit:${key}`, JSON.stringify(value ?? null))
  );
  bridge.register('storage.remove', ({ key }: { key: string }) =>
    ApplicationSettings.remove(`kit:${key}`)
  );

  bridge.register('toast.show', ({ message, duration }: { message: string; duration?: 'short' | 'long' }) =>
    showToast(String(message ?? ''), duration ?? 'short')
  );

  // Persistent, tappable banner (e.g. the remote-update "tap to reload" prompt). Tap emits
  // `toast.action` { id } back to the web side.
  bridge.register('toast.banner', ({ id, message }: { id: string; message: string }) =>
    showBanner({ id: String(id ?? 'banner'), message: String(message ?? '') })
  );
  bridge.register('toast.dismissBanner', () => dismissBanner());

  // Hard reload the WebView, bypassing cache — used by the update banner + dev menu.
  bridge.register('app.reload', () => reloadWebView());

  // Web → native version report (native-kit `kit.updates`). Registered ALWAYS — independent of
  // `devMenu` — so server-loader update polling never invokes an UNSUPPORTED handler (which would
  // warn every poll) when the dev menu is off. The dev-menu App Info screen reads it when shown.
  bridge.register('app.reportWebVersion', (p: WebVersionInfo) => { lastWebVersion = p || {}; });

  bridge.register('ui.statusBar.setStyle', ({ style }: { style: 'light' | 'dark' }) =>
    setStatusBarStyle(style)
  );
}

/** Reload the attached WebView from origin, bypassing the HTTP cache (iOS `reloadFromOrigin`,
 * Android `clearCache` + `reload`). No-op if no WebView is attached yet. */
export function reloadWebView(): void {
  const wv = bridge.getWebView();
  if (!wv) return;
  Utils.dispatchToMainThread(() => {
    if (isIOS && wv.ios) {
      (wv.ios as WKWebView).reloadFromOrigin();
    } else if (isAndroid && wv.android) {
      wv.android.clearCache(true);
      wv.android.reload();
    }
  });
}

/** Parse a stored JSON breadcrumb; null if absent/unparseable (diagnostic, never throws). */
function safeJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function vibrateAndroid(ms: number): void {
  const context = Utils.android.getApplicationContext();
  const vibrator = context.getSystemService(android.content.Context.VIBRATOR_SERVICE);
  vibrator?.vibrate(ms);
}
