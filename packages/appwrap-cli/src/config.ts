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

/** A single named environment shown in the switcher menu. */
export interface EnvSwitcherEnv {
  /** Human label shown in the menu + banner (e.g. 'Prod', 'Lab', 'PR #123'). */
  label: string;
  /** Absolute origin the WebView loads for this env (e.g. 'https://lab.example.com'). */
  url: string;
}

/** Runtime env-switcher config (see `AppwrapConfig.envSwitcher`). */
export interface EnvSwitcherConfig {
  /** Kill-switch. Omitted → ON when the block is present. A prod config fork can set `false` to
   * HARD-DISABLE the whole feature (menu action + banner + boot override all inert) even if `envs` /
   * `allowPattern` are declared. Absent `envSwitcher` block entirely → also off (default for any app). */
  enabled?: boolean;
  /** Presets shown in the switch menu; always implicitly trusted (bypass `allowPattern`). */
  envs?: EnvSwitcherEnv[];
  /** Anchored regex (`^…$`) gating the free-form "Other" URL entry. DEFAULT-DENY: absent/invalid →
   * "Other" is disabled (presets only). Compiled with try/catch; a throwing pattern → default-deny. */
  allowPattern?: string;
  /** Deeplink auto-switch (Phase 2 — not yet implemented). Opt-in. */
  deeplink?: boolean;
}

/** iOS share-extension direct sync (`shareTarget.directSync`). When configured, the generated
 * `AppwrapShare` extension tries to complete the share ITSELF — one HTTP call to the app's backend,
 * with an honest "Syncing… → Synced" drawer status — instead of only parking the payload in the
 * App-Group mailbox for the next app open (Apple forbids a share extension launching its host, so
 * this makes launching unnecessary). Any failure (offline, non-2xx, missing/incomplete context,
 * oversized image) falls back to the unchanged mailbox behavior.
 *
 * `{key}` placeholders in the templates resolve from the SHARE CONTEXT — a small KV the web app
 * publishes via `kit.shareTarget.setContext({...})` (persisted as JSON in the App Group under
 * `appwrap-share-context`). The framework treats both the context and the templates as opaque —
 * nothing app-specific is baked in. */
export interface ShareDirectSyncConfig {
  /** Endpoint template, e.g. `https://api.example.com/bin/{binId}`. Every `{key}` must resolve from
   * the published context or the sync is skipped (mailbox fallback). */
  urlTemplate: string;
  /** HTTP method for the write (default `PUT`). Body is JSON. */
  method?: 'PUT' | 'POST';
  /** JSON body field names: shared text goes under `text` (default `content`), the shared image —
   * as a base64 data URL — under `image` (default `image`). */
  fields?: { text?: string; image?: string };
  /** `append` (default `replace`): GET the same URL first, append the shared text to the existing
   * `fields.text` value (newline-joined) and PRESERVE the existing image unless a new one is shared.
   * `replace` writes the payload as-is (no GET). */
  merge?: 'append' | 'replace';
  /** Max encoded image size (bytes, default 4_000_000). A larger shared image is first DOWNSCALED
   * (longest edge → `maxImageEdge`, JPEG `jpegQuality`) — mirroring the typical web-side pipeline;
   * only if it still exceeds the cap (or fails to decode) does the whole share fall back to the
   * mailbox (which keeps the ORIGINAL bytes for the app to ingest). */
  maxImageBytes?: number;
  /** Downscale target when over `maxImageBytes`: longest edge in px (default 2000). */
  maxImageEdge?: number;
  /** JPEG re-encode quality for the downscale (0–1, default 0.85). */
  jpegQuality?: number;
  /** Drawer success text template (default `Synced`), `{key}` from context — e.g. `Synced to {binId}`. */
  successMessage?: string;
}

/** {@link ShareDirectSyncConfig} with defaults applied — the exact shape stamped into the extension. */
export function resolveShareDirectSync(ds: ShareDirectSyncConfig): Required<Omit<ShareDirectSyncConfig, 'fields'>> & { fields: { text: string; image: string } } {
  return {
    urlTemplate: ds.urlTemplate,
    method: ds.method ?? 'PUT',
    fields: { text: ds.fields?.text ?? 'content', image: ds.fields?.image ?? 'image' },
    merge: ds.merge ?? 'replace',
    maxImageBytes: ds.maxImageBytes ?? 4_000_000,
    maxImageEdge: ds.maxImageEdge ?? 2000,
    jpegQuality: ds.jpegQuality ?? 0.85,
    successMessage: ds.successMessage ?? 'Synced',
  };
}

/** Base64(JSON) encoding of the resolved direct-sync config — safe to stamp inside a Swift string
 * literal (base64 needs no escaping). Empty string when absent/invalid → the feature is inert. */
export function encodeShareDirectSync(ds: ShareDirectSyncConfig | undefined): string {
  if (!ds?.urlTemplate) return '';
  return Buffer.from(JSON.stringify(resolveShareDirectSync(ds)), 'utf8').toString('base64');
}

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
  /** iOS targeted device family. `'iphone'` builds an iPhone-only app (TARGETED_DEVICE_FAMILY=1 →
   * UIDeviceFamily=[1]); `'universal'` (default — NativeScript's behavior) targets iPhone + iPad,
   * which makes the App Store require a full iPad screenshot set. Set `'iphone'` for a phone-only
   * app to avoid that requirement. iOS-only; no-op on Android. */
  targetedDevices?: 'iphone' | 'universal';
  /** Android only (experimental). When true, the WebView draws genuinely edge-to-edge UNDER the
   * transparent system bars (NS `androidOverflowEdge='dont-apply'`) and the real safe-area insets
   * are injected as `--saie-*` CSS vars + native `env(safe-area-inset-*)`, so a multi-theme PWA
   * paints the bar regions itself. Default false = bars show the page `backgroundColor` (works, but
   * can't match a multi-theme app). iOS is always genuinely edge-to-edge. */
  edgeToEdge?: boolean;
  /** iOS only. Extra points to lift the WebView above the reported keyboard height on focus, to hide
   * the iOS-26 phantom keyboard-height gap (the reported keyboard is taller than it draws on warm
   * re-focus, leaving a black strip). Default 82; the keyboard covers the thin bottom content row.
   * Set 0 for no extra lift (input flush at the reported height; the strip may show). */
  iosKeyboardExtraLift?: number;
  pwaDist: string;
  /** Desktop-shell block, consumed by an external desktop host (a module pack) that registers a
   * `'desktop'` platform handler via `runCli({ platforms })`. Carried OPAQUE — nothing here reads
   * it; the key is registered only so `unknownConfigKeys` doesn't warn on configs that declare it. */
  desktop?: Record<string, unknown>;
  /** Custom URL scheme for deep links (e.g. "hellowrap" → hellowrap://...). */
  urlScheme?: string;
  /** Android App Links: https hosts whose `https://<host>/...` links open the app directly (the
   * Android equivalent of iOS Universal Links / associated-domains `applinks:`). Each host gets an
   * `android:autoVerify="true"` VIEW intent-filter in the manifest. Verification ALSO requires the host
   * to serve `/.well-known/assetlinks.json` listing the app's package + signing-cert SHA-256.
   * When OMITTED, the hosts are DERIVED from the iOS `associated-domains` `applinks:<host>` entries in
   * `iosEntitlements` — so one universal-link declaration covers both platforms. `[]` disables it. */
  androidAppLinks?: string[];
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
  /** Extra custom URL schemes the system browser (Android Chrome Custom Tabs) may redirect back to
   * during `kit.oauth` flows — e.g. Google's reversed iOS-client id scheme
   * `com.googleusercontent.apps.<client>`. On Android the Custom Tab does NOT auto-close; the provider
   * redirect re-enters the app only via a manifest deep-link intent-filter, so each OAuth redirect
   * scheme MUST be registered as a BROWSABLE VIEW `<data>` on the main activity — otherwise the
   * redirect has no handler and the browser web-searches it (lands on google.com). These stamp as
   * additional `<data android:scheme="..."/>` siblings of `urlScheme`'s deep-link filter. iOS needs no
   * equivalent — ASWebAuthenticationSession intercepts the callbackScheme directly. No-op when absent. */
  oauthRedirectSchemes?: string[];
  /** App icon source (≥512px square png). Defaults to the largest icon in the PWA manifest. */
  icon?: string;
  /** Optional centered logo for the iOS launch splash — a TRANSPARENT-background png (a wordmark or
   * glyph, NOT the app icon, whose opaque background would show as a box on the splash). When absent
   * the splash is a clean solid `backgroundColor` fill with no logo. */
  splashIcon?: string;
  /** Loader: 'app' (default — app:// scheme, ES modules OK), 'file' (debug fallback), or 'server'
   * (load `serverUrl` live — dev HMR over LAN or a deployed URL). `appwrap dev` sets this. */
  loader?: 'app' | 'file' | 'server';
  /** Live URL loaded when loader === 'server'. Set via config or `appwrap dev --url <url>`. */
  serverUrl?: string;
  /** CI scaffolding options (`appwrap init --ci`). The emitted GH Actions workflows auto-adapt to the
   * repo shape (job paths + PR path filter scoped to the app subdir when the config sits below the git
   * root; web-build steps dropped for loader:'server'); this block only overrides the derived defaults. */
  ci?: {
    /** Release tag prefix the release workflows trigger on (`tags: ['<prefix>*']`). Default: `v` at
     * the repo root, `<subdir>-v` in a monorepo — so a monorepo's generic `v*` tags can never cut a
     * store release by accident. */
    tagPrefix?: string;
  };
  /** Runtime env-switcher (loader:'server' apps). Lets a build re-point the WebView between declared
   * environments (prod / lab / a preview URL) at runtime — via the native dev-menu "Switch Environment"
   * action + a bottom env-indicator banner — surviving a cold start, with NO separate native build.
   * The chosen URL persists in native storage (`kit:serverUrlOverride`) and is honored by the shell's
   * boot loader. Runs in ALL build types when configured (gate = `allowPattern` + `enabled`, NOT debug —
   * distinct from the debug-only dev-server cert trust). Absent block → the whole feature is inert. */
  envSwitcher?: EnvSwitcherConfig;
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
  /** iOS App-Bound Domains — the hosts (no scheme, max 10 per Apple) the WebView may navigate to.
   * Setting this stamps `WKAppBoundDomains` into Info.plist AND sets
   * `WKWebViewConfiguration.limitsNavigationsToAppBoundDomains = true`, which is Apple's HARD
   * requirement for a service worker to run inside a WKWebView. Pair with `neutralizeServiceWorker:false`
   * to actually enable a SW (this flag is the iOS gate; Android's SW is a separate lane).
   * TRADEOFF: `limitsNavigationsToAppBoundDomains` RESTRICTS the WebView to exactly these domains —
   * any navigation/OAuth/redirect to another domain breaks. Only for single-origin apps. Empty/unset =
   * no change to current behavior (no Info.plist key, no nav restriction). */
  appBoundDomains?: string[];
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
  /** Permission usage strings, keyed by domain. A listed domain is ALWAYS stamped (iOS: Info.plist
   * usage string; Android: <uses-permission>) — with or without `modules`; when a module already owns
   * the same key, the string here overrides its default copy. 'contacts' has no iOS key
   * (CNContactPicker needs none) — it only stamps Android READ_CONTACTS.
   *
   * `camera` is stamped by DEFAULT in every iOS build: WKWebView's `<input type="file">` picker offers
   * "Take Photo", and iOS hard-kills the app for a camera access with no usage string. Pass
   * `camera: false` to opt out (only for an app with no file inputs at all), or your own string to
   * replace the default copy. */
  permissions?: Partial<
    Record<'location' | 'photos' | 'camera' | 'microphone' | 'faceid' | 'calendar' | 'contacts' | 'motion' | 'tracking', string | false>
  >;
  /** App Tracking Transparency tracking domains (iOS, `tracking` module). When the module is active
   * the CLI sets the privacy manifest's `NSPrivacyTracking` → true and fills `NSPrivacyTrackingDomains`
   * with these (the hosts the app/embedded SDKs contact while tracking — Apple validates them at
   * upload). Empty/absent → `NSPrivacyTracking` true with an empty domains array (declare the prompt
   * without listing domains). No-op entirely when the `tracking` module is inactive. */
  trackingDomains?: string[];
  /** Monotonic build identifier. Stores reject a re-upload unless this is HIGHER than the last:
   * iOS `CFBundleVersion`, Android `versionCode` (the marketing `version` stays the user-facing
   * string). Default: an integer derived from `version` (0.2.1 → 201). Set an explicit number from a
   * CI run for fleet builds of one marketing version, OR a named strategy string (resolved by the
   * framework so it can't drift across branches):
   *   - `'timestamp'` — YYMMDDHHMM UTC (e.g. 2606221405). iOS-ONLY: exceeds Android's versionCode cap.
   *   - `'epoch'` — unix seconds. Android-safe.
   * (`APPWRAP_BUILD_NUMBER` env always wins; an unknown string falls back to the derived default.) */
  buildNumber?: string | number;
  /** iOS export-compliance. `ITSAppUsesNonExemptEncryption` — stamped `false` by default (skips the
   * per-upload prompt). Set `true` only if the app uses non-exempt encryption. */
  usesNonExemptEncryption?: boolean;
  /** Extra iOS entitlements merged into the generated `app.entitlements` (on top of the ones active
   * modules + push contribute). For capabilities the module system doesn't (yet) model — e.g.
   * `{ 'com.apple.developer.declared-age-range': true }`. Key = entitlement string, value = boolean /
   * string / string[]. NOTE: the entitlement must also be enabled on the App ID / provisioning profile
   * (some need Apple approval) or a distribution build won't sign. Absent → no change. */
  iosEntitlements?: Record<string, boolean | string | string[]>;
  /** iOS code-signing style for device / `deploy` builds. Default `'auto'` (Xcode automatic signing —
   * requires the team's Apple ID signed into Xcode's GUI to mint profiles). Set `'manual'` to sign
   * device builds with provisioning profiles ALREADY installed on this machine (matched by
   * `<teamId>.<bundleId>`, incl. app-extension targets). This is what lets `appwrap deploy ios`
   * provision app extensions + special-access entitlements (e.g. declared-age-range) headlessly,
   * without an Xcode GUI login. Store/TestFlight builds still go through `appwrap release` (fastlane+match). */
  signing?: 'auto' | 'manual';
  /** Manual-signing profile pins (bundle id → provisioning-profile NAME). Auto-filled when a `'manual'`
   * build finds MULTIPLE candidate profiles for an id and you pick one interactively — so you're not
   * re-prompted. Usually unset: a single matching profile is selected automatically. */
  signingProfiles?: Record<string, string>;
  /** Store-lane block (listing metadata, screenshot dirs, submission answers) consumed by external
   * store tooling. Carried OPAQUE — nothing here reads it; the
   * key is registered only so `unknownConfigKeys` doesn't warn on configs that declare it. */
  store?: Record<string, unknown>;
  /** Pure-native escape hatch: a directory (relative to the PWA project) whose contents are copied
   * OVER the generated wrapper after stamping — for legacy/custom native code the declarative config
   * can't express. Default `'appwrap.overrides'`; applied only if it exists. */
  overrides?: string;
  /** appwrap TS plugins (`@livx.cc/appwrap/plugin`). Each entry is an npm package name or a path to a
   * plugin entrypoint (that `export default definePlugin(...)`); the object form adds a config-level
   * `attachTo` override (which windows it attaches to). On mobile the runtime registers a plugin's
   * `handlers` in-process; a host-provided desktop lane bundles them for its own shell. Manifest/perms
   * merge is stubbed (full module-manifest reuse lands later). */
  plugins?: (string | { name: string; attachTo?: 'main' | 'all' | string; options?: unknown })[];
  /** Opt-in capability allow-list (built-in modules — see capabilities.manifest.ts). When PRESENT,
   * only the listed capabilities (plus always-on core) are advertised, permissioned, and — for
   * modules that own their handler file (e.g. health) — compiled into the shell. Their permissions,
   * background modes and native deps are collected from each module's self-contained manifest entry
   * (the per-app `permissions{}` map only OVERRIDES the default usage copy). When ABSENT, every
   * capability is active and permissions come solely from `permissions{}` (pre-modules behavior). */
  modules?: string[];
  /** `shareTarget` module options (module must be listed in `modules`). Currently just the iOS
   * share-extension direct-sync lane — see {@link ShareDirectSyncConfig}. Absent → mailbox-only
   * behavior, unchanged. */
  shareTarget?: { directSync?: ShareDirectSyncConfig };
  /** Extra module packs layered on top of the built-in capabilities (see packs.ts). Each entry is a
   * local directory OR an npm package name; a pack contributes `ModuleManifest[]` (+ handler files,
   * native source, an optional kit client). Packs apply in order, LAST-WINS by module name, so a pack
   * can add a NEW capability or wholesale-shadow a built-in one (e.g. swap the billing implementation).
   * This is the single public extension seam — the same mechanism a host, consumer apps that vendor
   * their own module, and community plugins all use. Absent → built-ins only (unchanged behavior). */
  modulePacks?: string[];
  /** Permitted headless background-task identifiers (for the `backgroundTask` module). iOS REQUIRES
   * these declared at build time — they stamp into Info.plist `BGTaskSchedulerPermittedIdentifiers`
   * (without them `BGTaskScheduler.register` throws) plus `fetch`+`processing` into UIBackgroundModes.
   * Android self-initializes WorkManager via its androidx startup provider — nothing to stamp. The
   * same ids are what `kit.backgroundTask.register(id, …)` / `.schedule({id})` use. No-op when absent
   * or the module is inactive. */
  backgroundTasks?: string[];
  /** Opt in to the `audio` UIBackgroundMode — ONLY for apps that genuinely keep playing audio while
   * backgrounded/screen-locked (music/streaming/podcast players). Off by default: declaring `audio`
   * without a real background-audio feature is an App Store 2.5.4 rejection. Stamps `audio` into
   * Info.plist UIBackgroundModes when true; no-op/stripped when absent. */
  backgroundAudio?: boolean;
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

/**
 * Top-level keys appwrap recognizes — KEEP IN SYNC with `AppwrapConfig` above (top-level only; nested
 * keys like `push.ios` are not listed). Drives `unknownConfigKeys`, which warns (never fails) on stray
 * keys at load time. The motivating bug: a config written for a NEWER appwrap silently no-ops its
 * unknown keys on an OLDER installed version (e.g. `targetedDevices` before 0.39 → a universal build
 * with no error, then an App Store rejection). A loud warning turns that silent no-op into a signal.
 */
export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'androidAppLinks', 'appBoundDomains', 'backendOrigin', 'backgroundAudio', 'backgroundColor', 'backgroundTasks', 'buildNumber', 'ci', 'debug',
  'debugLog', 'desktop', 'devMenu', 'edgeToEdge', 'entry', 'icon', 'id', 'iosKeyboardExtraLift', 'loader', 'modules', 'modulePacks', 'name',
  'envSwitcher', 'iosEntitlements', 'neutralizeServiceWorker', 'oauthRedirectSchemes', 'openNewWindowsInBrowser', 'orientation', 'overrides', 'permissions',
  'plugins', 'push', 'pwaDist', 'queryPackages', 'queryUrlSchemes', 'serverUrl', 'shareTarget', 'signing', 'signingProfiles', 'statusBarStyle', 'store',
  'splashIcon', 'storekitConfig', 'targetedDevices', 'teamId', 'themeColor', 'trackingDomains', 'urlScheme',
  'usesNonExemptEncryption', 'vendorPaths', 'version',
]);

/** Config keys appwrap doesn't recognize (pure — the caller decides how to surface them). */
export function unknownConfigKeys(cfg: Record<string, unknown>): string[] {
  return Object.keys(cfg).filter((k) => !KNOWN_CONFIG_KEYS.has(k));
}
