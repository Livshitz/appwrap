/**
 * appwrap config — the typed shape of an app's wrapper config + the `defineConfig` helper.
 *
 * This module is import-safe (no side effects, no CLI dispatch), so it can be imported from a
 * TypeScript config file to get full autocomplete + type-checking:
 *
 *   // appwrap.config.ts
 *   import { defineConfig } from '@livx.cc/appwrap/config';
 *   export default defineConfig({
 *     id: 'com.example.app',
 *     name: 'Example',
 *     version: '1.0.0',
 *     pwaDist: 'dist',
 *   });
 *
 * The CLI resolves `appwrap.config.ts` → `appwrap.config.js` → `appwrap.json` (TS preferred,
 * JSON still supported as a fallback). See `loadConfig` in cli.ts.
 */

export interface AppwrapConfig {
  id: string;
  name: string;
  version: string;
  entry?: string;
  backgroundColor?: string;
  statusBarStyle?: 'light' | 'dark';
  /** Boot-time native chrome color (status bar / safe areas behind the page). Falls back to the PWA
   * manifest's `theme_color` when absent. The shell tints the native root with it at launch (the
   * same surface `kit.ui.syncThemeColor()` keeps in sync with `<meta name="theme-color">` at runtime)
   * — distinct from `backgroundColor`, which paints the page/splash. CSS color string (e.g. `#0b1020`). */
  themeColor?: string;
  /** Supported device orientation. Falls back to the PWA manifest's `orientation` when absent
   * (`*-primary`/`*-secondary` variants normalize to the axis). `portrait` / `landscape` lock the
   * axis; `any` (default) leaves rotation free (sans upside-down on iOS). Stamped into iOS
   * `UISupportedInterfaceOrientations` (+ `~ipad`) and Android `android:screenOrientation`. */
  orientation?: 'portrait' | 'landscape' | 'any';
  /** Android only (experimental). When true, the WebView draws genuinely edge-to-edge UNDER the
   * transparent system bars (NS `androidOverflowEdge='dont-apply'`) and the real safe-area insets
   * are injected as `--saie-*` CSS vars + native `env(safe-area-inset-*)`, so a multi-theme PWA
   * paints the bar regions itself. Default false = bars show the page `backgroundColor` (works, but
   * can't match a multi-theme app). iOS is always genuinely edge-to-edge. */
  edgeToEdge?: boolean;
  pwaDist: string;
  /** Custom URL scheme for deep links (e.g. "hellowrap" → hellowrap://...). */
  urlScheme?: string;
  /** Custom URL schemes `kit.app.canOpenUrl()` may probe (e.g. `['whatsapp', 'tg']`) — covers BOTH
   * platforms with a single declaration. Since iOS 9 / Android API 30+ a probe of an undeclared custom
   * scheme returns false for privacy. These stamp into iOS Info.plist `LSApplicationQueriesSchemes` AND
   * Android `<queries>` as a VIEW `<intent>` per scheme — so scheme-based `canOpenUrl` is symmetric
   * without hand-mapping each scheme to a package. Common schemes (http/https/tel/mailto/sms) need no
   * declaration on either platform. No-op when absent. */
  queryUrlSchemes?: string[];
  /** Android-only explicit package visibility for `kit.app.canOpenUrl()` (e.g. `['com.whatsapp']`) —
   * for probing a specific package directly. Under API 30+ package visibility, `resolveActivity`
   * returns null for undeclared packages — these stamp into AndroidManifest `<queries>` as
   * `<package android:name="..."/>`. For scheme probes prefer `queryUrlSchemes` (cross-platform).
   * No-op when absent. */
  queryPackages?: string[];
  /** App icon source (≥512px square png). Defaults to the largest icon in the PWA manifest. */
  icon?: string;
  /** Loader: 'app' (default — app:// scheme, ES modules OK), 'file' (debug fallback), or 'server'
   * (load `serverUrl` live — dev HMR over LAN or a deployed URL). `appwrap dev` sets this. */
  loader?: 'app' | 'file' | 'server';
  /** Live URL loaded when loader === 'server'. Set via config or `appwrap dev --url <url>`. */
  serverUrl?: string;
  /** Absolute backend origin for an offline (loader:'app') PWA whose API/WebSocket calls were
   * originally same-origin (e.g. "https://api.example.com"). Injected to the page as
   * `window.__APPWRAP_BACKEND_ORIGIN__`; a same-origin PWA reads it to make its calls absolute.
   * Empty/unset = same-origin (browser default), so the same web build is unaffected. */
  backendOrigin?: string;
  /** Backend-served STATIC assets the PWA loads via a *relative, hardcoded* URL (e.g. an SDK
   * `<script src="/_vendor/sdk.js">` that can't be made absolute without breaking script order).
   * Fetched from `backendOrigin` at build time and bundled into www/, so they resolve offline at
   * app://. The asset is pinned to the build (correct for a no-OTA native app). Needs `backendOrigin`. */
  vendorPaths?: string[];
  /** Debug/dev mode: keeps the screen awake (no auto-lock while foreground) + makes the WebView
   * inspectable (Safari Web Inspector / chrome://inspect) for continuous troubleshooting. `appwrap
   * deploy` forces this on; `appwrap build` leaves it off. NEVER ship a store build with debug on. */
  debug?: boolean;
  /** In debug mode, the value written to `localStorage.DEBUG` at startup so the PWA's logger goes
   * verbose (common convention — `'*'` = all, or comma-separated module names). Default `'*'`. */
  debugLog?: string;
  /** Shake-to-open developer menu (App Info / Reload). Default `true` — ON in store builds too, since
   * it only exposes non-sensitive diagnostics (ids, versions, loader, remote host). Set `false` to
   * disable. Remote-update detection (native-kit `kit.updates`) is independent of this flag. */
  devMenu?: boolean;
  /** Neutralize `navigator.serviceWorker.register` in the native shell so the consumer PWA doesn't
   * have to gate its own SW. Inside the shell a service worker is useless-to-harmful: a cache-first SW
   * serves a stale bundle and fights the native app:// scheme handler / loader:'server' remote-update
   * detection. Default `true` (only affects the native build — the same web build is untouched).
   * Set `false` to opt out and leave the SW fully intact — e.g. if the PWA intentionally wants its SW
   * for in-WebView web-push as a fallback. NOTE: keeping the SW is the only way to get web push; native
   * push is the separate `push` lane (APNs/FCM) and does NOT need a SW. */
  neutralizeServiceWorker?: boolean;
  /** Hand navigations that LEAVE the app's own origin to the OS default browser (Safari / Chrome)
   * instead of replacing the shell WebView — so external links and `window.open(...)`/`target="_blank"`
   * behave like a regular native app (open in the system browser) rather than navigating away inside
   * the shell. Covers external-origin `<a>` clicks (including `target="_blank"`) and `window.open()`;
   * same-origin SPA navigation, subframes/iframes and `tel:`/`mailto:` are left untouched. Default
   * `false` (unchanged in-WebView navigation). See `externalNavGuardJs`. */
  openNewWindowsInBrowser?: boolean;
  /** Apple Development Team ID for device builds (Xcode → Settings → Accounts). */
  teamId?: string;
  /** Path (relative to the PWA project) to a StoreKit configuration file for LOCAL IAP
   * testing — products resolve without App Store Connect. Only applies when launched from
   * Xcode (simulator or device-from-Xcode), not a standalone devicectl sideload. */
  storekitConfig?: string;
  /** Permission usage strings, keyed by domain. Only listed ones are stamped
   * (iOS: Info.plist usage string; Android: <uses-permission>). 'contacts' has no
   * iOS key (CNContactPicker needs none) — it only stamps Android READ_CONTACTS. */
  permissions?: Partial<
    Record<'location' | 'photos' | 'camera' | 'microphone' | 'faceid' | 'calendar' | 'contacts' | 'motion', string>
  >;
  /** Monotonic build identifier. Stores reject a re-upload unless this is HIGHER than the last:
   * iOS `CFBundleVersion`, Android `versionCode` (the marketing `version` stays the user-facing
   * string). Default: an integer derived from `version` (0.2.1 → 201). Set explicitly from a CI
   * run number for fleet builds of the same marketing version. */
  buildNumber?: string | number;
  /** iOS export-compliance. `ITSAppUsesNonExemptEncryption` — stamped `false` by default (skips the
   * per-upload prompt). Set `true` only if the app uses non-exempt encryption. */
  usesNonExemptEncryption?: boolean;
  /** Pure-native escape hatch: a directory (relative to the PWA project) whose contents are copied
   * OVER the generated wrapper after stamping — for legacy/custom native code the declarative config
   * can't express. Default `'appwrap.overrides'`; applied only if it exists. */
  overrides?: string;
  /** Reserved — appwrap plugins (npm packages contributing a kit module + native handlers + config).
   * Parsed today; full native composition lands with the plugin contract (see framework-extensibility). */
  plugins?: string[];
  /** Opt-in capability allow-list (built-in modules — see capabilities.manifest.ts). When PRESENT,
   * only the listed capabilities (plus always-on core) are advertised, permissioned, and — for
   * modules that own their handler file (e.g. health) — compiled into the shell. Their permissions,
   * background modes and native deps are collected from each module's self-contained manifest entry
   * (the per-app `permissions{}` map only OVERRIDES the default usage copy). When ABSENT, every
   * capability is active and permissions come solely from `permissions{}` (pre-modules behavior). */
  modules?: string[];
  /** Remote push (APNs/FCM). Off unless set — gating matters: an `aps-environment` entitlement on a
   * team that can't hold the Push capability (e.g. a personal team) BREAKS code signing, and the
   * handshake should honestly report `push: 'none'` on an un-provisioned build. The kit returns a raw
   * token; SENDING is your backend's job (provider-agnostic). */
  push?: {
    /** Master switch for the push lane. */
    enabled?: boolean;
    /** Per-platform gates (default true when `enabled`). Split because the two platforms have
     * independent prerequisites: iOS needs the `aps-environment` entitlement (a PAID Apple team —
     * a personal team can't hold it, and stamping it would break signing), Android needs FCM +
     * google-services.json. e.g. `{ enabled:true, ios:false, android:true }` ships Android push
     * while keeping a personal-team iOS build signable. */
    ios?: boolean;
    android?: boolean;
    /** iOS APNs environment in the entitlement: 'development' (debug/TestFlight builds) or
     * 'production' (App Store). Default 'development'. */
    apsEnvironment?: 'development' | 'production';
    /** Path (relative to the PWA project) to the Firebase `google-services.json` for Android FCM. */
    googleServicesJson?: string;
    /** Optional backend URL the shell POSTs the device token to NATIVELY on acquisition (`{token,
     * platform}`). Native HTTP sidesteps the WKWebView app:// cross-origin wall — the token reaches
     * your server with no WebView fetch. Your backend stores it + sends pushes (provider-agnostic). */
    registrationUrl?: string;
  };
}

/**
 * Identity helper for a TypeScript config file. Does nothing at runtime — it exists purely so your
 * editor type-checks the object and offers autocomplete against {@link AppwrapConfig}.
 *
 *   import { defineConfig } from '@livx.cc/appwrap/config';
 *   export default defineConfig({ id: '…', name: '…', version: '1.0.0', pwaDist: 'dist' });
 */
export function defineConfig(config: AppwrapConfig): AppwrapConfig {
  return config;
}
