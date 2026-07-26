import { Application, Color, Page, Screen, Utils, View, isAndroid, isIOS } from '@nativescript/core';
import { SHELL_CONFIG } from './config';

let currentPage: Page | null = null;

/**
 * Make the Android system bars TRANSPARENT so the page background (the NS page `backgroundColor`)
 * spans edge-to-edge under them, instead of the default opaque black status/nav bars that box the
 * WebView in black letterbox strips.
 *
 * Uses NativeScript's own helper (`org.nativescript.widgets.Utils.enableEdgeToEdge` via
 * `Utils.android.enableEdgeToEdge`) with transparent status-bar colors — rolling our own window
 * flags doesn't stick (NS re-applies its layout and its status-bar-style setter clears the
 * translucent flag, giving a black bar or a dark scrim). Required on Android 15+/API 35 anyway.
 *
 * NOTE: NS still insets the WebView itself below the bars (its native widget layout pads the page
 * content), so the bar regions show the PAGE background, not the web body. Consumers should set
 * `appwrap.json.backgroundColor` to their app's theme background so the bars blend seamlessly. (iOS
 * is genuinely edge-to-edge — the WKWebView fills the safe areas and the web paints them via
 * env(safe-area-inset-*).)
 */
export function enableAndroidEdgeToEdge(): void {
  if (!isAndroid) return;
  const transparent = new Color(0, 0, 0, 0);
  const apply = () => {
    const activity = Application.android?.startActivity;
    if (!activity) return;
    try {
      // Explicit transparent status-bar colors (light + dark) so the page background — not the NS
      // page backgroundColor — shows under the status bar. In FULL edge-to-edge mode (the edgeToEdge
      // config + wireAndroidSafeArea un-boxing) also make the NAV bar transparent so the web content
      // draws under it too; otherwise keep NS's default nav-bar scrim (so the buttons stay legible on
      // apps that aren't drawing their own content down there).
      Utils.android.enableEdgeToEdge(activity, {
        statusBarLightColor: transparent,
        statusBarDarkColor: transparent,
        ...(SHELL_CONFIG.edgeToEdge ? { navigationBarLightColor: transparent, navigationBarDarkColor: transparent } : {}),
      });
    } catch (e) {
      console.warn('AppWrap: edge-to-edge setup failed', e);
    }
  };
  apply();
  // NS applies its own status-bar inset AFTER onPageLoaded; re-apply on the next loop so edge-to-edge
  // wins the race (otherwise the WebView stays boxed below an opaque status-bar strip).
  setTimeout(apply, 50);
}

/**
 * EXPERIMENTAL (SHELL_CONFIG.edgeToEdge). Make the WebView draw genuinely edge-to-edge UNDER the
 * transparent system bars instead of NS boxing it below them, and feed the real safe-area insets to
 * the web layer as `--saie-{top,right,bottom,left}` CSS vars (dp). With the WebView now filling the
 * window, native `env(safe-area-inset-*)` should also populate — so a PWA can pad with
 * `max(env(safe-area-inset-top), var(--saie-top, 0px))` and paint the bar regions itself, matching
 * any theme (no static page backgroundColor to match). No-op unless edgeToEdge + Android.
 */
export function wireAndroidSafeArea(webView: View): void {
  if (!isAndroid || !SHELL_CONFIG.edgeToEdge) return;
  // Un-box the WebView so it fills the window UNDER the system bars. 'dont-apply' = NS won't pad the
  // view with the system-bar insets. The insets are consumed/applied by the root FRAME (NS sets its
  // androidOverflowEdge to 'ignore' by default — ui/frame/index.android.ts), NOT by the WebView's
  // immediate parent, so overriding only webView.parent left the content boxed. Set it up the whole
  // chain — root view (the Frame), the Page, and the WebView's parent — so whichever applies the
  // insets stops padding. (androidOverflowEdge isn't in the public View typings — an NS layout hint.)
  const targets: Array<View | null> = [
    Application.getRootView() as View | null,
    currentPage,
    (webView.parent as View) ?? null,
    webView,
  ];
  for (const t of targets) if (t) (t as any).androidOverflowEdge = 'dont-apply';

  // HIDE the navigation bar (immersive) so the game is genuinely full-bleed at the bottom — drawing
  // under a nav bar you can still see is moot. Status bar stays visible (clock/battery over the page).
  // BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE: a swipe from the bottom edge reveals it briefly, then it
  // re-hides — the standard game pattern. Immersive resets on resume / when transiently shown, so it's
  // re-applied below. API 30+ (WindowInsetsController); the device floor for edge-to-edge is well above.
  const hideNav = () => {
    try {
      const controller = Application.android?.startActivity?.getWindow()?.getInsetsController?.();
      if (!controller) return;
      controller.hide(android.view.WindowInsets.Type.navigationBars());
      controller.setSystemBarsBehavior(
        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      );
    } catch (e) {
      console.warn('AppWrap: hide nav bar failed', e);
    }
  };
  hideNav();
  setTimeout(hideNav, 60); // win the race against NS's own post-load bar setup

  const density = Screen.mainScreen.scale || 1; // physical px per dp
  const inject = (l: number, t: number, r: number, b: number) => {
    const js =
      `(function(s){` +
      `s.setProperty('--saie-left','${l}px');s.setProperty('--saie-top','${t}px');` +
      `s.setProperty('--saie-right','${r}px');s.setProperty('--saie-bottom','${b}px');` +
      `})(document.documentElement.style);`;
    try {
      // webView.android is typed `any` by NS core; on Android it's an android.webkit.WebView.
      webView.android?.evaluateJavascript(js, null);
    } catch (e) {
      console.warn('AppWrap: safe-area inject failed', e);
    }
  };
  inject(0, 0, 0, 0); // sane defaults until the first real read

  // Read the window insets DIRECTLY from the decor view. NS's androidOverflowInset event doesn't
  // reliably reach a nested layout (its edge-to-edge machinery consumes insets higher up), so we go
  // straight to the platform API — systemBars ∪ displayCutout, the same set a native edge-to-edge
  // app uses. Returns true once non-zero insets are available (i.e. the window is laid out).
  const dp = (px: number) => Math.round((px || 0) / density);
  const readAndInject = (): boolean => {
    try {
      const decor = Application.android?.startActivity?.getWindow()?.getDecorView();
      const wi = decor?.getRootWindowInsets?.();
      if (!wi) return false;
      const Type = android.view.WindowInsets.Type;
      const ins = wi.getInsets(Type.systemBars() | Type.displayCutout());
      inject(dp(ins.left), dp(ins.top), dp(ins.right), dp(ins.bottom));
      return ins.top + ins.bottom + ins.left + ins.right > 0;
    } catch (e) {
      console.warn('AppWrap: safe-area read failed', e);
      return false;
    }
  };

  // Insets are 0 until the window is laid out — retry a few times, then keep them fresh on
  // resume / rotation (bar visibility + cutout side can change).
  let tries = 0;
  const tick = () => {
    if (readAndInject() || ++tries > 12) return;
    setTimeout(tick, 150);
  };
  setTimeout(tick, 80);
  Application.on(Application.resumeEvent, () => { setTimeout(readAndInject, 120); setTimeout(hideNav, 120); });
  Application.on(Application.orientationChangedEvent, () => { setTimeout(readAndInject, 200); setTimeout(hideNav, 200); });
}

export function bindStatusBarPage(page: Page): void {
  currentPage = page;
}

/**
 * Tint the native root (the chrome behind the page — status bar / safe areas) to a CSS color. This is
 * the SAME surface the `ui.setBackgroundColor` handler / `kit.ui.syncThemeColor()` drive at runtime; we
 * apply the manifest/config `themeColor` through it at boot so the chrome is themed before the WebView
 * paints (no white flash, no un-themed safe areas). No-op for an empty color (leave the page bg).
 */
export function applyThemeColor(color: string): void {
  if (!color) return;
  const root = Application.getRootView();
  if (!root) return;
  // `color` is a PWA-manifest `theme_color` (or appwrap.json) — dev free-text, NOT validated upstream.
  // `new Color()` THROWS on a value it can't parse, and this runs at boot (onPageLoaded), so an
  // unsupported/malformed color (e.g. an unrecognized CSS form) would abort the rest of shell init.
  // Degrade gracefully: log + leave the default page background rather than crash the launch.
  try {
    root.backgroundColor = new Color(String(color));
  } catch (e) {
    console.warn('[appwrap] invalid themeColor, leaving default:', color, (e as Error)?.message ?? e);
  }
}

/** 'light' = white icons/text (for dark backgrounds), 'dark' = black. */
export function setStatusBarStyle(style: 'light' | 'dark'): void {
  if (isIOS) {
    // statusBarStyle is a CSS-backed Page property, not on the public Page type — set dynamically.
    if (currentPage) (currentPage as any).statusBarStyle = style;
  } else if (isAndroid) {
    const window = Application.android?.startActivity?.getWindow();
    if (!window) return;
    const decorView = window.getDecorView();
    const controller = decorView.getWindowInsetsController?.();
    if (controller) {
      const APPEARANCE_LIGHT_STATUS_BARS = 8; // WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
      // Android "light status bar" = dark icons; invert from our naming
      controller.setSystemBarsAppearance(
        style === 'dark' ? APPEARANCE_LIGHT_STATUS_BARS : 0,
        APPEARANCE_LIGHT_STATUS_BARS
      );
    }
  }
}
