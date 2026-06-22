import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

/**
 * Persistent bottom banner (vs. the auto-dismiss `toast`). Used for the "new version available —
 * tap to reload" update prompt. **Tap** emits `toast.action` { id } (the web side decides what to
 * do) and dismisses; **swipe down** dismisses without acting.
 */

let currentId: string | null = null;
let iosBanner: UIView | null = null;
let iosTapHandler: any = null; // runtime-built ObjC gesture target (see iosGestureHandlerClass)
let androidBanner: android.view.View | null = null;

function onTap(): void {
  const id = currentId;
  dismissBanner();
  if (id) bridge.emit('toast.action', { id });
}

export function showBanner(opts: { id: string; message: string }): void {
  dismissBanner(); // only one at a time
  currentId = opts.id;
  if (isIOS) Utils.dispatchToMainThread(() => showIOSBanner(opts.message));
  else if (isAndroid) runOnAndroidUi(() => showAndroidBanner(opts.message));
}

export function dismissBanner(): void {
  currentId = null;
  if (isIOS && iosBanner) {
    const b = iosBanner;
    iosBanner = null;
    iosTapHandler = null;
    Utils.dispatchToMainThread(() => b.removeFromSuperview());
  }
  if (isAndroid && androidBanner) {
    const v = androidBanner;
    androidBanner = null;
    runOnAndroidUi(() => (v.getParent() as android.view.ViewGroup)?.removeView(v));
  }
}

// ── iOS ──────────────────────────────────────────────────────────────
// Target/action handler for the banner's tap + swipe-down gestures (bare selectors exposed via
// `exposedMethods`, no ObjC protocol). Built lazily INSIDE this iOS-only path — `interop` and
// `NSObject` don't exist on Android, and this file is imported on both platforms via handlers.ts, so
// a top-level `@NativeClass` with a `static ObjCExposedMethods = { … interop.types.void }` initializer
// would touch `interop` at module load and crash the Android shell (same reason handlers-scanner keeps
// its `exposedMethods` cancel-button target as a runtime `.extend` inside its iOS-only registrar).
// any — runtime-built ObjC subclass; an exposedMethods (non-protocol) target has no static type.
let IOSGestureHandler: any = null;
function iosGestureHandlerClass(): any {
  if (!IOSGestureHandler) {
    IOSGestureHandler = (NSObject as any).extend(
      { bannerTapped() { onTap(); }, bannerDismissed() { dismissBanner(); } },
      {
        exposedMethods: {
          bannerTapped: { returns: interop.types.void },
          bannerDismissed: { returns: interop.types.void },
        },
      }
    );
  }
  return IOSGestureHandler;
}

function showIOSBanner(message: string): void {
  const rootVC = Utils.ios.getRootViewController();
  if (!rootVC?.view) return;
  const screen = UIScreen.mainScreen.bounds;
  const safeBottom = rootVC.view.safeAreaInsets ? rootVC.view.safeAreaInsets.bottom : 0;
  const width = screen.size.width - 24;

  const container = UIView.alloc().initWithFrame(CGRectMake(12, 0, width, 52));
  container.backgroundColor = UIColor.colorWithRedGreenBlueAlpha(0.08, 0.08, 0.1, 0.85);
  container.layer.cornerRadius = 12;
  container.clipsToBounds = true;
  container.userInteractionEnabled = true;

  const blur = UIVisualEffectView.alloc().initWithEffect(UIBlurEffect.effectWithStyle(UIBlurEffectStyle.Dark));
  blur.frame = container.bounds;
  blur.autoresizingMask = UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
  blur.userInteractionEnabled = false;
  container.addSubview(blur);

  const label = UILabel.alloc().initWithFrame(CGRectMake(16, 0, width - 32, 52));
  label.text = message;
  label.textColor = UIColor.whiteColor;
  label.textAlignment = NSTextAlignment.Center;
  label.font = UIFont.systemFontOfSizeWeight(15, UIFontWeightSemibold);
  blur.contentView.addSubview(label);

  iosTapHandler = iosGestureHandlerClass().alloc().init();
  container.addGestureRecognizer(UITapGestureRecognizer.alloc().initWithTargetAction(iosTapHandler, 'bannerTapped'));
  const swipe = UISwipeGestureRecognizer.alloc().initWithTargetAction(iosTapHandler, 'bannerDismissed');
  swipe.direction = UISwipeGestureRecognizerDirection.Down;
  container.addGestureRecognizer(swipe);

  container.center = CGPointMake(screen.size.width / 2, screen.size.height - safeBottom - 38);
  container.alpha = 0;
  rootVC.view.addSubview(container);
  iosBanner = container;
  UIView.animateWithDurationAnimations(0.3, () => (container.alpha = 1));
}

// ── Android ──────────────────────────────────────────────────────────
function showAndroidBanner(message: string): void {
  const activity = Application.android.foregroundActivity || Application.android.startActivity;
  if (!activity) return;
  const density = activity.getResources().getDisplayMetrics().density;
  const pad = Math.round(16 * density);

  const tv = new android.widget.TextView(activity);
  tv.setText(message);
  tv.setTextColor(android.graphics.Color.WHITE);
  tv.setTextSize(15);
  tv.setPadding(pad, pad, pad, pad);
  tv.setGravity(android.view.Gravity.CENTER);
  tv.setBackgroundColor(android.graphics.Color.argb(230, 20, 20, 26));

  // Distinguish a tap (→ reload) from a downward swipe (→ dismiss) on one touch listener.
  const SWIPE = 40 * density;
  let downX = 0, downY = 0, downT = 0;
  tv.setOnTouchListener(new android.view.View.OnTouchListener({
    onTouch(_v: android.view.View, e: android.view.MotionEvent) {
      switch (e.getActionMasked()) {
        case android.view.MotionEvent.ACTION_DOWN:
          downX = e.getRawX(); downY = e.getRawY(); downT = e.getEventTime();
          return true;
        case android.view.MotionEvent.ACTION_UP: {
          const dy = e.getRawY() - downY;
          const dx = Math.abs(e.getRawX() - downX);
          const dt = e.getEventTime() - downT;
          if (dy > SWIPE) dismissBanner();                      // swipe down → dismiss
          else if (Math.abs(dy) < SWIPE && dx < SWIPE && dt < 400) onTap(); // tap → reload
          return true;
        }
        default:
          return true;
      }
    },
  }));

  const lp = new android.widget.FrameLayout.LayoutParams(-1, -2); // MATCH_PARENT × WRAP_CONTENT
  lp.gravity = android.view.Gravity.BOTTOM;
  activity.addContentView(tv, lp);
  androidBanner = tv;
}

function runOnAndroidUi(fn: () => void): void {
  const activity = Application.android.foregroundActivity || Application.android.startActivity;
  if (activity) activity.runOnUiThread(new java.lang.Runnable({ run: fn }));
  else fn();
}
