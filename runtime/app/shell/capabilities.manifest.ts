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
  };
  /** Module-owned native source: a dir under `runtime/modules-native/<nativeSrc>/` mirroring the
   * App_Resources layout, copied into `native/` ONLY when the module is active (stays strippable).
   * Defaults to the module `name` when the convention dir exists. */
  nativeSrc?: string;
}

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
  { name: 'screen', core: true, group: 'extended', capabilities: { screen: 'native', dialogs: 'native', orientation: 'native', keyboard: 'native' } },
  // badge: app-icon badge via the always-bundled notifications.setBadge handler — iOS sets the
  // springboard badge; Android is an honest no-op (launchers own badges) → ios:true / android:false.
  { name: 'app', core: true, group: 'system', capabilities: { app: 'native', browser: 'native', badge: { ios: true, android: false } } },

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
  {
    name: 'reviews', group: 'system',
    capabilities: { reviews: { ios: true, android: false } },
  },
  {
    name: 'billing', group: 'billing',
    capabilities: { billing: { ios: true, android: false } },
  },

  // ── oauth — system-browser OAuth (iOS ASWebAuthenticationSession) ──
  // Opt-in, strippable (own handler file). No permissions/entitlements — ASWebAuthenticationSession
  // needs none; it only relies on the app's urlScheme so the provider redirect returns to the app.
  // Lets Google et al. complete sign-in they reject inside an embedded WebView (disallowed_useragent).
  // Android (Custom Tabs + intent callback) is a future addition.
  {
    name: 'oauth', group: 'oauth',
    capabilities: { oauth: { ios: true, android: false } },
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

  // ── health (steps) — opt-in heavy module; FG live + BG via OS step store ──
  {
    name: 'health', group: 'health',
    capabilities: { health: 'native' },
    // iOS reads HealthKit (the Health app's aggregated total incl. Apple Watch): health-share usage
    // string + the healthkit entitlement, both module-owned. No background execution — HealthKit
    // already has the steps the OS recorded while the app was killed.
    ios: {
      // App Store validation REQUIRES both Share AND Update purpose strings whenever the HealthKit
      // entitlement is present — even for a read-only app (else upload fails 409 "Missing purpose
      // string … NSHealthUpdateUsageDescription"). Device debug builds don't validate this; only the
      // App Store upload does.
      permissions: [
        { key: 'NSHealthShareUsageDescription', domain: 'health', defaultUsage: 'Read your step count from the Health app.' },
        { key: 'NSHealthUpdateUsageDescription', domain: 'health', defaultUsage: 'Read your step count from the Health app.' },
        // Live step stream (health.liveSteps) uses CMPedometer (CoreMotion) → iOS terminates the app
        // on access without this Motion & Fitness usage string. Required for the real-time count.
        { key: 'NSMotionUsageDescription', domain: 'motion', defaultUsage: 'Count your steps live as you walk.' },
      ],
      entitlements: { 'com.apple.developer.healthkit': true },
    },
    // Android primary = Health Connect (system store, Wear-inclusive, survives kill — matches iOS).
    // Its client is Kotlin-coroutine-only, so the module ships HealthConnectBridge.kt (nativeSrc) and
    // flags kotlin:true. Falls back to SensorManager TYPE_STEP_COUNTER (ACTIVITY_RECOGNITION) when HC absent.
    android: {
      permissions: ['android.permission.health.READ_STEPS', 'android.permission.ACTIVITY_RECOGNITION'],
      gradleDeps: [
        'androidx.health.connect:connect-client:1.1.0-rc01',
        'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0',
      ],
      kotlin: true,
      // Health Connect refuses to honor permissions unless the app declares a rationale activity
      // handling VIEW_PERMISSION_USAGE / HEALTH_PERMISSIONS (alias onto the NS main activity).
      manifestApplication: `<activity-alias
      android:name="ViewPermissionUsageActivity"
      android:exported="true"
      android:targetActivity="com.tns.NativeScriptActivity"
      android:permission="android.permission.START_VIEW_PERMISSION_USAGE">
      <intent-filter>
        <action android:name="android.intent.action.VIEW_PERMISSION_USAGE" />
        <category android:name="android.intent.category.HEALTH_PERMISSIONS" />
      </intent-filter>
    </activity-alias>`,
    },
    nativeSrc: 'health',
  },
];

/** Opt-in registration groups that own their own NS handler file (strippable when inactive). Core
 * groups (core/extended/parity/system/media/billing) are always bundled; only these are CLI-gated. */
export const OPTIONAL_GROUPS = ['health', 'oauth', 'scanner'] as const;

/** Resolve the active capability map for the handshake from a set of active capability names. */
export function buildCapabilityMap(
  activeNames: Set<string>,
  platform: 'ios' | 'android'
): Record<string, 'native' | 'none'> {
  const map: Record<string, 'native' | 'none'> = {};
  for (const m of MODULES) {
    if (!m.core && !activeNames.has(m.name)) continue;
    for (const [cap, val] of Object.entries(m.capabilities)) {
      if (val === 'native') map[cap] = 'native';
      else map[cap] = val[platform] ? 'native' : 'none';
    }
  }
  return map;
}
