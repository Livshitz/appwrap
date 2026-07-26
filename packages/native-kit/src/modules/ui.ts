import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface AlertOptions {
  title?: string;
  message: string;
  ok?: string;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  ok?: string;
  cancel?: string;
}

export interface ActionOptions {
  title?: string;
  options: string[];
  cancel?: string;
}

/** Perceived-luminance test for #rgb / #rrggbb — true when the color is light. */
function isLightColor(hex: string): boolean {
  const m = hex.trim().replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (full.length < 6) return false;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Rec. 601 luma; >0.6 reads as a light surface needing dark icons.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

export class UiModule {
  constructor(private kit: NativeKit) {}

  get statusBarCapability() {
    return this.kit.capability('statusBar');
  }

  get screenCapability() {
    return this.kit.capability('screen');
  }

  get dialogsCapability() {
    return this.kit.capability('dialogs');
  }

  get themeColorCapability() {
    return this.kit.capability('themeColor');
  }

  /** 'light' = white icons (dark backgrounds), 'dark' = black icons. */
  setStatusBarStyle(style: 'light' | 'dark'): Promise<void> {
    return this.kit.invoke('ui.statusBar.setStyle', { style });
  }

  safeArea(): Promise<SafeAreaInsets> {
    return this.kit.invoke('ui.safeArea');
  }

  /** 0..1 */
  getBrightness(): Promise<number> {
    return this.kit.invoke('ui.brightness.get');
  }

  setBrightness(level: number): Promise<void> {
    return this.kit.invoke('ui.brightness.set', { level });
  }

  /** Prevent the screen from sleeping. */
  keepAwake(on: boolean): Promise<void> {
    return this.kit.invoke('ui.keepAwake', { on });
  }

  // ── dialogs ──────────────────────────────────────────────────────────

  alert(opts: AlertOptions): Promise<void> {
    return this.kit.invoke('ui.alert', opts, { timeoutMs: 120_000 });
  }

  /** Resolves true on OK, false on cancel. */
  confirm(opts: ConfirmOptions): Promise<boolean> {
    return this.kit.invoke('ui.confirm', opts, { timeoutMs: 120_000 });
  }

  /** Action sheet — resolves the chosen option's index, or null on cancel. */
  action(opts: ActionOptions): Promise<number | null> {
    return this.kit.invoke('ui.action', opts, { timeoutMs: 120_000 });
  }

  // ── theme color ──────────────────────────────────────────────────────

  /** Tint the native chrome behind the page (status bar / safe areas). */
  setBackgroundColor(color: string): Promise<void> {
    return this.kit.invoke('ui.setBackgroundColor', { color });
  }

  /**
   * Keep the native chrome in sync with `<meta name="theme-color">`.
   * Applies the current value immediately and observes changes: tints the
   * native root (visible during launch / rotation / keyboard gaps) AND flips
   * the status-bar icon style to keep contrast against the theme color.
   * No-op on web — the browser honors the meta tag natively.
   */
  syncThemeColor(): Unsubscribe {
    if (this.themeColorCapability !== 'native') return () => {};
    const apply = () => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (!meta?.content) return;
      this.setBackgroundColor(meta.content).catch((e) =>
        console.warn('[native-kit] setBackgroundColor failed', e)
      );
      // Light theme color → dark icons; dark theme color → light icons.
      this.setStatusBarStyle(isLightColor(meta.content) ? 'dark' : 'light').catch(() => {});
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['content'],
    });
    return () => observer.disconnect();
  }
}
