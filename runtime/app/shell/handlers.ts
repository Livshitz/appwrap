import { ApplicationSettings, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';
import { onPwaHandshake } from './events';
import { showToast } from './toast';
import { setStatusBarStyle } from './status-bar';
import { buildCapabilityMap } from './capabilities.manifest';
import { ACTIVE_MODULE_NAMES } from './active-modules.generated';

/** Build identifier for the native shell bundle — bump per deploy to spot stale bundles. */
export const SHELL_BUILD = 'oauth-media-speaker-1';

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
    return {
      protocol: 1,
      platform: isIOS ? 'ios' : 'android',
      app: { id: SHELL_CONFIG.appId, name: SHELL_CONFIG.name, version: SHELL_CONFIG.version, build: SHELL_BUILD },
      debug: { lastNotifTap: safeJson(ApplicationSettings.getString('kit:__notifTap', '')) },
      capabilities,
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

  bridge.register('ui.statusBar.setStyle', ({ style }: { style: 'light' | 'dark' }) =>
    setStatusBarStyle(style)
  );
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
