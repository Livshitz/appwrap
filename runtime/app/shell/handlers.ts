import { ApplicationSettings, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';
import { onPwaHandshake, consumePendingDeepLink } from './events';
import { showToast } from './toast';
import { showBanner, dismissBanner } from './banner';
import { setStatusBarStyle } from './status-bar';
import { buildCapabilityMap } from './capabilities.manifest';
import { ACTIVE_MODULE_NAMES, PACK_MODULES } from './active-modules.generated';
import { consumePendingBackgroundTaskId } from './background-context';
import { settleShare, photoAssetKind, type ShareOutcome, type SaveToPhotosOutcome } from './share-outcome';
import { appwrapNativeLog } from './native-log';

/** Debug-only native diagnostic line → Documents/appwrap-web.log (`appwrap logs ios`). */
const dlog = (line: string) => { if (SHELL_CONFIG.debug) appwrapNativeLog(line); };

/** Build identifier for the native shell bundle — bump per deploy to spot stale bundles. */
export const SHELL_BUILD = 'save-to-photos-1';

/** Version status the web side (native-kit `kit.updates`) reports via `app.reportWebVersion`. */
export interface WebVersionInfo { current?: string; latest?: string; build?: string | number; updateAvailable?: boolean; }
let lastWebVersion: WebVersionInfo = {};
/** Latest version status the web reported — read by the dev-menu App Info screen. */
export function getReportedWebVersion(): WebVersionInfo { return lastWebVersion; }

/**
 * Present the iOS share sheet and resolve when it ENDS — not when it opens — with how it ended
 * (`{ completed, activity? }`, e.g. activity `com.apple.UIKit.activity.SaveToCameraRoll` for "Save
 * Video"). That is what lets a caller say "Saved to Photos"; the sheet itself gives no feedback.
 */
function presentShareSheet(items: NSMutableArray<any>): Promise<ShareOutcome> {
  return new Promise((resolve) => {
    const controller = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities(items, null);
    const rootVC = Utils.ios.getRootViewController();
    // iPad requires a popover anchor
    if (controller.popoverPresentationController) {
      controller.popoverPresentationController.sourceView = rootVC.view;
    }
    let done = false;
    const finish = (o: ShareOutcome | null) => {
      if (done || !o) return;
      done = true;
      dlog(`[native:share] resolve ${JSON.stringify(o)}`);
      resolve(o);
    };
    const presented = () => !!controller.presentingViewController && !controller.beingDismissed;
    controller.completionWithItemsHandler = (activityType: string, completed: boolean) => {
      dlog(`[native:share] completion activity=${activityType} completed=${!!completed} presented=${presented()}`);
      // Recover the WebView on dismiss — a presented sheet can orphan a touch-stealing window / leave
      // the renderer throttled (see CustomWebView.recoverAfterNativeSurface).
      bridge.getWebView()?.recoverAfterNativeSurface();
      const now = settleShare(activityType, !!completed, presented());
      if (now) return finish(now);
      // Still presented: a cancelled sub-activity (sheet stays) OR a dismissal still animating out.
      // Re-check once it would have finished; a later handler call wins if it comes first.
      setTimeout(() => finish(settleShare(null, false, presented())), 700);
    };
    rootVC.presentViewControllerAnimatedCompletion(controller, true, null);
  });
}

/** Register all protocol-v1 handlers. */
export function registerHandlers(): void {
  bridge.register('app.handshake', () => {
    // The PWA's JS is now live → flush any deep link buffered during launch.
    onPwaHandshake();
    // Capability map is composed from the active module set (appwrap.json `modules` → the generated
    // ACTIVE_MODULE_NAMES) + the always-on core, deduped. Opt-out capabilities report 'none' so the
    // kit degrades gracefully. Push is special — gated by per-platform build config, not the manifest.
    const capabilities = buildCapabilityMap(new Set(ACTIVE_MODULE_NAMES), isIOS ? 'ios' : 'android', PACK_MODULES) as Record<string, 'native' | 'none'>;
    capabilities.push = (isIOS ? SHELL_CONFIG.pushIos : SHELL_CONFIG.pushAndroid) ? 'native' : 'none';
    // Background launch: the headless runner (handlers-background) set the wake id before loading this
    // (offscreen) WebView. Report it so `kit.backgroundTask` dispatches the registered handler. Consumed
    // (read-once) so a later foreground handshake in the same process never re-reports a stale wake.
    const backgroundTaskId = consumePendingBackgroundTaskId();
    // A cold-start deep link buffered during launch is handed back HERE (read-once) so the PWA routes
    // to the target before first paint — no `/home` flash. Warm links (app already running) still
    // arrive via the `deeplink.open` event.
    const deepLink = consumePendingDeepLink();
    return {
      protocol: 1,
      platform: isIOS ? 'ios' : 'android',
      app: { id: SHELL_CONFIG.appId, name: SHELL_CONFIG.name, version: SHELL_CONFIG.version, build: SHELL_BUILD, loader: SHELL_CONFIG.loader },
      debug: { lastNotifTap: safeJson(ApplicationSettings.getString('kit:__notifTap', '')) },
      capabilities,
      ...(backgroundTaskId ? { backgroundTaskId } : {}),
      ...(deepLink ? { deepLink } : {}),
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

  // iOS edge-swipe back (WKWebView allowsBackForwardNavigationGestures, on by default). A page turns it
  // off where WebKit's gesture looks wrong: its snapshots are main-frame-only, so a back over an
  // IFRAME's pushState entry shows a stale picture of the page being left. The page then owns that
  // Back itself. Android has no equivalent gesture → applied:false.
  bridge.register('ui.backGesture', ({ enabled = true }: { enabled?: boolean }) => {
    const wk = isIOS ? (bridge.getWebView()?.ios as WKWebView | undefined) : undefined;
    if (!wk) return { applied: false };
    wk.allowsBackForwardNavigationGestures = !!enabled;
    return { applied: true, enabled: wk.allowsBackForwardNavigationGestures };
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
      return presentShareSheet(items);
    } else if (isAndroid) {
      // The chooser cannot report what (or whether) anything was picked, so there is no outcome to
      // return: resolves undefined, which callers treat as "unknown" (no success feedback).
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
        // 0 = no decoding options; the enum has no zero member, so cast the raw bitmask value.
        const data = NSData.alloc().initWithBase64EncodedStringOptions(f.base64, 0 as unknown as NSDataBase64DecodingOptions);
        if (!data) return;
        const filePath = tmp + i + '-' + (f.name || 'file'); // index-prefix: avoid same-name collisions in one call
        data.writeToFileAtomically(filePath, true);
        items.addObject(NSURL.fileURLWithPath(filePath));
      });
      return presentShareSheet(items);
    }
  );

  // SAVE TO PHOTOS — write straight into the library, no sheet. The "Save" a camera app offers is
  // this, not a share sheet with a Save row among twenty others. Add-only access (the same
  // NSPhotoLibraryAddUsageDescription the share module already stamps), so the person is never asked
  // to expose their library just to receive one clip. Resolves { saved } — a refusal is a value, not
  // a throw, so the caller can say something honest. Android overrides this in handlers-android.
  bridge.register(
    'share.saveToPhotos',
    ({ name, mimeType, base64 }: { name?: string; mimeType?: string; base64: string }): Promise<SaveToPhotosOutcome> | SaveToPhotosOutcome => {
      const kind = photoAssetKind(mimeType, name);
      if (!isIOS || !kind) return { saved: false, reason: 'unsupported', message: kind ? 'no photo library here' : 'only photos and videos can be saved to Photos' };
      return new Promise((resolve) => {
        PHPhotoLibrary.requestAuthorizationForAccessLevelHandler(PHAccessLevel.AddOnly, (status) => {
          dlog(`[native:photos] add-only authorization status=${status}`);
          // Authorized = 3, Limited = 4. Limited still permits adding.
          if (status !== 3 && status !== 4) return resolve({ saved: false, reason: 'denied', message: 'Photos access is off for this app' });
          const data = NSData.alloc().initWithBase64EncodedStringOptions(base64 ?? '', 0 as unknown as NSDataBase64DecodingOptions);
          if (!data) return resolve({ saved: false, reason: 'failed', message: 'could not read that file' });
          // A real extension matters: Photos sniffs the container from the file URL.
          const ext = (String(name ?? '').match(/\.[A-Za-z0-9]+$/)?.[0]) ?? (kind === 'video' ? '.mp4' : '.jpg');
          const filePath = NSTemporaryDirectory() + 'save-' + Date.now() + ext;
          if (!data.writeToFileAtomically(filePath, true)) return resolve({ saved: false, reason: 'failed', message: 'could not stage that file' });
          const url = NSURL.fileURLWithPath(filePath);
          PHPhotoLibrary.sharedPhotoLibrary().performChangesCompletionHandler(
            () => {
              PHAssetCreationRequest.creationRequestForAsset().addResourceWithTypeFileURLOptions(
                kind === 'video' ? PHAssetResourceType.Video : PHAssetResourceType.Photo, url, null);
            },
            (ok, error) => {
              NSFileManager.defaultManager.removeItemAtPathError(filePath);
              dlog(`[native:photos] save ${kind} ok=${ok}${error ? ' err=' + error.localizedDescription : ''}`);
              resolve(ok ? { saved: true } : { saved: false, reason: 'failed', message: error?.localizedDescription || 'Photos refused that file' });
            }
          );
        });
      });
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

  bridge.register('toast.show', ({ message, duration }: { message: string; duration?: 'short' | 'long' }) => {
    dlog(`[native:toast] show "${message}" presentedOver=${isIOS ? !!Utils.ios.getRootViewController()?.presentedViewController : "n/a"}`);
    return showToast(String(message ?? ''), duration ?? 'short');
  });

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
  const vibrator = context.getSystemService(android.content.Context.VIBRATOR_SERVICE) as android.os.Vibrator;
  vibrator?.vibrate(ms);
}
