import type { NativeKit } from '../core/NativeKit';

/** App Tracking Transparency authorization status (iOS ATTrackingManager). Mirrors Apple's enum.
 *  - `notDetermined` — the user hasn't been asked yet (call {@link TrackingModule.requestPermission}).
 *  - `restricted`    — tracking is disallowed by device policy (e.g. parental controls / MDM).
 *  - `denied`        — the user declined; you MUST NOT track / read the IDFA.
 *  - `authorized`    — the user allowed tracking; {@link TrackingModule.idfa} returns the IDFA. */
export type TrackingStatus = 'notDetermined' | 'restricted' | 'denied' | 'authorized';

/**
 * App Tracking Transparency (iOS, `tracking` module — opt-in). The native-only compliance seam for
 * apps that track the user across other companies' apps/sites (IDFA, cross-app identity): Apple
 * REQUIRES the ATT prompt + `NSUserTrackingUsageDescription` and forbids tracking before consent.
 *
 * Provider-agnostic, like `kit.push`/`kit.oauth`: the shell owns only the device-side primitive
 * (show the prompt, report status, hand back the IDFA when authorized). What you DO with consent —
 * init an ad SDK, set an analytics super-prop — is the PWA's job.
 *
 * Capability gating (honest):
 *  - iOS (14.5+): `'native'`.
 *  - Android / web / iOS < 14.5: `'none'` — there is NO ATT. The methods still resolve safely:
 *    `requestPermission()`/`status()` → `'authorized'` (no consent gate exists, so tracking is not
 *    blocked by the OS — Play's Advertising-ID consent is a separate, app-declared concern), and
 *    `idfa()` → `undefined` (the IDFA is iOS-only; GAID needs the AD_ID permission + Play's own flow).
 *
 * Most apps need only first-party analytics and should NOT enable this module (no string = Apple
 * assumes no tracking). Ship it only when the app genuinely tracks across companies.
 */
export class TrackingModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('tracking');
  }

  /** Honest fallback when ATT doesn't exist (Android/web/iOS<14.5): nothing gates tracking at the OS
   *  level, so report `authorized` rather than a misleading `notDetermined`. */
  private get fallback(): TrackingStatus {
    return 'authorized';
  }

  /**
   * Show the iOS ATT prompt and resolve with the resulting status. The prompt only appears once per
   * install while status is `notDetermined`; subsequent calls resolve immediately with the prior
   * choice. Dismiss-bound (the user decides at their leisure) → no watchdog timeout.
   * On a non-ATT platform resolves to {@link fallback} without showing UI.
   */
  requestPermission(): Promise<TrackingStatus> {
    if (this.capability !== 'native') return Promise.resolve(this.fallback);
    return this.kit.invoke<TrackingStatus>('tracking.requestPermission', undefined, { timeoutMs: 'none' });
  }

  /** Current ATT authorization status WITHOUT prompting. {@link fallback} on a non-ATT platform. */
  status(): Promise<TrackingStatus> {
    if (this.capability !== 'native') return Promise.resolve(this.fallback);
    return this.kit.invoke<TrackingStatus>('tracking.status');
  }

  /** Alias of {@link status} (parity with other permissioned modules' `permissionStatus`). */
  permissionStatus(): Promise<TrackingStatus> {
    return this.status();
  }

  /**
   * The IDFA (iOS advertising identifier) — returned ONLY while ATT status is `authorized`; otherwise
   * (denied/restricted/notDetermined, or the all-zero placeholder) resolves `undefined`. Always
   * `undefined` off iOS (no IDFA exists — use Play's Advertising ID via your own flow if needed).
   */
  idfa(): Promise<string | undefined> {
    if (this.capability !== 'native') return Promise.resolve(undefined);
    return this.kit.invoke<string | undefined>('tracking.idfa');
  }
}
