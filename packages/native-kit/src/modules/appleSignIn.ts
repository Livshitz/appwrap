import type { NativeKit } from '../core/NativeKit';
import { KitError } from '../core/types';

/** The name Apple returns on the FIRST authorization per Apple ID (subsequent sign-ins omit it). */
export interface AppleSignInName {
  /** Given (first) name, when provided. */
  givenName?: string;
  /** Family (last) name, when provided. */
  familyName?: string;
  /** A display name composed by the OS from the components, when provided. */
  displayName?: string;
}

/** A successful native Sign in with Apple. Feed `identityToken` + `nonce` (raw) to Firebase:
 *  `signInWithCredential(OAuthProvider.credential('apple.com', { idToken: identityToken, rawNonce: nonce }))`. */
export interface AppleSignInResult {
  /** The Apple identity JWT (`id_token`) — what Firebase / your backend verifies. */
  identityToken: string;
  /** Short-lived authorization code (for an optional server-side token exchange). */
  authorizationCode?: string;
  /** The RAW nonce you passed in — Apple hashed SHA256(nonce); Firebase needs the raw value back. */
  nonce: string;
  /** First-authorization-only profile. Apple returns name/email ONLY the first time per Apple ID —
   *  persist it on first sign-in; it is absent on every subsequent call. */
  user?: { name?: AppleSignInName; email?: string };
}

/** Sign in resolved without a credential because the user dismissed the system sheet. */
export interface AppleSignInCancelled {
  cancelled: true;
}

export interface AppleSignInParams {
  /** A RAW, cryptographically-random nonce (the caller generates it). The handler sends SHA256(nonce)
   *  to Apple and returns this raw value so you can pass it to Firebase as `rawNonce`. Required. */
  nonce: string;
  /** Profile scopes to request on first authorization. Default `['name', 'email']`. */
  scopes?: Array<'name' | 'email'>;
}

/** True when an {@link AppleSignInResult} (a credential) is present (not the cancelled shape). */
export function isAppleSignInResult(r: AppleSignInResult | AppleSignInCancelled): r is AppleSignInResult {
  return (r as AppleSignInCancelled).cancelled !== true;
}

/**
 * Native Sign in with Apple — iOS `ASAuthorizationController` (the system account sheet). Returns the
 * `identityToken` (JWT) + the raw nonce DIRECTLY to JS, so a wrapped app does true-native Apple auth and
 * hands the result to Firebase `signInWithCredential(OAuthProvider.credential('apple.com', { idToken,
 * rawNonce }))` — no Services ID, no https Return URL, no browser redirect, no cross-origin storage.
 *
 * WHY (not `kit.oauth`): the web-OAuth path (`ASWebAuthenticationSession`) needs an Apple **Services ID**
 * with a custom-scheme `redirect_uri`, which Apple rejects (Services IDs require registered https Return
 * URLs). The native ASAuthorization flow uses the **App ID** (bundle) and returns the token directly.
 *
 * Provider-agnostic, like `kit.push`/`kit.oauth`: the shell owns only the device-side primitive (present
 * the sheet, hash the nonce, hand back the token). The PWA generates the nonce and does the Firebase
 * `signInWithCredential` exchange.
 *
 * Capability gating (honest):
 *  - iOS 13+: `'native'`.
 *  - Android / web / iOS < 13: `'none'` — Sign in with Apple has NO native SDK off iOS. {@link signIn}
 *    throws `UNSUPPORTED`; the PWA should fall back to its web Apple auth (Firebase popup/redirect)
 *    when `capability !== 'native'`. Branch on {@link capability}.
 *
 * Cancel contract: a user-dismissed sheet RESOLVES `{ cancelled: true }` (never throws) — mirrors
 * {@link import('./scanner').ScannerModule}. Real failures reject with a {@link import('../core/types').KitError}.
 */
export class AppleSignInModule {
  constructor(private kit: NativeKit) {}

  /** `'native'` on an iOS shell · `'none'` on Android/web/iOS<13. */
  get capability() {
    return this.kit.capability('appleSignIn');
  }

  /**
   * Present the native Sign in with Apple sheet. Resolves an {@link AppleSignInResult} on success or
   * `{ cancelled: true }` if the user dismisses it (branch with {@link isAppleSignInResult}).
   *
   * The handler hashes the supplied raw `nonce` (SHA256) before sending it to Apple and returns the
   * RAW nonce in the result so you can pass it to Firebase as `rawNonce`.
   *
   * Dismiss-bound — the sheet resolves only when the user completes or cancels, so there's no watchdog
   * timeout (a deadline would abandon the request mid-handshake). Throws `UNSUPPORTED` off iOS.
   */
  signIn(params: AppleSignInParams): Promise<AppleSignInResult | AppleSignInCancelled> {
    const nonce = String(params?.nonce ?? '');
    if (!nonce) return Promise.reject(new KitError('NATIVE_ERROR', 'appleSignIn: a raw nonce is required'));
    if (this.capability !== 'native') {
      return Promise.reject(new KitError('UNSUPPORTED', 'appleSignIn is iOS-only (no native Sign in with Apple off iOS)'));
    }
    const scopes = params.scopes ?? ['name', 'email'];
    return this.kit.invoke('appleSignIn.signIn', { nonce, scopes }, { timeoutMs: 'none' });
  }
}
