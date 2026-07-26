import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/** Payload of {@link KeyboardModule.onShow}: the on-screen keyboard's height in CSS pixels,
 *  so the page can pad/scroll content above it. */
export interface KeyboardInfo {
  /** Keyboard height in CSS px (0 when unknown). */
  height: number;
}

/**
 * Software-keyboard control + observation — ONE API across platforms.
 *
 * The classic webview pain: the keyboard slides up and covers the focused input.
 * Native emits `show` with the keyboard height (CSS px) and `hide`, so the page can
 * lift content above it; `hide()` dismisses the keyboard programmatically.
 *
 * Native (iOS `UIKeyboardWillShow/Hide`, Android global-layout/IME insets) reports
 * `capability === 'native'`. Web maps to the VisualViewport API where present
 * (`'web'`), else `'none'`. Branch on {@link capability}, not try/catch.
 */
export class KeyboardModule {
  constructor(private kit: NativeKit) {}

  /** 'native' on a shell · 'web' where VisualViewport exists · else 'none'. */
  get capability() {
    return this.kit.capability('keyboard');
  }

  /** Dismiss the software keyboard (resign first responder / hide the IME). */
  hide(): Promise<void> {
    return this.kit.invoke('keyboard.hide');
  }

  /** Keyboard shown — payload carries its height in CSS pixels. */
  onShow(cb: (info: KeyboardInfo) => void): Unsubscribe {
    return this.kit.on('keyboard.show', (p) => cb(p as KeyboardInfo));
  }

  /** Keyboard dismissed. */
  onHide(cb: () => void): Unsubscribe {
    return this.kit.on('keyboard.hide', () => cb());
  }
}
