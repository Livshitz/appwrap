/**
 * Pure iOS keyboard-frame decision (no NativeScript/UIKit globals — unit-testable).
 *
 * Decides how many points of the screen a keyboard notification's end frame covers, or why the
 * event must NOT shrink the webview. A hidden keyboard must always end at full height, so any
 * doubtful event resolves to "skip" — the hide pair (willHide/didHide) owns the restore.
 */
export type KeyboardEventTag = 'willShow' | 'didShow' | 'willChangeFrame';

export interface KeyboardFrameInput {
  tag: KeyboardEventTag;
  /** willShow/didShow seen since the last willHide/didHide — the keyboard is (becoming) visible. */
  inShowCycle: boolean;
  /** UIKeyboardFrameEndUserInfoKey, in screen coordinates. Absent → nothing to apply. */
  end?: { y: number };
  /** Window height, or the SCREEN height when the webview is momentarily out of a window. */
  containerHeight: number;
}

export interface KeyboardFrameDecision {
  height: number;
  skip?: 'no-frame' | 'off-screen' | 'out-of-cycle' | 'bogus';
}

export function resolveKeyboardHeight(input: KeyboardFrameInput): KeyboardFrameDecision {
  const { tag, inShowCycle, end, containerHeight } = input;
  if (!end || !(containerHeight > 0)) return { height: 0, skip: 'no-frame' };
  // Overlap with the container, NOT the frame's height: iOS delivers keyboard-sized but off-screen
  // end frames during dismissal — the frame height would shrink a keyboard-less screen.
  const height = Math.max(0, Math.round(containerHeight - end.y));
  if (height <= 0) return { height: 0, skip: 'off-screen' };
  // willChangeFrame also fires OUTSIDE a show cycle (after didHide: iframe/dialog teardown, audio
  // session / speech-recognition takeover) with an on-screen end frame. Applying it re-shrinks a
  // keyboard-less screen and nothing restores it (field bug: half-screen empty band across screens).
  // A keyboard that really appears always posts willShow or didShow (warm re-focus = didShow-only),
  // which re-opens the cycle and lands the shrink.
  if (tag === 'willChangeFrame' && !inShowCycle) return { height: 0, skip: 'out-of-cycle' };
  // Bogus full-screen frames (origin.y≈0, seen during SMS-OTP autofill): a real software keyboard is
  // never >85% of the screen; the real frame follows and self-heals.
  if (height > containerHeight * 0.85) return { height, skip: 'bogus' };
  return { height };
}

/**
 * Stateful show-cycle gate around resolveKeyboardHeight: willShow/didShow open the cycle (a keyboard
 * really appearing posts one of these), the hide pair closes it. Owns the flag so keyboard.ts can't
 * forget to open or close it.
 */
export function createKeyboardShowCycle() {
  let open = false;
  return {
    resolve(input: Omit<KeyboardFrameInput, 'inShowCycle'>): KeyboardFrameDecision {
      if (input.tag === 'willChangeFrame') return resolveKeyboardHeight({ ...input, inShowCycle: open });
      const decision = resolveKeyboardHeight({ ...input, inShowCycle: true });
      // Only a show event with an on-screen keyboard opens the cycle: a skipped (off-screen/no-frame)
      // didShow must not arm a following stray willChangeFrame. 'bogus' is a real keyboard mid-autofill
      // whose true frame follows as willChangeFrame, so it opens.
      if (!decision.skip || decision.skip === 'bogus') open = true;
      // Known, unproven ordering: a late on-screen didShow AFTER didHide still opens + shrinks with no
      // restoring hide to follow. Accepted until the device root cause is confirmed.
      return decision;
    },
    close(): void {
      open = false;
    },
  };
}
