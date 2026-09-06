import { Application, ApplicationSettings, Connectivity, Device, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { onDeepLink } from './events';
import { geoAuthAction } from './geo-auth';
import { onRemoteMessage } from './handlers-push';
import { uiImageToDataUrl } from './ios-image';
import { notifIdentity, notifActions, bestEffort, bestEffortAsync, type NotifIdentity, type NotifAction } from './notif-identity';
import { resolveSoundName } from './notif-sound';
import { resolveAttachment } from './notif-attachment';
import { sha256Hex } from './sha256';
import { maskForLock, setIosOrientationMask } from './orientation';

interface GeoResult { lat: number; lng: number; accuracy: number; }

// iOS-only native delegates. Defined lazily inside an isIOS-gated factory (mirrors banner.ts) so the
// shared module can instantiate on Android — NSObject/CL*/PH*/UN* are iOS globals, and a top-level
// `extends NSObject` would evaluate at ES-module load and crash the Android shell (ReferenceError).
// any: module-level holders for runtime-built ObjC subclasses; each class BODY stays fully typed.
let GeoDelegate: any, PhotoPickerDelegate: any, ForegroundNotificationDelegate: any;
function ensureIosDelegates(): void {
  if (!isIOS || GeoDelegate) return;

  // CLLocationManager delegate. Closure-captured callbacks (resolve/reject/cleanup) are assigned as
  // instance fields after new() — same pattern as handlers-speech/oauth.
  @NativeClass()
  class GeoDelegateImpl extends NSObject implements CLLocationManagerDelegate {
    static ObjCProtocols = [CLLocationManagerDelegate];
    onResult?: (r: GeoResult) => void;
    onError?: (e: Error) => void;
    onCleanup?: () => void;
    /** Prompt answered (or never shown) → wake the throttled renderer so a response can be delivered. */
    onAuthSettled?: () => void;
    /** Authorized → arm the location timer NOW (never while the prompt is up). */
    onLocating?: () => void;
    static new(): GeoDelegateImpl {
      return <GeoDelegateImpl>super.new();
    }
    locationManagerDidUpdateLocations(_m: CLLocationManager, locations: NSArray<CLLocation>): void {
      const loc = locations.lastObject;
      if (!loc) return;
      const result = {
        lat: loc.coordinate.latitude,
        lng: loc.coordinate.longitude,
        accuracy: loc.horizontalAccuracy,
      };
      this.onCleanup?.();
      this.onResult?.(result);
    }
    locationManagerDidFailWithError(_m: CLLocationManager, error: NSError): void {
      this.onCleanup?.();
      this.onError?.(Object.assign(new Error(error.localizedDescription), { code: 'DENIED' }));
    }
    /** Called by CoreLocation on delegate creation AND on every auth change (i.e. when the system
     * prompt is answered). This is the ONLY dismiss signal the permission alert gives us. */
    locationManagerDidChangeAuthorization(m: CLLocationManager): void {
      // The prompt is a native surface over the WebView: iOS leaves the WebContent renderer THROTTLED
      // for ~30-45s after it, so any response we post would be undeliverable. Every other surface
      // (OAuth/PHPicker/share/billing) already recovers here; geo never did — and the global
      // UIWindowDidBecomeHidden observer is intentionally disarmed (see main-page.ts), so nothing
      // covered it. That is the root of the 60s `geo.current timed out after 60000ms`.
      this.onAuthSettled?.();
      const action = geoAuthAction(m.authorizationStatus);
      if (action.kind === 'start') {
        this.onLocating?.();
        m.startUpdatingLocation();
      } else if (action.kind === 'reject') {
        this.onCleanup?.();
        this.onError?.(Object.assign(new Error(action.message), { code: action.code }));
      }
      // 'request' → the prompt is still up; wait for the user's answer (no timer, no surface churn).
    }
  }
  GeoDelegate = GeoDelegateImpl;

  // PHPickerViewController delegate. Closure-captured opts (dataUrl/maxSize) + resolve assigned post-new().
  @NativeClass()
  class PhotoPickerDelegateImpl extends NSObject implements PHPickerViewControllerDelegate {
    static ObjCProtocols = [PHPickerViewControllerDelegate];
    wantDataUrl?: boolean;
    maxSize?: number;
    onResult?: (r: { picked: boolean; width?: number; height?: number; dataUrl?: string }) => void;
    static new(): PhotoPickerDelegateImpl {
      return <PhotoPickerDelegateImpl>super.new();
    }
    pickerDidFinishPicking(picker: PHPickerViewController, results: NSArray<PHPickerResult>): void {
      picker.dismissViewControllerAnimatedCompletion(true, null);
      // Recover the WebView after the picker dismisses (orphaned-window / renderer-throttle guard).
      bridge.getWebView()?.recoverAfterNativeSurface();
      const result = results.count > 0 ? results.objectAtIndex(0) : null;
      if (!result) return this.onResult?.({ picked: false });
      result.itemProvider.loadObjectOfClassCompletionHandler(UIImage.class(), (img: UIImage) => {
        if (!img) return this.onResult?.({ picked: true });
        const out: { picked: boolean; width?: number; height?: number; dataUrl?: string } =
          { picked: true, width: img.size.width, height: img.size.height };
        if (this.wantDataUrl) out.dataUrl = uiImageToDataUrl(img, this.maxSize ?? 1024);
        this.onResult?.(out);
      });
    }
  }
  PhotoPickerDelegate = PhotoPickerDelegateImpl;

  // UNUserNotificationCenter delegate — foreground present + tap routing. Idempotent singleton (notifDelegate).
  @NativeClass()
  class ForegroundNotificationDelegateImpl extends NSObject implements UNUserNotificationCenterDelegate {
    static ObjCProtocols = [UNUserNotificationCenterDelegate];
    static new(): ForegroundNotificationDelegateImpl {
      return <ForegroundNotificationDelegateImpl>super.new();
    }
    userNotificationCenterWillPresentNotificationWithCompletionHandler(
      _center: UNUserNotificationCenter,
      notification: UNNotification,
      completionHandler: (opts: UNNotificationPresentationOptions) => void
    ): void {
      // Foreground REMOTE push (push trigger) → surface to kit.push.onMessage.
      if (isRemotePush(notification)) onRemoteMessage(notification.request.content.userInfo, false);
      // Present banner + list + sound + badge even while foreground (min target iOS 16).
      completionHandler(
        UNNotificationPresentationOptions.Banner |
          UNNotificationPresentationOptions.List |
          UNNotificationPresentationOptions.Sound |
          UNNotificationPresentationOptions.Badge
      );
    }
    // Notification tapped → route its deep link through the same path as an external open.
    userNotificationCenterDidReceiveNotificationResponseWithCompletionHandler(
      _center: UNUserNotificationCenter,
      response: UNNotificationResponse,
      completionHandler: () => void
    ): void {
      // Tapped REMOTE push → kit.push.onTap (with payload). Local notifs keep the deep-link path below.
      if (isRemotePush(response.notification)) onRemoteMessage(response.notification.request.content.userInfo, true);
      // userInfo may come back as an NSDictionary or an auto-marshalled JS object.
      // any: dual-path payload (NSDictionary vs marshalled JS object) probed dynamically.
      const info: any = response.notification.request.content.userInfo;
      const at = (k: string) => (info ? (typeof info.objectForKey === 'function' ? info.objectForKey(k) : info[k]) : null);
      // A BUTTON tap carries the action's own identifier; the banner body carries the default one.
      // Each button's target was stamped as `a:<id>` at schedule time — fall back to the body's
      // `url` so a button with no target of its own still opens the app rather than doing nothing.
      const action = String(response.actionIdentifier ?? '');
      const isButton = !!action && action !== UNNotificationDefaultActionIdentifier;
      // A swipe-away cannot reach here at all: the categories we register pass no
      // `.customDismissAction`, so iOS never wakes the delegate for a dismissal — which is
      // exactly the wanted behaviour (a dismiss must not fall through to `url` and launch).
      const url = (isButton && at(`a:${action}`)) || at('url');
      // Diagnostic breadcrumb (persists across the cold relaunch) — surfaced in the handshake's debug field.
      try {
        ApplicationSettings.setString(
          'kit:__notifTap',
          JSON.stringify({ at: Date.now(), url: url ? String(url) : null, action: action || null, hadInfo: !!info })
        );
      } catch {
        /* diagnostic only */
      }
      if (url) onDeepLink(String(url));
      completionHandler();
    }
  }
  ForegroundNotificationDelegate = ForegroundNotificationDelegateImpl;
}

/**
 * Extended capability handlers — iOS-first (Android arrives with the transport upgrade).
 * Each handler is small and self-contained; heavy domains (push, files) come later.
 */
export function registerExtendedHandlers(): void {
  ensureIosDelegates(); // no-op on Android; defines the iOS delegate classes used by the handlers below
  // ── device ─────────────────────────────────────────────────────────
  bridge.register('device.info', () => {
    let battery: { level: number; charging: boolean } | undefined;
    if (isIOS) {
      const dev = UIDevice.currentDevice;
      dev.batteryMonitoringEnabled = true;
      if (dev.batteryLevel >= 0) {
        battery = {
          level: dev.batteryLevel,
          charging:
            dev.batteryState === UIDeviceBatteryState.Charging ||
            dev.batteryState === UIDeviceBatteryState.Full,
        };
      }
    }
    return {
      model: Device.model,
      os: Device.os,
      osVersion: Device.osVersion,
      language: Device.language,
      region: Device.region,
      manufacturer: Device.manufacturer,
      battery,
    };
  });

  // ── clipboard ──────────────────────────────────────────────────────
  bridge.register('clipboard.copy', ({ text }: { text: string }) => {
    if (isIOS) {
      UIPasteboard.generalPasteboard.string = String(text ?? '');
    } else if (isAndroid) {
      const context = Utils.android.getApplicationContext();
      const cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
      cm.setPrimaryClip(android.content.ClipData.newPlainText('appwrap', String(text ?? '')));
    }
  });
  bridge.register('clipboard.read', () => {
    if (isIOS) return UIPasteboard.generalPasteboard.string ?? null;
    if (isAndroid) {
      const context = Utils.android.getApplicationContext();
      const cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
      const clip = cm.getPrimaryClip();
      return clip && clip.getItemCount() > 0 ? String(clip.getItemAt(0).getText() ?? '') : null;
    }
    return null;
  });

  // ── secure storage (Keychain/Keystore via @nativescript/secure-storage) ──
  const secure = new (require('@nativescript/secure-storage').SecureStorage)();
  bridge.register('storage.secure.get', async ({ key }: { key: string }) =>
    (await secure.get({ key: `kit:${key}` })) ?? null
  );
  bridge.register('storage.secure.set', ({ key, value }: { key: string; value: string }): Promise<void> =>
    secure.set({ key: `kit:${key}`, value: String(value ?? '') }).then((): void => undefined)
  );
  bridge.register('storage.secure.remove', ({ key }: { key: string }): Promise<void> =>
    secure.remove({ key: `kit:${key}` }).then((): void => undefined)
  );

  // ── notifications (UNUserNotificationCenter, iOS) ──────────────────
  // iOS suppresses banners while the app is foreground unless a delegate opts in.
  // Without this, a scheduled local notification fires but is never shown on-device.
  installForegroundNotificationDelegate();

  bridge.register('notifications.requestPermission', () => {
    if (!isIOS) throw Object.assign(new Error('iOS only for now'), { code: 'UNSUPPORTED' });
    return new Promise<string>((resolve) => {
      const center = UNUserNotificationCenter.currentNotificationCenter();
      center.requestAuthorizationWithOptionsCompletionHandler(
        UNAuthorizationOptions.Alert | UNAuthorizationOptions.Badge | UNAuthorizationOptions.Sound,
        (granted) => resolve(granted ? 'granted' : 'denied')
      );
    });
  });

  bridge.register('notifications.schedule', async ({ id, title, body, delaySec, deepLink, sender, icon, badge, silent, sound, image, actions }: { id?: number; title?: string; body?: string; delaySec?: number; deepLink?: string; sender?: string; icon?: string; badge?: number; silent?: boolean; sound?: string; image?: string; actions?: NotifAction[] }) => {
    if (!isIOS) throw Object.assign(new Error('iOS only for now'), { code: 'UNSUPPORTED' });
    const nid = id ?? Math.floor(Math.random() * 100000);
    // The OS accepts a request it will never present when authorization is missing (a reinstall
    // resets it). Say so instead of resolving a success the user will never see.
    if (!(await notificationsAuthorized())) {
      throw Object.assign(
        new Error('Notifications are not authorized for this app'),
        { code: 'NOT_AUTHORIZED' }
      );
    }
    const ident = notifIdentity({ title, body, sender, icon });
    const buttons = notifActions(actions);
    // A custom sound is a FILE the OS reads, never a URL it fetches — resolve (download + transcode +
    // cache) before building the content. Null means "unusable", and the default alert takes over
    // below: the app rings with the wrong sound rather than not at all.
    const soundName = !silent && sound
      ? await bestEffortAsync('sound', () => resolveSoundName(String(sound)), null)
      : null;
    // Same rule as the sound: artwork is a FILE the OS reads, never a URL it fetches. Resolve it up
    // front so the content is built once. `image` wins; otherwise the sender icon rides along as the
    // banner thumbnail when communication styling is unavailable (no entitlement / pre-iOS-15) —
    // without it, a mini-app notification would carry NO app artwork at all on those builds.
    const artwork = image ? String(image) : (ident.iconUrl && !communicationStylingAvailable() ? ident.iconUrl : '');
    const attachment = artwork
      ? await bestEffortAsync('artwork', () => resolveAttachment(artwork, `art-${nid}`), null)
      : null;
    return new Promise((resolve, reject) => {
      const content = UNMutableNotificationContent.new();
      content.title = ident.title;
      if (ident.subtitle) content.subtitle = ident.subtitle;
      if (ident.body) content.body = ident.body;
      // App-icon badge on delivery (set before the communication-style wrap so it's carried through).
      if (typeof badge === 'number') content.badge = badge;
      // ALERT SOUND. iOS leaves `content.sound` nil by default, which delivers the notification
      // SILENTLY — so a scheduled timer/alarm fired while the app was backgrounded made no noise at
      // all, with nothing in the API to hint why. Android's side has always played one (its channel
      // is IMPORTANCE_DEFAULT), so the platforms disagreed on the same call. Default to the system
      // alert sound and let a caller opt out with `silent: true`; set BEFORE the communication-style
      // wrap so contentByUpdatingWithProvider carries it through.
      if (!silent) {
        content.sound = soundName
          ? UNNotificationSound.soundNamed(soundName)
          : UNNotificationSound.defaultSound;
      }
      // Group per-sender so the mini-app's notifications thread together (iOS 15+ also
      // uses this alongside the communication-style avatar below).
      if (ident.useIdentity && ident.senderName) content.threadIdentifier = ident.senderName;
      // Carry the deep-link on the notification; the tap delegate re-emits it.
      // Plain JS object → NativeScript marshals it to NSDictionary (more reliable
      // than dictionaryWithObjectForKey across NS versions).
      // cast: NS marshals a plain JS object → NSDictionary at the interop boundary (typed NSDictionary).
      // Carry the tap target AND each button's target: the delegate reads `actionIdentifier` and
      // picks `a:<id>`, falling back to `url` for a tap on the banner body itself.
      const info: Record<string, string> = {};
      if (deepLink) info.url = String(deepLink);
      for (const b of buttons) if (b.deepLink) info[`a:${b.id}`] = b.deepLink;
      if (Object.keys(info).length) content.userInfo = info as any;

      // Buttons live on a CATEGORY, not on the content — iOS looks the category up by id at
      // delivery time, so it must be registered before the request is added.
      if (buttons.length) {
        const category = bestEffort('buttons', () => registerActionCategory(buttons), '');
        if (category) content.categoryIdentifier = category;
      }

      // ARTWORK. A caller-supplied `image` is the hero. With no image, the sender's ICON becomes
      // the attachment whenever the communication path declined — that thumbnail is then the only
      // place the mini-app's own artwork appears, so it is what "identity" degrades to.
      if (attachment) content.attachments = [attachment] as any;

      // iOS 15+ COMMUNICATION notification: present the mini-app as the sender (name +
      // circular avatar) via an INSendMessageIntent. Degrades to the plain `content`
      // above pre-iOS-15 or when styling declines (e.g. missing communication entitlement).
      const finalContent: UNNotificationContent =
        (ident.useIdentity &&
          bestEffort('sender identity', () => communicationContent(content, String(nid), ident), null)) ||
        content;

      const trigger = UNTimeIntervalNotificationTrigger.triggerWithTimeIntervalRepeats(
        Math.max(1, delaySec ?? 1),
        false
      );
      const request = UNNotificationRequest.requestWithIdentifierContentTrigger(
        String(nid),
        finalContent,
        trigger
      );
      UNUserNotificationCenter.currentNotificationCenter().addNotificationRequestWithCompletionHandler(
        request,
        (error) => (error ? reject(new Error(error.localizedDescription)) : resolve({ id: nid }))
      );
    });
  });

  bridge.register('notifications.pending', () => {
    if (!isIOS) return 0;
    return new Promise<number>((resolve) => {
      UNUserNotificationCenter.currentNotificationCenter().getPendingNotificationRequestsWithCompletionHandler(
        (requests) => resolve(requests.count)
      );
    });
  });

  bridge.register('notifications.setBadge', ({ count }: { count: number }) => {
    if (!isIOS) return;
    return new Promise<void>((resolve) => {
      Utils.dispatchToMainThread(() => {
        UNUserNotificationCenter.currentNotificationCenter().setBadgeCountWithCompletionHandler?.(
          count,
          // iOS silently ignores the badge unless notification authorization (incl. .badge) was granted —
          // the completion's error is the ONLY signal, so DON'T swallow it (else the badge just never
          // appears with no explanation). Resolve regardless (the JS call itself didn't fail).
          (error: NSError) => { if (error) console.warn('[appwrap] setBadge ignored — notifications not authorized?', String(error)); }
        );
        resolve();
      });
    });
  });

  bridge.register('notifications.clear', () => {
    if (!isIOS) return;
    const center = UNUserNotificationCenter.currentNotificationCenter();
    center.removeAllPendingNotificationRequests();
    center.removeAllDeliveredNotifications();
  });

  // ── biometrics (LAContext) ─────────────────────────────────────────
  bridge.register('biometrics.available', () => {
    if (!isIOS) return { available: false, type: 'none' };
    const ctx = LAContext.new();
    const available = ctx.canEvaluatePolicyError(
      LAPolicy.DeviceOwnerAuthenticationWithBiometrics
    );
    const type =
      ctx.biometryType === LABiometryType.TypeFaceID ? 'face'
      : ctx.biometryType === LABiometryType.TypeTouchID ? 'touch'
      : 'none';
    return { available, type };
  });

  bridge.register('biometrics.authenticate', ({ reason }: { reason?: string }) => {
    if (!isIOS) throw Object.assign(new Error('iOS only for now'), { code: 'UNSUPPORTED' });
    return new Promise((resolve, reject) => {
      const ctx = LAContext.new();
      ctx.evaluatePolicyLocalizedReasonReply(
        LAPolicy.DeviceOwnerAuthenticationWithBiometrics,
        String(reason ?? 'Authenticate'),
        (success, error) => {
          if (success) resolve({ success: true });
          else reject(Object.assign(new Error(error?.localizedDescription ?? 'failed'), { code: 'DENIED' }));
        }
      );
    });
  });

  // ── geolocation (CLLocationManager) ────────────────────────────────
  // The 15s budget covers ACQUIRING A FIX only — it is armed once we are authorized and locating.
  // It must never cover the permission prompt: the prompt is dismiss-bound (the user may take as long
  // as they like) and it throttles the WebContent renderer, so a timer firing while it is up produces
  // a rejection that CANNOT be delivered — which is precisely how this became a silent 60s hang.
  bridge.register('geo.current', () => {
    if (!isIOS) throw Object.assign(new Error('iOS only for now'), { code: 'UNSUPPORTED' });
    return new Promise((resolve, reject) => {
      let manager: CLLocationManager | null = null;
      let delegate: any = null;
      let timer: any = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        manager?.stopUpdatingLocation();
        manager = null;
        delegate = null;
      };
      const armLocationTimer = () => {
        if (timer) return;
        timer = setTimeout(() => {
          cleanup();
          reject(Object.assign(new Error('location timeout'), { code: 'TIMEOUT' }));
        }, 15000);
      };

      Utils.dispatchToMainThread(() => {
        manager = CLLocationManager.new();
        delegate = GeoDelegate.new();
        delegate.onResult = resolve;
        delegate.onError = reject;
        delegate.onCleanup = cleanup;
        delegate.onLocating = armLocationTimer;
        // Reuse the shared primitive every other native surface already uses (handlers-oauth /
        // PHPicker / share / billing / apple-signin). Idempotent + coalesced ⇒ safe to call when no
        // prompt was ever shown.
        delegate.onAuthSettled = () => bridge.getWebView()?.recoverAfterNativeSurface();
        manager.delegate = delegate;
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
        // Assigning the delegate makes CoreLocation invoke didChangeAuthorization immediately with the
        // current status, which drives every case: denied/restricted reject NOW, authorized arms the
        // timer + locates, notDetermined waits for the prompt below.
        const action = geoAuthAction(manager.authorizationStatus);
        if (action.kind === 'request') manager.requestWhenInUseAuthorization();
      });
    });
  });

  // ── photos (PHPickerViewController) ────────────────────────────────
  bridge.register('photos.pick', ({ dataUrl, maxSize }: { dataUrl?: boolean; maxSize?: number } = {}) => {
    if (!isIOS) throw Object.assign(new Error('iOS only for now'), { code: 'UNSUPPORTED' });
    return new Promise((resolve) => {
      Utils.dispatchToMainThread(() => {
        const config = PHPickerConfiguration.new();
        config.selectionLimit = 1;
        const picker = PHPickerViewController.alloc().initWithConfiguration(config);
        const delegate = PhotoPickerDelegate.new();
        delegate.wantDataUrl = !!dataUrl;
        delegate.maxSize = maxSize;
        delegate.onResult = resolve;
        (picker as any)._appwrapDelegate = delegate; // any: stash extra prop on VC to retain delegate (ARC)
        picker.delegate = delegate;
        Utils.ios.getRootViewController().presentViewControllerAnimatedCompletion(picker, true, null);
      });
    });
  });

  // ── network (NS Connectivity) ──────────────────────────────────────
  bridge.register('network.status', () => connectivityStatus());

  // ── ui extras ──────────────────────────────────────────────────────
  bridge.register('ui.safeArea', () => {
    if (!isIOS) return { top: 0, bottom: 0, left: 0, right: 0 };
    const insets = Utils.ios.getRootViewController().view.safeAreaInsets;
    return { top: insets.top, bottom: insets.bottom, left: insets.left, right: insets.right };
  });

  bridge.register('ui.brightness.get', () => (isIOS ? UIScreen.mainScreen.brightness : 0.5));
  bridge.register('ui.brightness.set', ({ level }: { level: number }) => {
    if (isIOS) {
      Utils.dispatchToMainThread(() => {
        UIScreen.mainScreen.brightness = Math.max(0, Math.min(1, level));
      });
    }
  });

  bridge.register('ui.keepAwake', ({ on }: { on: boolean }) => {
    if (isIOS) {
      Utils.dispatchToMainThread(() => {
        UIApplication.sharedApplication.idleTimerDisabled = !!on;
      });
    }
  });

  // ── screen orientation ─────────────────────────────────────────────
  // current() is cross-platform via core; lock/unlock are iOS here and
  // overridden for Android in registerAndroidHandlers (runs last).
  bridge.register('screen.orientation.current', () =>
    Application.orientation() === 'landscape' ? 'landscape' : 'portrait'
  );
  bridge.register('screen.orientation.lock', ({ orientation }: { orientation: string }) => {
    if (isIOS) applyIosOrientation(maskForLock(String(orientation)));
  });
  bridge.register('screen.orientation.unlock', () => {
    if (isIOS) applyIosOrientation(maskForLock('any'));
  });
}

/** Set the supported-orientation mask and force UIKit to re-evaluate it now (iOS 16+ geometry update). */
function applyIosOrientation(mask: number): void {
  setIosOrientationMask(mask);
  Utils.dispatchToMainThread(() => {
    const rootVC = Utils.ios.getRootViewController();
    rootVC?.setNeedsUpdateOfSupportedInterfaceOrientations?.();
    // any: deliberate runtime probe — reference the iOS-16 geometry class via `global` so PRE-iOS-16
    // runtimes (where it's absent) hit the early-return instead of a hard symbol miss.
    const Prefs: any = (global as any).UIWindowSceneGeometryPreferencesIOS;
    const scenes = UIApplication.sharedApplication.connectedScenes?.allObjects;
    if (!Prefs || !scenes) return; // pre-iOS-16: the mask alone takes effect on next rotation
    for (let i = 0; i < scenes.count; i++) {
      // any: ObjC errorHandler block is nullable — we pass `null`, which the typed (p1)=>void rejects.
      const scene: any = scenes.objectAtIndex(i);
      if (scene?.requestGeometryUpdateWithPreferencesErrorHandler) {
        const prefs = Prefs.alloc().initWithInterfaceOrientations(mask);
        scene.requestGeometryUpdateWithPreferencesErrorHandler(prefs, null);
      }
    }
  });
}

let notifDelegate: any = null; // retained for the app's lifetime
/**
 * Install the UNUserNotificationCenter delegate. MUST run before
 * `didFinishLaunching` returns, else a tap that COLD-LAUNCHES the app never
 * reaches `didReceiveNotificationResponse` (Apple delivers it only to a
 * delegate set during launch) — the deep link is lost and you land on home.
 * Idempotent; also called from registerExtendedHandlers as a warm fallback.
 */
export function installForegroundNotificationDelegate(): void {
  if (!isIOS || notifDelegate) return;
  ensureIosDelegates();
  notifDelegate = ForegroundNotificationDelegate.new();
  UNUserNotificationCenter.currentNotificationCenter().delegate = notifDelegate;
}

/** Load an icon (http(s) URL or data-URI) into NSData for an INImage avatar. Sync
 * fetch — acceptable for a small local-notification icon; returns null on failure. */
function iconNSData(icon: string): NSData | null {
  try {
    if (icon.startsWith('data:')) {
      const comma = icon.indexOf(',');
      const b64 = comma >= 0 ? icon.slice(comma + 1) : '';
      if (!b64) return null;
      return NSData.alloc().initWithBase64EncodedStringOptions(b64, NSDataBase64DecodingOptions.IgnoreUnknownCharacters);
    }
    const url = NSURL.URLWithString(icon);
    return url ? NSData.dataWithContentsOfURL(url) : null;
  } catch (e) {
    console.warn('[appwrap] notification icon load failed', String(e));
    return null;
  }
}

/**
 * Has the user actually granted notifications to THIS install?
 *
 * `addNotificationRequest` succeeds with no error when authorization is missing — the request is
 * accepted and then never presented. A reinstall (or a capability change that forces one) resets
 * authorization, so a schedule call reporting `{id}` is not evidence anything will arrive. Read the
 * center's own answer and fail loudly instead of lying to the caller.
 */
function notificationsAuthorized(): Promise<boolean> {
  return new Promise((resolve) => {
    UNUserNotificationCenter.currentNotificationCenter().getNotificationSettingsWithCompletionHandler(
      (settings) => {
        const s = settings?.authorizationStatus;
        resolve(
          s === UNAuthorizationStatus.Authorized ||
          s === UNAuthorizationStatus.Provisional ||
          s === UNAuthorizationStatus.Ephemeral
        );
      }
    );
  });
}

/**
 * Can this build present a COMMUNICATION notification (mini-app name + circular avatar)?
 *
 * Two independent things must be true, and BOTH are build-time facts, so this is cheap and exact:
 *  1. iOS 15+ — where INSendMessageIntent conforms to UNNotificationContentProviding.
 *  2. The app declares `NSUserActivityTypes` containing `INSendMessageIntent`. The appwrap CLI
 *     stamps that key ONLY when `com.apple.developer.usernotifications.communication` is configured,
 *     and SpringBoard denies the API without the pair — so its absence means the styling WILL
 *     decline at runtime, which is exactly when the icon has to reach the banner some other way.
 */
function communicationStylingAvailable(): boolean {
  if (!isIOS) return false;
  if (!NSProcessInfo.processInfo.isOperatingSystemAtLeastVersion({ majorVersion: 15, minorVersion: 0, patchVersion: 0 })) {
    return false;
  }
  try {
    const types = NSBundle.mainBundle.objectForInfoDictionaryKey('NSUserActivityTypes') as NSArray<string> | null;
    return !!types && types.containsObject('INSendMessageIntent');
  } catch {
    return false;
  }
}

/**
 * Register (idempotently) a UNNotificationCategory carrying `buttons`, and return its identifier.
 *
 * iOS resolves a notification's buttons by looking its `categoryIdentifier` up in the center's
 * category SET at delivery time, and `setNotificationCategories` REPLACES that set — so categories
 * are accumulated here and re-set as a union. The identifier is a hash of the buttons, so the same
 * button set reuses one category instead of growing the set on every schedule call.
 */
const notifCategories = new Map<string, UNNotificationCategory>();
function registerActionCategory(buttons: NotifAction[]): string {
  const key = 'awcat-' + sha256Hex(buttons.map((b) => `${b.id}\u0000${b.title}`).join('\u0001')).slice(0, 24);
  if (!notifCategories.has(key)) {
    const actions = NSMutableArray.alloc().init() as NSMutableArray<UNNotificationAction>;
    for (const b of buttons) {
      // .Foreground: every button here deep-links back into the app, so the tap must bring it up.
      actions.addObject(
        UNNotificationAction.actionWithIdentifierTitleOptions(b.id, b.title, UNNotificationActionOptions.Foreground)
      );
    }
    notifCategories.set(
      key,
      UNNotificationCategory.categoryWithIdentifierActionsIntentIdentifiersOptions(
        // 0 = no category options: the buttons are the whole point, and CustomDismissAction would
        // wake the delegate on a swipe-away for nothing.
        key, actions as never, NSArray.array() as never, 0 as UNNotificationCategoryOptions
      )
    );
  }
  const set = NSMutableSet.alloc().init() as NSMutableSet<UNNotificationCategory>;
  for (const c of notifCategories.values()) set.addObject(c);
  UNUserNotificationCenter.currentNotificationCenter().setNotificationCategories(set as never);
  return key;
}

/**
 * Build an iOS-15+ communication notification: an INSendMessageIntent whose sender IS
 * the mini-app (name + INImage avatar), donated, then `content.updating(from:)` so the
 * banner renders with the sender's identity. Mirrors feedox's NotificationService.swift.
 * Returns null pre-iOS-15 or if any step declines (caller falls back to plain content).
 */
function communicationContent(content: UNMutableNotificationContent, id: string, ident: NotifIdentity): UNNotificationContent | null {
  // iOS 15+ AND the NSUserActivityTypes/entitlement pair — without both, SpringBoard denies the
  // API and this would burn an INInteraction donation to learn what the bundle already states.
  if (!communicationStylingAvailable()) return null;
  try {
    const displayName = ident.senderName || ident.title;
    const handleValue = ident.senderName || id;
    let image: INImage | null = null;
    if (ident.iconUrl) {
      const data = iconNSData(ident.iconUrl);
      if (data) image = INImage.imageWithImageData(data);
    }
    const handle = INPersonHandle.alloc().initWithValueType(handleValue, INPersonHandleType.Unknown);
    // null for optional ObjC object params (nameComponents/contactIdentifier); interop marshals it to nil.
    const sender = INPerson.alloc().initWithPersonHandleNameComponentsDisplayNameImageContactIdentifierCustomIdentifier(
      handle, null as any, displayName, image as any, null as any, handleValue
    );
    const intent = INSendMessageIntent.alloc().initWithRecipientsOutgoingMessageTypeContentSpeakableGroupNameConversationIdentifierServiceNameSenderAttachments(
      null as any,
      INOutgoingMessageType.OutgoingMessageText,
      content.body,
      INSpeakableString.alloc().initWithSpokenPhrase(displayName),
      handleValue,
      null as any,
      sender,
      null as any
    );
    const interaction = INInteraction.alloc().initWithIntentResponse(intent, null as any);
    interaction.direction = INInteractionDirection.Incoming;
    interaction.donateInteractionWithCompletion(null as any);
    // INSendMessageIntent conforms to UNNotificationContentProviding (iOS 15+).
    return content.contentByUpdatingWithProviderError(intent as unknown as UNNotificationContentProviding, null);
  } catch (e) {
    console.warn('[appwrap] communication notification styling declined', String(e));
    return null;
  }
}

/** A remote (APNs) notification has a UNPushNotificationTrigger; local ones have a time/calendar trigger. */
function isRemotePush(notification: UNNotification): boolean {
  const trigger = notification?.request?.trigger;
  return !!trigger && trigger instanceof UNPushNotificationTrigger;
}

export function connectivityStatus(): { online: boolean; type: string } {
  const t = Connectivity.getConnectionType();
  const map: Record<number, string> = {
    [Connectivity.connectionType.none]: 'none',
    [Connectivity.connectionType.wifi]: 'wifi',
    [Connectivity.connectionType.mobile]: 'cellular',
    [Connectivity.connectionType.ethernet]: 'ethernet',
    [Connectivity.connectionType.bluetooth]: 'bluetooth',
    [Connectivity.connectionType.vpn]: 'vpn',
  };
  const type = map[t] ?? 'unknown';
  return { online: type !== 'none', type };
}
