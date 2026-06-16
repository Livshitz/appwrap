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
      // page backgroundColor — shows under the status bar. Nav bar keeps NS's default subtle scrim.
      (Utils as any).android.enableEdgeToEdge(activity, {
        statusBarLightColor: transparent,
        statusBarDarkColor: transparent,
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
  // Un-box the layout that wraps the WebView so it (and its child WebView) fills the window UNDER the
  // bars. 'dont-apply' = NS won't pad it with the system-bar insets.
  const layout = (webView.parent as View) ?? webView;
  (layout as any).androidOverflowEdge = 'dont-apply';

  const density = Screen.mainScreen.scale || 1; // physical px per dp
  const inject = (l: number, t: number, r: number, b: number) => {
    const js =
      `(function(s){` +
      `s.setProperty('--saie-left','${l}px');s.setProperty('--saie-top','${t}px');` +
      `s.setProperty('--saie-right','${r}px');s.setProperty('--saie-bottom','${b}px');` +
      `})(document.documentElement.style);`;
    try {
      (webView as any).android?.evaluateJavascript(js, null);
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
      const Type = (global as any).android.view.WindowInsets.Type;
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
  Application.on(Application.resumeEvent, () => setTimeout(readAndInject, 120));
  Application.on(Application.orientationChangedEvent, () => setTimeout(readAndInject, 200));
}

export function bindStatusBarPage(page: Page): void {
  currentPage = page;
}

/** 'light' = white icons/text (for dark backgrounds), 'dark' = black. */
export function setStatusBarStyle(style: 'light' | 'dark'): void {
  if (isIOS) {
    if (currentPage) (currentPage as any).statusBarStyle = style;
  } else if (isAndroid) {
    const window = Application.android?.startActivity?.getWindow();
    if (!window) return;
    const decorView = window.getDecorView();
    const controller = (decorView as any).getWindowInsetsController?.();
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
