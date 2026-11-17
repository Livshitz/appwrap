/**
 * Who owns the app's AVAudioSession, and what the shell may re-apply. Pure (no NativeScript globals) → unit-tested.
 *
 * - `bootDefault`: the category `backgroundAudio` sets at launch. A DEFAULT, never a claim: the shell never activates
 *   it on its own (activating a non-mixing session stops the user's music; WKWebView activates when audio plays).
 * - `claim`: a page EXPLICITLY asked via `media.configureAudio`. Only a live claim lets the shell re-activate. It is
 *   cleared when a new top-level document loads (that page never asked).
 * WebKit also drives the session (getUserMedia → playAndRecord): when the live category is not the one the claim set,
 * the shell leaves it alone.
 */
export type Mode = 'playback' | 'playAndRecord' | 'voiceChat' | 'default';
export interface SessionConfig { mode: Mode; mixWithOthers: boolean }
export interface Decision { apply: SessionConfig | null; activate: boolean }

export class AudioSessionPolicy {
  bootDefault: SessionConfig | null = null;
  claim: SessionConfig | null = null;

  setBootDefault(c: SessionConfig): void { this.bootDefault = c; }
  setClaim(c: SessionConfig): void { this.claim = c; }
  /** New top-level document: the page that claimed the session is gone. */
  clearClaim(): void { this.claim = null; }

  /** Interruption ended. `liveCategoryIsClaims` = the session's current category is the one the claim set. */
  onInterruptionEnded(shouldResume: boolean, liveCategoryIsClaims: boolean): Decision {
    if (!shouldResume || !this.claim || !liveCategoryIsClaims) return { apply: null, activate: false };
    return { apply: this.claim, activate: true };
  }

  /** The page drops its claim (`media.releaseAudio`). No claim → no-op. With one: forget it, put the category back to
   * the boot default (`apply`; null = the system default, SoloAmbient) and deactivate so the user's music can resume
   * — the shell deactivates best-effort (iOS refuses while web audio I/O still runs; then it stays active). */
  onRelease(): { noop: boolean; apply: SessionConfig | null; deactivate: boolean } {
    if (!this.claim) return { noop: true, apply: null, deactivate: false };
    this.claim = null;
    return { noop: false, apply: this.bootDefault, deactivate: true };
  }

  /** mediaserverd reset: every session setting is gone. Restore the category; activate only for a live claim. */
  onMediaServicesReset(): Decision {
    if (this.claim) return { apply: this.claim, activate: true };
    return { apply: this.bootDefault, activate: false };
  }
}
