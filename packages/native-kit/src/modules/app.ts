import type { NativeKit } from '../core/NativeKit';

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

  /** Install-level environment facts for analytics/identification (source, install id, timestamps). */
  environment(): Promise<AppEnvironment> {
    return this.kit.invoke('app.environment');
  }

  /** Open a URL in the OS default handler (external browser, mail:, tel:, maps:, …). */
  openUrl(url: string): Promise<void> {
    return this.kit.invoke('app.openUrl', { url });
  }

  /** Open this app's page in the OS Settings app (to toggle permissions, etc.). */
  openSettings(): Promise<void> {
    return this.kit.invoke('app.openSettings');
  }
}
