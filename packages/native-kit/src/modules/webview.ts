import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/** Navigation state of the overlay, pushed on every change (`webview.state`). */
export interface WebViewState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface WebViewOpenOptions {
  /** Offset from the top of the app's WebView (CSS px) — keep your own top bar visible above it. Default 0. */
  top?: number;
  /** Inset from the bottom of the app's WebView (CSS px) — keep a bottom dock tappable below it. Default 0. */
  bottom?: number;
}

/** A cookie as data; `expires` = unix seconds, absent/null = session cookie. A leading-dot `domain` = domain cookie. */
export interface WebViewCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number | null;
  sameSite?: string | null;
}

export type WebViewNavOp = 'back' | 'forward' | 'reload' | 'go';

/**
 * In-app WebView OVERLAY — a chrome-less native WebView layered over the app between `top` and `bottom` px, driven by
 * the page (vs {@link BrowserModule}: modal SFSafariViewController with its own chrome + cookie jar).
 * Shares the persistent cookie store, swipe back/forward, target=_blank stays in the same view.
 * `capability` is 'native' on an iOS or Android shell with the `webview` module, else 'none'.
 */
export class WebViewModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('webview');
  }

  /** Show the overlay at `url` (navigates it if already open; re-applies top/bottom insets). */
  open(url: string, opts: WebViewOpenOptions = {}): Promise<WebViewState> {
    return this.kit.invoke('webview.open', { url, ...opts });
  }

  nav(op: WebViewNavOp, url?: string): Promise<WebViewState> {
    return this.kit.invoke('webview.nav', { op, url });
  }

  /** Hide without losing state (reveals the page beneath). */
  hide(): Promise<{ open: boolean }> {
    return this.kit.invoke('webview.hide', {});
  }

  /** Reveal again; pass top/bottom to re-inset (e.g. the page's dock height changed) without reloading. */
  show(opts: WebViewOpenOptions = {}): Promise<{ open: boolean }> {
    return this.kit.invoke('webview.show', { ...opts });
  }

  /** Write cookies into the overlay's persistent jar (e.g. before {@link open}, to arrive signed in); resolves once stored. */
  setCookies(cookies: WebViewCookie[]): Promise<{ set: number }> {
    return this.kit.invoke('webview.cookies', { cookies });
  }

  /** Tear the overlay down (fires {@link onClosed}). */
  close(): Promise<void> {
    return this.kit.invoke('webview.close', {});
  }

  onState(cb: (s: WebViewState) => void): Unsubscribe {
    return this.kit.on('webview.state', (p) => cb(p as WebViewState));
  }

  onClosed(cb: () => void): Unsubscribe {
    return this.kit.on('webview.closed', () => cb());
  }
}
