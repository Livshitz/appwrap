import { Application, Utils, isAndroid, isIOS } from '@nativescript/core';
import { activeEnvLabel, currentOverride, hostOf, isEnvSwitcherEnabled, isNonDefaultOverride, showEnvSwitcher } from './env-switcher';

/**
 * Env indicator banner — a non-invasive marker pinned to the BOTTOM safe area, shown on every relaunch
 * while a NON-DEFAULT env override is active (see `currentOverride`). It starts EXPANDED (label + host),
 * auto-shrinks to a small PILL after 3s to stay out of the way; tapping the pill re-expands it, tapping
 * the expanded banner opens the "Switch Environment" menu (`showEnvSwitcher`). Moved here from the AGF web
 * app since env-switching is now a framework concern. Distinct from `banner.ts` (the update-prompt banner).
 */

const SHRINK_MS = 3000;
type State = 'expanded' | 'pill';
let state: State = 'expanded';
let shrinkTimer: any = null;

// iOS refs (built lazily inside the iOS path — `interop`/`NSObject` don't exist on Android).
let iosContainer: UIView | null = null;
let iosLabel: UILabel | null = null;
let iosTapHandler: any = null;
let IOSGestureHandler: any = null;
let iosDraggedCenter: { x: number; y: number } | null = null; // where the user parked the pill (drag)
let iosPanRecognizer: any = null; // read inside the (no-arg) pan handler to avoid a param-selector crash

// Android refs.
let androidView: android.widget.TextView | null = null;
let androidDraggedPos: { x: number; y: number } | null = null; // parked translation (mirror of iosDraggedCenter)

/** Show the banner if the switcher is enabled AND a NON-DEFAULT override is active. Idempotent. No-op
 * otherwise (incl. when the override resolves to the build-time default host). */
export function showEnvBannerIfActive(): void {
  if (!isEnvSwitcherEnabled() || !isNonDefaultOverride()) return;
  state = 'expanded';
  if (isIOS) Utils.dispatchToMainThread(showIOSBanner);
  else if (isAndroid) runOnAndroidUi(showAndroidBanner);
}

/**
 * Reconcile the banner with the CURRENT override after an in-session switch/reset (the WebView reloads but
 * this native overlay doesn't re-render on its own). Override active → ensure shown, reset to EXPANDED,
 * re-render the new label/host, and re-arm the single shrink timer. Override cleared (reset) → hide it.
 * Called from `applySwitch`; complements `showEnvBannerIfActive` (relaunch path).
 */
export function refreshEnvBanner(): void {
  if (!isEnvSwitcherEnabled() || !isNonDefaultOverride()) { hideEnvBanner(); return; }
  state = 'expanded';
  if (isIOS) Utils.dispatchToMainThread(() => { if (iosContainer) { renderIOS(); armShrink(); } else showIOSBanner(); });
  else if (isAndroid) runOnAndroidUi(() => { if (androidView) { renderAndroid(); armShrink(); } else showAndroidBanner(); });
}

/** Remove the banner and cancel its shrink timer. Idempotent. */
export function hideEnvBanner(): void {
  if (shrinkTimer) { clearTimeout(shrinkTimer); shrinkTimer = null; }
  if (isIOS) Utils.dispatchToMainThread(hideIOSBanner);
  else if (isAndroid) runOnAndroidUi(hideAndroidBanner);
}

/**
 * Recall a stranded pill to its default spot: clear the parked/dragged position and re-render. No-op
 * cleanly if the banner isn't shown. Wired to the shake handler (devmenu.ts) so a shake both opens the
 * dev menu AND brings a dragged-away pill home — the recovery mechanism for the now-unclamped drag.
 */
export function resetEnvBannerPosition(): void {
  iosDraggedCenter = null;
  androidDraggedPos = null;
  if (isIOS) { if (iosContainer) render(); }
  else if (isAndroid) { if (androidView) render(); }
}

function bannerText(): string {
  const label = activeEnvLabel() || 'Custom';
  return state === 'pill' ? `⇄ ${label}` : `⇄ ${label} · ${hostOf(currentOverride())}`;
}

function armShrink(): void {
  if (shrinkTimer) clearTimeout(shrinkTimer);
  shrinkTimer = setTimeout(() => {
    state = 'pill';
    render();
  }, SHRINK_MS);
}

function onTap(): void {
  if (state === 'expanded') {
    void showEnvSwitcher(); // tap expanded → open the switch menu
  } else {
    state = 'expanded'; // tap pill → re-expand, then re-arm the auto-shrink
    render();
    armShrink();
  }
}

function render(): void {
  if (isIOS) Utils.dispatchToMainThread(renderIOS);
  else if (isAndroid) runOnAndroidUi(renderAndroid);
}

// ── iOS ──────────────────────────────────────────────────────────────
function iosGestureHandlerClass(): any {
  if (!IOSGestureHandler) {
    IOSGestureHandler = (NSObject as any).extend(
      {
        bannerTapped() { onTap(); },
        // Drag to reposition; remember where the user parked it so re-renders don't snap it back.
        // No-arg (reads the module-level recognizer) — a param-selector target crashes with
        // "unrecognized selector" on a runtime .extend, so we mirror the no-arg tap pattern.
        bannerPanned() {
          const gr = iosPanRecognizer, c = iosContainer;
          if (!gr || !c || !c.superview) return;
          const t = gr.translationInView(c.superview);
          // FREELY draggable ANYWHERE — including the top safe-area / status bar / screen edges. No clamp:
          // recovery is via shake (see resetEnvBannerPosition), not by fencing the drag.
          const nx = c.center.x + t.x, ny = c.center.y + t.y;
          c.center = CGPointMake(nx, ny);
          gr.setTranslationInView(CGPointMake(0, 0), c.superview);
          if (gr.state === 3 /* UIGestureRecognizerState.Ended */) iosDraggedCenter = { x: nx, y: ny };
        },
      },
      {
        exposedMethods: {
          bannerTapped: { returns: interop.types.void },
          bannerPanned: { returns: interop.types.void },
        },
      }
    );
  }
  return IOSGestureHandler;
}

function showIOSBanner(): void {
  if (iosContainer) return; // already shown
  const rootVC = Utils.ios.getRootViewController();
  if (!rootVC?.view) return;

  const container = UIView.alloc().initWithFrame(CGRectMake(0, 0, 10, 10));
  container.backgroundColor = UIColor.colorWithRedGreenBlueAlpha(0.72, 0.45, 0.02, 0.92); // amber = "not default"
  container.layer.cornerRadius = 15;
  container.clipsToBounds = true;
  container.userInteractionEnabled = true;

  const label = UILabel.alloc().initWithFrame(CGRectZero);
  label.textColor = UIColor.whiteColor;
  label.textAlignment = NSTextAlignment.Center;
  label.font = UIFont.systemFontOfSizeWeight(13, UIFontWeightSemibold);
  container.addSubview(label);

  iosTapHandler = iosGestureHandlerClass().alloc().init();
  container.addGestureRecognizer(UITapGestureRecognizer.alloc().initWithTargetAction(iosTapHandler, 'bannerTapped'));
  iosPanRecognizer = UIPanGestureRecognizer.alloc().initWithTargetAction(iosTapHandler, 'bannerPanned');
  container.addGestureRecognizer(iosPanRecognizer);

  rootVC.view.addSubview(container);
  iosContainer = container;
  iosLabel = label;
  renderIOS();
  armShrink();
}

function renderIOS(): void {
  const container = iosContainer, label = iosLabel;
  if (!container || !label) return;
  // Position in the SUPERVIEW's coordinate space (where container.center lives), NOT UIScreen: the root
  // view can be inset/offset from the screen, which made the default land at the TOP. Fall back to the
  // screen only if the container isn't in a hierarchy yet.
  const sv = container.superview;
  const bounds = sv ? sv.bounds : UIScreen.mainScreen.bounds;
  const insets = sv ? sv.safeAreaInsets : null;
  const safeBottom = insets ? insets.bottom : 0;
  label.text = bannerText();
  const height = 30;
  const width = state === 'pill' ? 96 : Math.min(bounds.size.width - 24, 320);
  container.alpha = state === 'pill' ? 0.6 : 1.0; // shrunk pill is semi-transparent but still readable
  UIView.animateWithDurationAnimations(0.25, () => {
    label.frame = CGRectMake(10, 0, width - 20, height);
    container.frame = CGRectMake(0, 0, width, height);
    if (state === 'pill' && iosDraggedCenter) {
      container.center = CGPointMake(iosDraggedCenter.x, iosDraggedCenter.y); // where the user parked it
    } else if (state === 'pill') {
      // Parked default: inset from the left edge and RAISED well above the home-indicator zone, so a drag
      // isn't stolen by iOS system edge gestures and it never sits under a bottom CTA. Draggable from there.
      container.center = CGPointMake(20 + width / 2, bounds.size.height - safeBottom - height / 2 - 64);
    } else {
      // Expanded (transient): centered just above the safe area.
      container.center = CGPointMake(bounds.size.width / 2, bounds.size.height - safeBottom - height / 2 - 6);
    }
  });
}

function hideIOSBanner(): void {
  if (!iosContainer) return;
  iosContainer.removeFromSuperview();
  iosContainer = null;
  iosLabel = null;
}

// ── Android ──────────────────────────────────────────────────────────
/**
 * Cold-relaunch safe entry: on a relaunch (main-page onPageLoaded) the Activity's window is not yet
 * attached, so `foregroundActivity` can be null AND `getRootWindowInsets()` returns null — mounting
 * inline then lands the pill INSIDE the nav-bar zone (bottomMargin computed off a 0 inset) where it's
 * occluded by the home affordance and reads as "the banner disappeared". So: wait for an activity, then
 * defer the actual mount to `decorView.post` (runs after attach + first layout on the UI thread), when
 * insets are real. In-session callers (refreshEnvBanner) hit the same path — a one-frame post is harmless.
 */
let androidMountRetries = 0; // bounds the boot "activity not ready" retry so it can't spin forever

function showAndroidBanner(): void {
  if (androidView) return;
  const activity = Application.android.foregroundActivity || Application.android.startActivity;
  if (!activity) {
    if (androidMountRetries++ < 20) setTimeout(() => runOnAndroidUi(showAndroidBanner), 100); // boot: activity not ready — retry, bounded (~2s)
    return;
  }
  androidMountRetries = 0;
  activity.getWindow().getDecorView().post(new java.lang.Runnable({ run() { mountAndroidBanner(activity); } }));
}

function mountAndroidBanner(activity: android.app.Activity): void {
  if (androidView) return; // a second deferred mount raced in — keep the first
  // Re-gate at the final step: the override may have been cleared (reset / switch to default / hideEnvBanner)
  // during the deferred post or the boot retry window — don't mount a stale banner the caller no longer wants.
  if (!isEnvSwitcherEnabled() || !isNonDefaultOverride()) return;
  const density = activity.getResources().getDisplayMetrics().density;
  const padH = Math.round(14 * density), padV = Math.round(6 * density);

  const tv = new android.widget.TextView(activity);
  tv.setTextColor(android.graphics.Color.WHITE);
  tv.setTextSize(13);
  tv.setPadding(padH, padV, padH, padV);
  const bg = new android.graphics.drawable.GradientDrawable();
  bg.setColor(android.graphics.Color.argb(235, 184, 115, 5)); // amber
  bg.setCornerRadius(15 * density);
  tv.setBackground(bg);
  // Tap semantics (via performClick from the touch listener below): pill → expand; expanded → switch menu.
  tv.setOnClickListener(new android.view.View.OnClickListener({ onClick() { onTap(); } }));

  // Drag ANYWHERE via translationX/Y (mirror of the iOS pan — no clamp; recall via shake →
  // resetEnvBannerPosition). Consume the gesture stream (return true on DOWN) so we get MOVE/UP; on a
  // no-move UP, performClick() routes to the tap handler above (preserves tap + a11y). The parked
  // translation is remembered in androidDraggedPos so re-renders don't snap it home.
  const slop = android.view.ViewConfiguration.get(activity).getScaledTouchSlop();
  let downX = 0, downY = 0, startTX = 0, startTY = 0, moved = false;
  tv.setOnTouchListener(new android.view.View.OnTouchListener({
    onTouch(v: android.view.View, event: android.view.MotionEvent): boolean {
      switch (event.getActionMasked()) {
        case android.view.MotionEvent.ACTION_DOWN:
          downX = event.getRawX(); downY = event.getRawY();
          startTX = v.getTranslationX(); startTY = v.getTranslationY();
          moved = false;
          return true;
        case android.view.MotionEvent.ACTION_MOVE: {
          const dx = event.getRawX() - downX, dy = event.getRawY() - downY;
          if (Math.abs(dx) > slop || Math.abs(dy) > slop) moved = true;
          v.setTranslationX(startTX + dx);
          v.setTranslationY(startTY + dy);
          return true;
        }
        case android.view.MotionEvent.ACTION_UP:
          if (moved) androidDraggedPos = { x: v.getTranslationX(), y: v.getTranslationY() };
          else v.performClick();
          return true;
        default:
          return false;
      }
    },
  }));

  const lp = new android.widget.FrameLayout.LayoutParams(-2, -2); // WRAP_CONTENT × WRAP_CONTENT
  lp.gravity = android.view.Gravity.BOTTOM | android.view.Gravity.CENTER_HORIZONTAL;
  // Raise above the gesture/nav area (mirror of the iOS home-indicator raise), respecting insets where
  // available so the default pill never sits under the system nav bar (best-effort — falls back cleanly).
  lp.bottomMargin = androidBottomInsetPx(activity) + Math.round(16 * density);
  activity.addContentView(tv, lp);
  androidView = tv;
  renderAndroid();
  armShrink();
}

/** Bottom system-inset (gesture/nav bar) in px. Falls back to ~48dp (a typical nav-bar height) rather
 * than 0 if the read fails, so the pill never lands INSIDE the nav bar on a device/timing where insets
 * are unavailable — being a touch too high is harmless; being occluded reads as "missing". */
function androidBottomInsetPx(activity: android.app.Activity): number {
  try {
    const wi = activity.getWindow().getDecorView().getRootWindowInsets();
    if (wi) return wi.getSystemWindowInsetBottom();
  } catch (e) { /* pre-attach / older API — fall back below */ }
  return Math.round(48 * activity.getResources().getDisplayMetrics().density);
}

function renderAndroid(): void {
  const tv = androidView;
  if (!tv) return;
  tv.setText(bannerText());
  tv.setAlpha(state === 'pill' ? 0.6 : 1.0); // shrunk pill is semi-transparent but still readable
  // Re-apply the parked translation (or default home) so a re-render doesn't snap a dragged pill back.
  tv.setTranslationX(androidDraggedPos ? androidDraggedPos.x : 0);
  tv.setTranslationY(androidDraggedPos ? androidDraggedPos.y : 0);
}

function hideAndroidBanner(): void {
  if (!androidView) return;
  const parent = androidView.getParent();
  if (parent) (parent as android.view.ViewGroup).removeView(androidView);
  androidView = null;
}

function runOnAndroidUi(fn: () => void): void {
  const activity = Application.android.foregroundActivity || Application.android.startActivity;
  if (activity) activity.runOnUiThread(new java.lang.Runnable({ run: fn }));
  else fn();
}
