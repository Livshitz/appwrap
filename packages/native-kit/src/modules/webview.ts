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
  /** iOS: the page's content (and its fixed elements) start this far below the overlay's top (CSS px); the area above
   *  scrolls under e.g. a bar that collapses with {@link WebViewModule.onScroll}. Default 0. */
  contentTop?: number;
}

/** The page's scroll position: `y` CSS px from its top; `user` while a finger drags it or it coasts from a flick;
 *  `dragging` while the finger is down. */
export interface WebViewScroll { y: number; user: boolean; dragging: boolean }

export interface WebViewFabOptions {
  show: boolean;
  bottom?: number;
  right?: number;
  size?: number;
  /** Corner radius (px); default = round. */
  radius?: number;
  color?: string;
  symbol?: string;
  text?: string;
  label?: string;
}

export interface WebViewFloatOptions {
  on: boolean;
  /** The app's touchable boxes over the page (CSS px from the app WebView's top-left). */
  hit?: { x: number; y: number; w: number; h: number }[];
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

  /** What the overlay shows now as a JPEG about `width` px wide (default 360). Take it while it is shown (before hide/close). */
  snapshot(opts: { width?: number; quality?: number } = {}): Promise<{ jpeg: string; width: number; height: number }> {
    return this.kit.invoke('webview.snapshot', { ...opts });
  }

  /** Run `js` — an async function body (may `await`; its `return` is the result) — in the overlay's page; resolves the
   *  returned value (JSON round-tripped). `world`: a named isolated JS world (iOS; ignored on Android). The app's own
   *  origin only: a foreign page in the app WebView can't call it. */
  async eval<T = unknown>(js: string, opts: { world?: string } = {}): Promise<T> {
    return (await this.kit.invoke<{ result: T }>('webview.eval', { js, ...opts }, { timeoutMs: 35_000 })).result; // (native gives up at 30s)
  }

  /** A round floating button over the app and the overlay (stays tappable while a page is shown) — e.g. an assistant
   *  button. `bottom`/`right`: CSS px from the app WebView's bottom-right; `color` #rrggbb; `symbol`: an SF Symbol (iOS,
   *  default 'sparkles'); `text`: its glyph on Android ('✦'); `label`: accessibility. `show:false` hides it. Taps →
   *  {@link onFab}. Works with or without an open overlay. */
  fab(opts: WebViewFabOptions): Promise<{ shown: boolean }> {
    return this.kit.invoke('webview.fab', { ...opts });
  }

  /** Float the app's WebView OVER the overlay: it draws on top (transparent wherever the app's own page is — give the
   *  area over the overlay no background), so e.g. chat bubbles float over a shown page without resizing it. Touches
   *  inside `hit` (app CSS px, viewport coords) go to the app; everywhere else to the page. Call again to move the rects;
   *  `on:false` restores. iOS; elsewhere resolves `{floating:false}` — keep a fallback (e.g. inset the page). */
  float(opts: WebViewFloatOptions): Promise<{ floating: boolean }> {
    return this.kit.invoke('webview.float', { ...opts });
  }

  onFab(cb: () => void): Unsubscribe {
    return this.kit.on('webview.fab', () => cb());
  }

  /** Tear the overlay down (fires {@link onClosed}). */
  close(): Promise<void> {
    return this.kit.invoke('webview.close', {});
  }

  /** The page scrolled (iOS, at most once per frame) — e.g. to collapse a top bar along with it. */
  onScroll(cb: (s: WebViewScroll) => void): Unsubscribe {
    return this.kit.on('webview.scroll', (p) => cb(p as WebViewScroll));
  }

  onState(cb: (s: WebViewState) => void): Unsubscribe {
    return this.kit.on('webview.state', (p) => cb(p as WebViewState));
  }

  onClosed(cb: () => void): Unsubscribe {
    return this.kit.on('webview.closed', () => cb());
  }
}
