/**
 * Capability manifest — the SINGLE, self-contained declaration of every appwrap capability.
 *
 * PURE DATA — no NativeScript globals — so the build-time CLI (bun) imports it to compose the shell,
 * and the runtime imports it to build the handshake capability map. Each entry fully describes one
 * capability's needs (permissions, background modes, native deps); the shell COLLECTS the union
 * across the active set and dedups (two modules needing camera → one perm stamped once).
 *
 * Tiers:
 *  - `core: true`  → always compiled in; cheap, no permissions (haptics, storage, toast, …).
 *  - opt-in (default) → only active when listed in `appwrap.json.modules` (explicit mode). These
 *    carry permissions / native deps / weight, so they're stripped from a build that doesn't ask
 *    for them — no bundled handler advertisement, no permission prompt, no native dependency.
 *
 * Back-compat: when `appwrap.json` has NO `modules` key, the CLI treats EVERY capability as active
 * (today's behavior) and permissions still come solely from `appwrap.json.permissions{}`.
 */

/** A native permission + a default human usage string (Apple requires app-facing copy).
 * `appwrap.json.permissions{<domain>}` overrides the copy per-app; the key here is the iOS Info.plist
 * key. Android perms need no usage string. */
export interface IosPermission {
  /** Info.plist key, e.g. 'NSCameraUsageDescription'. */
  key: string;
  /** Override-key into `appwrap.json.permissions{}` (the legacy domain name). */
  domain: string;
  /** Default usage string if the app doesn't override it. */
  defaultUsage: string;
}

export interface ModuleManifest {
  /** Capability name (also the handshake key + `kit.<name>` where 1:1). */
  name: string;
  /** Always-on, cheap, permission-free. Omitted/false = opt-in (gated by appwrap.json.modules). */
  core?: boolean;
  /** Handshake capability keys this module provides. Value 'native', or per-platform gating. */
  capabilities: Record<string, 'native' | { ios?: boolean; android?: boolean }>;
  /** The registration group this capability belongs to. Core caps share legacy groups (bundled
   * together); opt-in NEW modules name their own group → the CLI imports it only when active, so it
   * tree-shakes out of a build that doesn't use it. */
  group: string;
  ios?: {
    permissions?: IosPermission[];
    /** app.entitlements key/values (e.g. `{ 'com.apple.developer.healthkit': true }`). The CLI merges
     * these (across active modules + push) into one App_Resources/iOS/app.entitlements. Values may be
     * boolean, string, or string[]. */
    entitlements?: Record<string, boolean | string | string[]>;
  };
  android?: {
    /** AndroidManifest <uses-permission> names. */
    permissions?: string[];
    /** app.gradle dependency coordinates, e.g. 'androidx.health.connect:connect-client:1.1.0-rc01'. */
    gradleDeps?: string[];
    /** Module ships Kotlin native source → the CLI enables Kotlin in the NS Android build. */
    kotlin?: boolean;
    /** Raw XML injected inside the AndroidManifest `<application>` (activities, providers,
     * intent-filters a capability needs — e.g. Health Connect's permission-rationale activity). */
    manifestApplication?: string;
    /** Raw XML injected inside the MAIN `<activity>` (intent-filters a capability needs on the
     * launcher activity — e.g. shareTarget's ACTION_SEND filter). */
    manifestActivity?: string;
  };
  /** Module-owned native source: a dir under `runtime/modules-native/<nativeSrc>/` mirroring the
   * App_Resources layout, copied into `native/` ONLY when the module is active (stays strippable).
   * Defaults to the module `name` when the convention dir exists. */
  nativeSrc?: string;
  /** Build-time registration wiring for a module contributed by an OUT-OF-REPO pack (see packs.ts).
   * Built-in modules leave this undefined — their handler barrel wiring comes from cli.ts's
   * OPTIONAL_GROUP_HANDLERS (keyed by `group`). A pack module is self-describing: `file` is the
   * handler module relative to the pack dir, `fn` the exported register function the shell barrel
   * calls at page load. Runtime ignores this field (pure build-time metadata). */
  handler?: { file: string; fn: string };
}

/** Manifest schema version the built-in modules speak. A module pack (packs.ts) declares the version
 * it targets; a mismatch is rejected at resolve time (loud) rather than silently mis-derived. Bump
 * this only on a breaking change to the `ModuleManifest` shape the CLI's derivation depends on. */
export const MANIFEST_SCHEMA_VERSION = 1;

export const MODULES: ModuleManifest[] = [
  // ── core (always on, no permissions) ───────────────────────────────────
  { name: 'haptics', core: true, group: 'core', capabilities: { haptics: 'native' } },
  { name: 'share', core: true, group: 'core', capabilities: { share: 'native', shareFiles: 'native' } },
  { name: 'storage', core: true, group: 'core', capabilities: { storage: 'native', secureStorage: 'native' } },
  // fs: app-sandbox file I/O (documents/data/cache) + system document picker. Core — every root is
  // inside the app sandbox and the picker returns user-chosen security-scoped URIs → zero perms.
  { name: 'fs', core: true, group: 'core', capabilities: { fs: 'native' } },
  { name: 'toast', core: true, group: 'core', capabilities: { toast: 'native', banner: 'native', updates: 'native' } },
  { name: 'statusBar', core: true, group: 'core', capabilities: { statusBar: 'native', themeColor: 'native' } },
  { name: 'device', core: true, group: 'extended', capabilities: { device: 'native' } },
  { name: 'clipboard', core: true, group: 'extended', capabilities: { clipboard: 'native' } },
  { name: 'network', core: true, group: 'extended', capabilities: { network: 'native' } },
  // privacyScreen: hide content in the app-switcher / block screenshots — permission-free, cheap → core.
  { name: 'screen', core: true, group: 'extended', capabilities: { screen: 'native', dialogs: 'native', orientation: 'native', keyboard: 'native', privacyScreen: { ios: true, android: true } } },
  // badge: app-icon badge via the always-bundled notifications.setBadge handler — iOS sets the
  // springboard badge; Android is an honest no-op (launchers own badges) → ios:true / android:false.
  // app.canOpenUrl rides the always-native `app` cap (no new key). shortcuts: home-screen quick
  // actions — iOS UIApplicationShortcutItem / Android dynamic shortcuts (API 25+).
  { name: 'app', core: true, group: 'system', capabilities: { app: 'native', browser: 'native', badge: { ios: true, android: false }, shortcuts: { ios: true, android: true }, pinShortcut: { ios: false, android: true } } },

  // ── opt-in: permission / dependency / weight-bearing ───────────────────
  // POST_NOTIFICATIONS / VIBRATE / USE_BIOMETRIC etc. are in the template's baseline manifest already.
  { name: 'notifications', group: 'extended', capabilities: { notifications: 'native' } },
  {
    name: 'biometrics', group: 'extended',
    capabilities: { biometrics: 'native' },
    ios: { permissions: [{ key: 'NSFaceIDUsageDescription', domain: 'faceid', defaultUsage: 'Authenticate with Face ID.' }] },
  },
  {
    name: 'geo', group: 'extended',
    capabilities: { geo: 'native' },
    ios: { permissions: [{ key: 'NSLocationWhenInUseUsageDescription', domain: 'location', defaultUsage: 'Show your location.' }] },
    android: { permissions: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'] },
  },
  // heading (compass) — handlers live in the always-bundled parity/android groups (registerParity/
  // AndroidHandlers). iOS CLHeading via CLLocationManager: trueHeading needs location auth, so it rides
  // geo's SAME NSLocationWhenInUseUsageDescription (the CLI dedups when geo is also active; declared here
  // for self-containment so a heading-only app still stamps it). Android uses TYPE_ROTATION_VECTOR — a
  // motion sensor that needs NO runtime permission, so no android block (avoid an unused-permission flag).
  {
    name: 'heading', group: 'parity',
    capabilities: { heading: 'native' },
    ios: { permissions: [{ key: 'NSLocationWhenInUseUsageDescription', domain: 'location', defaultUsage: 'Show your compass heading.' }] },
  },
  {
    name: 'photos', group: 'extended',
    capabilities: { photos: 'native' },
    ios: { permissions: [{ key: 'NSPhotoLibraryUsageDescription', domain: 'photos', defaultUsage: 'Pick a photo from your library.' }] },
  },
  {
    name: 'camera', group: 'media',
    capabilities: { camera: 'native' },
    ios: { permissions: [{ key: 'NSCameraUsageDescription', domain: 'camera', defaultUsage: 'Capture a photo.' }] },
    android: { permissions: ['android.permission.CAMERA'] },
  },
  {
    name: 'media', group: 'media',
    capabilities: { media: 'native' },
    ios: { permissions: [
      { key: 'NSCameraUsageDescription', domain: 'camera', defaultUsage: 'Use the camera.' },
      { key: 'NSMicrophoneUsageDescription', domain: 'microphone', defaultUsage: 'Use the microphone.' },
    ] },
    android: { permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'] },
  },
  {
    name: 'motion', group: 'parity',
    capabilities: { motion: 'native' },
    ios: { permissions: [{ key: 'NSMotionUsageDescription', domain: 'motion', defaultUsage: 'Read device motion sensors.' }] },
  },
  {
    name: 'contacts', group: 'parity',
    capabilities: { contacts: 'native' },
    ios: { permissions: [{ key: 'NSContactsUsageDescription', domain: 'contacts', defaultUsage: 'Find which of your contacts already play, and invite the rest.' }] },
    android: { permissions: ['android.permission.READ_CONTACTS'] },
  },
  {
    name: 'calendar', group: 'parity',
    capabilities: { calendar: 'native' },
    ios: { permissions: [
      { key: 'NSCalendarsFullAccessUsageDescription', domain: 'calendar', defaultUsage: 'Add events to your calendar.' },
      { key: 'NSCalendarsUsageDescription', domain: 'calendar', defaultUsage: 'Add events to your calendar.' },
    ] },
    android: { permissions: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'] },
  },
  // ── reviews — in-app store review prompt — opt-in, STRIPPABLE (own handler + group) ──
  // Moved out of the always-bundled parity/system handlers: the Android Play In-App Review path
  // references `com.google.android.play:review` classes — a gradle dep that must NOT land in builds
  // without `reviews` (missing-class crash / dead weight). iOS: SKStoreReviewController (no dep).
  // HONEST LIMIT (Android): the dialog only surfaces for a Play-Store-track install; on a bare
  // emulator / sideload the API resolves WITHOUT showing UI (documented; same class as billing).
  {
    name: 'reviews', group: 'reviews',
    capabilities: { reviews: { ios: true, android: true } },
    android: { gradleDeps: ['com.google.android.play:review:2.0.2'] },
  },

  // ── oauth — system-browser OAuth (iOS ASWebAuthenticationSession / Android Chrome Custom Tabs) ──
  // Opt-in, strippable (own handler file). iOS: ASWebAuthenticationSession (auto-closes on redirect).
  // Android: a Chrome Custom Tab — it does NOT auto-close on the provider redirect, so the callback
  // (`callbackScheme://…`) returns via the app's EXISTING urlScheme deep-link path; the handler hooks
  // that delivery, matches the scheme, and resolves. androidx.browser is already a baseline dep
  // (browser.open); declared here too so the module stays self-contained (CLI dedups). No permission.
  // Lets Google et al. complete sign-in they reject inside an embedded WebView (disallowed_useragent).
  {
    name: 'oauth', group: 'oauth',
    capabilities: { oauth: { ios: true, android: true } },
    android: { gradleDeps: ['androidx.browser:browser:1.8.0'] },
  },

  // ── scanner — camera barcode/QR decode — opt-in (camera permission + decoder weight) ──
  // Reuses the SAME camera permission as media/camera (the CLI dedups across active modules), so a
  // scanner-only app still gets NSCameraUsageDescription / CAMERA without a second permission.
  // iOS: AVCaptureMetadataOutput (no extra dep). Android: ZXing-android-embedded — it ships its own
  // capture Activity, so the handler just launches it via startActivityForResult and reads the
  // result (fewest moving parts vs ML Kit, which needs a hand-built Camera2/CameraX preview).
  {
    name: 'scanner', group: 'scanner',
    capabilities: { scanner: 'native' },
    ios: { permissions: [{ key: 'NSCameraUsageDescription', domain: 'camera', defaultUsage: 'Scan barcodes and QR codes with the camera.' }] },
    android: {
      permissions: ['android.permission.CAMERA'],
      gradleDeps: ['com.journeyapps:zxing-android-embedded:4.3.0'],
    },
  },

  // ── speech (TTS + STT) — opt-in module; ONE coherent kit.speech, TWO honest capabilities ──
  // ONE module (not split TTS-core / STT-opt-in): TTS-only apps are rare and a split fractures
  // `kit.speech` across tiers. The module declares the STT perms (mic + speech-recognition); the
  // CLI only stamps them when `speech` is active, and TTS (`speak`/`voices`) rides along perm-free.
  // It advertises TWO handshake caps so the kit gates each concern honestly:
  //   `speech`            → TTS (synthesis), always native on a shell.
  //   `speechRecognition` → STT (transcription), always native on a shell.
  // iOS: AVSpeechSynthesizer (TTS, no dep) + SFSpeechRecognizer/AVAudioEngine (STT). Android:
  // TextToSpeech + SpeechRecognizer — both plain Java → NO kotlin flag, NO gradle dep.
  {
    name: 'speech', group: 'speech',
    capabilities: { speech: 'native', speechRecognition: 'native' },
    ios: { permissions: [
      { key: 'NSSpeechRecognitionUsageDescription', domain: 'speechRecognition', defaultUsage: 'Transcribe your speech to text.' },
      { key: 'NSMicrophoneUsageDescription', domain: 'microphone', defaultUsage: 'Listen to your voice for speech-to-text.' },
    ] },
    android: { permissions: ['android.permission.RECORD_AUDIO'] },
  },

  // ── tracking — App Tracking Transparency (iOS) — opt-in, STRIPPABLE (own handler + group) ──
  // The native-only store-compliance seam for cross-company tracking (IDFA / cross-app identity):
  // Apple REQUIRES the ATT prompt + NSUserTrackingUsageDescription and forbids tracking before
  // consent. iOS-only (`ios:true`/`android:false`) — Android has NO ATT (the kit reports the cap
  // 'none' there and degrades honestly). Stamping NSUserTrackingUsageDescription is what tells Apple
  // the app tracks, so it's gated behind THIS module being active (no string = Apple assumes none).
  // The CLI also flips the privacy manifest's NSPrivacyTracking → true + fills NSPrivacyTrackingDomains
  // (from config `trackingDomains`) only when this module is active. iOS links
  // AppTrackingTransparency.framework lazily via the runtime FFI (no extra link flag needed for a
  // weak-import system framework referenced through NativeScript's interop). No native deps.
  {
    name: 'tracking', group: 'tracking',
    capabilities: { tracking: { ios: true, android: false } },
    ios: { permissions: [{ key: 'NSUserTrackingUsageDescription', domain: 'tracking', defaultUsage: 'Allow tracking to deliver a more personalized experience and measure ad performance.' }] },
  },

  // ── appleSignIn — native Sign in with Apple (iOS ASAuthorization) — opt-in, STRIPPABLE ──
  // The native account-sheet alternative to the web-OAuth path: ASAuthorizationAppleIDProvider uses the
  // App ID (bundle) and returns the identityToken + nonce DIRECTLY — no Services ID, no https Return URL,
  // no browser redirect (which Apple rejects for custom-scheme redirect_uris). The PWA feeds the result
  // to Firebase signInWithCredential('apple.com', { idToken, rawNonce }). iOS-only (`ios:true`/
  // `android:false`) — Sign in with Apple has NO native Android SDK (the kit reports 'none' there and the
  // app falls back to its web Apple auth). Stamps the `com.apple.developer.applesignin` entitlement ONLY
  // when active (gated, like push's aps-environment) — a non-Apple-SignIn build signs without it. No
  // permission string. Strippable own handler `handlers-apple-signin.ts` (in OPTIONAL_GROUPS).
  {
    name: 'appleSignIn', group: 'appleSignIn',
    capabilities: { appleSignIn: { ios: true, android: false } },
    ios: { entitlements: { 'com.apple.developer.applesignin': ['Default'] } },
  },

  // ── backgroundTask — headless background execution (HEADLESS JS HANDLER) — opt-in, STRIPPABLE ──
  // The OS wakes the app (possibly cold, no visible WebView) for a permitted task id; the shell builds
  // an OFFSCREEN WebView, loads the app conveying the id (the handshake reports it), awaits the JS
  // handler's `backgroundTask.finish`, then completes + reschedules the OS task. iOS: BGTaskScheduler
  // (BGAppRefreshTaskRequest / BGProcessingTaskRequest) — NO gradle dep, but Info.plist MUST declare
  // the permitted identifiers (`appwrap.json.backgroundTasks`, stamped by the CLI) + the fetch/processing
  // background modes. Android: WorkManager periodic work (the work-runtime dep rides via this module),
  // self-initialized by its androidx startup provider — nothing mandatory to stamp.
  // DEVICE-UNVERIFIED: the native background-wake path (offscreen WebView under BGTask / WorkManager)
  // compiles only; it has NOT been run on a device. See handlers-background.ts.
  {
    name: 'backgroundTask', group: 'backgroundTask',
    capabilities: { backgroundTask: { ios: true, android: true } },
    // work-runtime's Worker extends ListenableWorker, whose methods return guava's ListenableFuture;
    // that type must be on the COMPILE classpath or javac fails with "cannot access ListenableFuture".
    // The tiny listenablefuture:1.0 stub does NOT work here: other androidx deps transitively pull
    // listenablefuture:9999.0-empty-to-avoid-conflict-with-guava (an EMPTY jar), which wins the
    // version/capability conflict and evicts the real class. Full guava provides the listenablefuture
    // capability and substitutes that empty stub, so it's the dep that actually resolves the class.
    android: { gradleDeps: ['androidx.work:work-runtime:2.9.1', 'com.google.guava:guava:33.3.1-android'] },
  },

  // ── shareTarget — INBOUND OS share sheet (receive shared text/images) — opt-in, STRIPPABLE ──
  // Android: an ACTION_SEND(_MULTIPLE) intent-filter on the main activity puts the app in the share
  // sheet; the strippable handler reads the SEND intent (cold launch + warm onNewIntent) and
  // re-delivers it through the EXISTING deep-link path as `<urlScheme>://share?text=…` — riding the
  // proven cold-start buffering (handshake `deepLink`) + warm `deeplink.open` event with zero new
  // bridge surface. iOS: a generated share-extension TARGET (`AppwrapShare`, from this module's
  // nativeSrc via NS's App_Resources/iOS/extensions seam — same machinery as the widget pack) that
  // PERSISTS the payload as the same `<urlScheme>://share?…` URL into an App-Group UserDefaults
  // MAILBOX (modern iOS blocks share extensions from launching their host via openURL:, so there is
  // no live hand-off — the extension shows a brief "Added to <App>" confirmation instead); the host
  // drains the mailbox on cold launch + every resume (read-once) into the same deep-link path. Images
  // cross via the App Group container (entitlement below, stamped on both targets) and the host shell
  // relocates them into the app cache so the JS contract is platform-identical. `urlScheme` REQUIRED. Consume via `kit.shareTarget.onReceive` (or
  // raw `kit.lifecycle.onDeepLink`). OPTIONAL direct sync: config `shareTarget.directSync` lets the
  // iOS extension complete the share ITSELF (one templated HTTP call, "Syncing… → Synced" drawer
  // status) using the app-published context KV (`kit.shareTarget.setContext`) — mailbox stays the
  // fallback on any failure. See ShareDirectSyncConfig in appwrap-cli config.ts.
  {
    name: 'shareTarget', group: 'shareTarget', nativeSrc: 'shareTarget',
    capabilities: { shareTarget: 'native' },
    ios: { entitlements: { 'com.apple.security.application-groups': ['__APP_GROUP__'] } },
    // Android UX parity with the iOS drawer: the SEND filters sit on a LIGHTWEIGHT translucent
    // activity (module Kotlin source, cc.appwrap.share.AppwrapShareActivity) — NOT the main
    // activity — so a share never boots the full app/WebView. It performs the same config-driven
    // direct sync (toast status) and only falls back to launching the app (deep-link contract
    // unchanged) when sync isn't possible. taskAffinity="" keeps it out of the app's task;
    // noHistory + excludeFromRecents make it invisible to navigation.
    android: {
      kotlin: true,
      manifestApplication:
        `<activity android:name="cc.appwrap.share.AppwrapShareActivity"\n` +
        `\t\t\tandroid:exported="true"\n` +
        `\t\t\tandroid:excludeFromRecents="true"\n` +
        `\t\t\tandroid:noHistory="true"\n` +
        `\t\t\tandroid:taskAffinity=""\n` +
        `\t\t\tandroid:theme="@android:style/Theme.Translucent.NoTitleBar">\n` +
        `\t\t\t<intent-filter>\n` +
        `\t\t\t\t<action android:name="android.intent.action.SEND" />\n` +
        `\t\t\t\t<category android:name="android.intent.category.DEFAULT" />\n` +
        `\t\t\t\t<data android:mimeType="text/plain" />\n` +
        `\t\t\t\t<data android:mimeType="image/*" />\n` +
        `\t\t\t</intent-filter>\n` +
        `\t\t\t<intent-filter>\n` +
        `\t\t\t\t<action android:name="android.intent.action.SEND_MULTIPLE" />\n` +
        `\t\t\t\t<category android:name="android.intent.category.DEFAULT" />\n` +
        `\t\t\t\t<data android:mimeType="image/*" />\n` +
        `\t\t\t</intent-filter>\n` +
        `\t\t</activity>`,
    },
  },

  // NOTE: billing, health, and widget are not built in — they live in host-provided module packs
  // (a consumer opts in via `modulePacks`).
];

/** Opt-in registration groups that own their own NS handler file (strippable when inactive). Core
 * groups (core/extended/parity/system/media) are always bundled; only these are CLI-gated. */
export const OPTIONAL_GROUPS = ['oauth', 'reviews', 'scanner', 'speech', 'tracking', 'appleSignIn', 'backgroundTask', 'shareTarget'] as const;

/** CLI-gated groups (strippable in explicit mode) that legacy mode (no `modules` key) STILL auto-bundles
 * for back-compat. Empty now that billing (its only member) moved to a host-provided pack — kept as the
 * seam so the carve-out can be reinstated without touching cli.ts if a future built-in needs it. */
export const LEGACY_BUNDLED_GROUPS = [] as const;

/** Resolve the active capability map for the handshake from a set of active capability names. Pack
 * modules (from the config's `modulePacks`) aren't in the static MODULES, so their handshake-relevant
 * subset is passed in via `extraModules` (generated into active-modules.generated.ts) and merged — a
 * pack capability is advertised exactly like a built-in one. Empty for a pack-less build. */
export function buildCapabilityMap(
  activeNames: Set<string>,
  platform: 'ios' | 'android',
  extraModules: ReadonlyArray<Pick<ModuleManifest, 'name' | 'core' | 'capabilities' | 'group'>> = []
): Record<string, 'native' | 'none'> {
  const map: Record<string, 'native' | 'none'> = {};
  for (const m of [...MODULES, ...extraModules]) {
    if (!m.core && !activeNames.has(m.name)) continue;
    for (const [cap, val] of Object.entries(m.capabilities)) {
      if (val === 'native') map[cap] = 'native';
      else map[cap] = val[platform] ? 'native' : 'none';
    }
  }
  return map;
}
