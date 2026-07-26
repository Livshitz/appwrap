import type { NativeKit } from '../core/NativeKit';

export interface OAuthAuthorizeParams {
  /** Full authorization URL — provider endpoint + query (client_id, redirect_uri, scope, PKCE…). */
  url: string;
  /** The custom URL scheme the redirect_uri uses (e.g. 'circles' for circles://oauth). The system
   *  browser sheet closes + returns as soon as it sees a redirect to this scheme. */
  callbackScheme: string;
  /** Don't persist browser cookies (fresh provider login every time). Default false — reuses the
   *  existing provider session so the user isn't re-typing their Google password. */
  ephemeral?: boolean;
}

export interface OAuthResult {
  /** The full callback URL the provider redirected to, including ?code=…&state=… (or #fragment). */
  url: string;
}

/**
 * System-browser OAuth — iOS ASWebAuthenticationSession / Android Chrome Custom Tabs. The Android
 * tab returns the provider redirect via the app's urlScheme deep-link path (it doesn't auto-close
 * like iOS); the shell matches the callbackScheme and resolves with the same { url } shape. A
 * user-dismissed tab/sheet rejects with code 'CANCELLED'. Provider-agnostic by design — the same
 * philosophy as `kit.push`: the shell owns only the device-side primitive (run the auth handshake in
 * the OS-shared, policy-compliant browser), while the PWA builds the auth URL and does token exchange.
 *
 * WHY: Google (and others) reject OAuth loaded inside an embedded WebView with
 * `403 disallowed_useragent`. ASWebAuthenticationSession is the compliant browser, so the flow
 * succeeds and returns the redirect to your custom scheme.
 *
 * Web fallback: capability is 'none' — the PWA should use its normal web OAuth (popup/redirect) when
 * `kit.oauth.capability !== 'native'`.
 */
export class OAuthModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('oauth');
  }

  authorize(params: OAuthAuthorizeParams): Promise<OAuthResult> {
    // Dismiss-bound: the ASWebAuthenticationSession / Custom Tab resolves only when the user
    // finishes (password + 2FA + consent) or cancels — there is no meaningful deadline. A watchdog
    // would abandon the request id before the redirect returns and silently drop the login.
    return this.kit.invoke('oauth.authorize', params as unknown as Record<string, unknown>, { timeoutMs: 'none' });
  }
}
