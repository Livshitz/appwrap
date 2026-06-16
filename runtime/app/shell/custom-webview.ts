import { WebView } from '@nativescript/core';

/**
 * Android/common CustomWebView. Web→native transport on Android v0 is the
 * polled queue installed by the bootstrap user script (see bridge.ts);
 * a real addJavascriptInterface upgrade comes later.
 */
export class CustomWebView extends WebView {
  /** Set by the bridge before load; receives raw envelope JSON. */
  onAppwrapMessage: ((json: string) => void) | null = null;

  /** Pause/resume the render + JS-timer pipeline on app background/foreground. Platform-specific
   * (see custom-webview.android.ts); no-op on iOS, which suspends rAF on its own. */
  setRenderingActive(_active: boolean): void {
    /* overridden per-platform */
  }
}
