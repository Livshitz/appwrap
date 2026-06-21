import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/** A home-screen long-press quick action. `id` is echoed back to {@link AppModule.onShortcut} when
 *  the user activates it; keep it stable so your router can map it. Custom icons are v1-omitted. */
export interface AppShortcut {
  id: string;
  title: string;
  subtitle?: string;
}

/** Where this build was installed from. Drives beta-vs-prod analytics cohorts.
 *  - `appstore` / `playstore` — public store install
 *  - `testflight` — iOS beta
 *  - `sideload` — direct install (dev build, ad-hoc, APK), or unknown installer
 *  - `simulator` — running on a simulator/emulator
 *  - `web` — not running inside the native shell */
export type InstallSource = 'appstore' | 'playstore' | 'testflight' | 'sideload' | 'simulator' | 'web';

/** Install-level environment facts the page can't derive itself. First-party,
 *  non-tracking (no IDFA/GAID): `installId` is iOS IDFV / an Android UUID kept in
 *  app storage — app-scoped and reset on uninstall. */
export interface AppEnvironment {
  source: InstallSource;
  /** Stable per-install id (iOS identifierForVendor / Android random UUID). */
  installId?: string;
  /** First install epoch-ms (Android only; omitted on iOS — no clean API). */
  firstInstallAt?: number;
  /** Last update epoch-ms (Android only). */
  lastUpdateAt?: number;
  /** Running on a simulator/emulator. */
  isEmulator: boolean;
}

/** System-level app actions: hand a URL to the OS, or open this app's settings page. */
export class AppModule {
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('app');
  }

  /** 'native' where the OS exposes an app-icon badge (iOS always; Android launcher-dependent →
   *  honest no-op) · 'web' where the Badging API exists · else 'none'. Branch on this, not try/catch. */
  get badgeCapability() {
    return this.kit.capability('badge');
  }

  /**
   * Set (or clear, with `0`) the app-icon badge count — the small number on the home-screen icon.
   * Convenience over the shared native badge path: iOS sets the springboard badge; Android is an
   * honest no-op (launchers own badges); web uses the Badging API where present.
   * Branch on {@link badgeCapability}.
   */
  badge(count: number): Promise<void> {
    return this.kit.invoke('notifications.setBadge', { count });
  }

  /** Install-level environment facts for analytics/identification (source, install id, timestamps). */
  environment(): Promise<AppEnvironment> {
    return this.kit.invoke('app.environment');
  }

  /** Open a URL in the OS default handler (external browser, mail:, tel:, maps:, …). */
  openUrl(url: string): Promise<void> {
    return this.kit.invoke('app.openUrl', { url });
  }

  /**
   * Probe whether the OS can open `url` — i.e. some installed app (or the OS) handles its scheme.
   * Use it to hide a "Open in <App>" button when the target app isn't installed.
   *
   * Common schemes (http/https/tel/mailto/sms) resolve without any declaration. To probe a CUSTOM
   * scheme (e.g. `whatsapp://`) it MUST be declared up-front, else the OS reports false for privacy:
   *  - Custom scheme, BOTH platforms — list the scheme in `appwrap.json.queryUrlSchemes`. It stamps iOS
   *    Info.plist `LSApplicationQueriesSchemes` AND Android `<queries>` (a VIEW `<intent>` per scheme),
   *    so a scheme probe works identically on iOS and Android with one declaration.
   *  - Android explicit package (optional) — to probe a specific package directly, list it in
   *    `appwrap.json.queryPackages` (→ AndroidManifest `<queries><package>`). Android-only.
   * Web is always `false` — a PWA can't probe installed apps (honest).
   */
  canOpenUrl(url: string): Promise<boolean> {
    return this.kit.invoke('app.canOpenUrl', { url });
  }

  /** Open this app's page in the OS Settings app (to toggle permissions, etc.). */
  openSettings(): Promise<void> {
    return this.kit.invoke('app.openSettings');
  }

  /** 'native' where the OS exposes home-screen quick actions (iOS 3D-Touch/long-press shortcut items;
   *  Android 7.1+ app shortcuts) · else 'none'. Branch on this, not try/catch. */
  get shortcutsCapability() {
    return this.kit.capability('shortcuts');
  }

  /**
   * Set the app's home-screen long-press quick actions (replaces any previously set). Pass `[]` to
   * clear. iOS assigns `UIApplication.shortcutItems`; Android sets dynamic shortcuts (API 25+, no-op
   * below); web is a no-op. Activation is delivered via {@link onShortcut}. Custom icons are v1-omitted.
   */
  setShortcuts(items: AppShortcut[]): Promise<void> {
    return this.kit.invoke('app.setShortcuts', { items });
  }

  /**
   * Fire when the user activates a home-screen shortcut, with its `id`. Like deep links, a shortcut
   * that COLD-LAUNCHED the app is buffered natively until the handshake, so a listener registered at
   * startup still receives it.
   */
  onShortcut(cb: (id: string) => void): Unsubscribe {
    return this.kit.on('app.shortcut', (p) => cb((p as { id: string }).id));
  }
}
