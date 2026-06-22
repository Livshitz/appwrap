/**
 * Pure manifest-derivation + native-stamp transforms — kept side-effect-free (no fs, no config I/O)
 * so they unit-test against fixture strings, same standard as the urlScheme stamper. The CLI wires
 * these into `loadConfig` (derivation) + the iOS/Android stampers (transforms).
 */

/** Normalized appwrap orientation — the three lock states the native shells can express. */
export type Orientation = 'portrait' | 'landscape' | 'any';

/** A single PWA web-manifest icon entry (the subset appwrap reads). */
export interface WebManifestIcon {
  src: string;
  sizes?: string;
  purpose?: string;
}

/** The PWA web-manifest fields appwrap derives from (a subset; everything optional). */
export interface WebManifest {
  name?: string;
  short_name?: string;
  background_color?: string;
  theme_color?: string;
  orientation?: string;
  icons?: WebManifestIcon[];
}

/**
 * "Manifest as source" merge: explicit appwrap-config values WIN, the PWA manifest fills the gaps,
 * the template default lands last (downstream `?? default` in the stampers). Mutates + returns `cfg`
 * — the precedence is `??` (only an `undefined` field is filled), so this is purely additive and
 * never overrides a value the dev wrote. Pure (no fs): the CLI loads the manifest, this merges it.
 */
export function mergeManifest<
  T extends {
    name?: string;
    backgroundColor?: string;
    themeColor?: string;
    orientation?: Orientation;
  }
>(cfg: T, mf: WebManifest | null | undefined): T {
  if (!mf) return cfg;
  cfg.name ??= mf.name || mf.short_name;
  cfg.backgroundColor ??= mf.background_color;
  cfg.themeColor ??= mf.theme_color;
  // normalize the manifest's portrait-primary / landscape-secondary / … to our axis lock.
  if (cfg.orientation === undefined && mf.orientation) cfg.orientation = normalizeOrientation(mf.orientation);
  return cfg;
}

/** Marketing version → a monotonic integer build (0.2.1 → 201; 1.4.12 → 10412). Stable & increasing
 * across semver bumps so store re-uploads are always accepted without a manual bump. */
export function deriveBuild(version: string): number {
  const [maj = 0, min = 0, patch = 0] = version.split('.').map((n) => parseInt(n, 10) || 0);
  return maj * 10000 + min * 100 + patch;
}

/** Named build-number strategies. Live ONCE here so apps opt into a name instead of copying the
 * stamping logic into their config (which drifts across branches). All return a single integer.
 *  - `timestamp`: human-readable YYMMDDHHMM (UTC), e.g. 2026-06-22 14:05 → 2606221405. ≈2.6e9, ≤ the
 *    iOS CFBundleVersion UInt32 cap (4294967295) until ~2042 — but it EXCEEDS Android versionCode's
 *    2.1e9 cap, so this strategy is iOS-ONLY.
 *  - `epoch`: unix seconds (Math.floor(Date.now()/1000)), ≈1.78e9 — Android-safe. */
const BUILD_STRATEGIES: Record<string, (now: Date) => number> = {
  timestamp: (now) => {
    const p = (n: number) => String(n).padStart(2, '0');
    const yy = now.getUTCFullYear() % 100;
    return Number(
      `${p(yy)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
    );
  },
  epoch: (now) => Math.floor(now.getTime() / 1000),
};

/**
 * Resolve the monotonic build number (iOS CFBundleVersion / Android versionCode). Pure: the CLI
 * passes the `APPWRAP_BUILD_NUMBER` env value in (no process.env read here, so it unit-tests).
 * Precedence: env (CI run #) > explicit numeric `buildNumber` > named strategy > derived from version.
 * An unrecognized strategy string falls back to `deriveBuild` (never crashes).
 */
export function resolveBuildNumber(
  cfg: { version: string; buildNumber?: string | number },
  envBuildNumber?: string,
  now: Date = new Date()
): number {
  if (envBuildNumber != null && envBuildNumber !== '') {
    const n = parseInt(envBuildNumber, 10);
    if (!Number.isNaN(n)) return n;
  }
  if (cfg.buildNumber != null) {
    // A numeric value (number or numeric string) is the literal build number.
    const n = parseInt(String(cfg.buildNumber), 10);
    if (!Number.isNaN(n)) return n;
    // Non-numeric → a strategy NAME. Map it, or fall back to deriveBuild for an unknown string.
    const strategy = BUILD_STRATEGIES[String(cfg.buildNumber).trim()];
    if (strategy) return strategy(now);
  }
  return deriveBuild(cfg.version);
}

/**
 * Collapse a PWA web-manifest `orientation` value to our three states. The manifest spec allows
 * `portrait`/`landscape` plus the `-primary`/`-secondary`/`*-up`/`natural` variants — we don't model
 * a single-edge lock at the app level (a PWA wrapper either constrains an axis or leaves it free), so
 * any portrait* → portrait, any landscape* → landscape, everything else (incl. `any`/absent) → any.
 */
export function normalizeOrientation(raw: string | undefined | null): Orientation {
  const v = (raw ?? '').trim().toLowerCase();
  if (v.startsWith('portrait')) return 'portrait';
  if (v.startsWith('landscape')) return 'landscape';
  return 'any'; // 'any' | 'natural' | '' | unknown → don't over-constrain
}

/** iOS `UISupportedInterfaceOrientations` array members for a normalized orientation. */
export function iosOrientations(o: Orientation): string[] {
  if (o === 'portrait') return ['UIInterfaceOrientationPortrait'];
  if (o === 'landscape')
    return ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'];
  // 'any' → free rotation sans upside-down (matches the orientation.ts ALL_BUT_UPSIDE_DOWN mask).
  return [
    'UIInterfaceOrientationPortrait',
    'UIInterfaceOrientationLandscapeLeft',
    'UIInterfaceOrientationLandscapeRight',
  ];
}

/** Android `android:screenOrientation` value for a normalized orientation. */
export function androidScreenOrientation(o: Orientation): string {
  if (o === 'portrait') return 'portrait';
  if (o === 'landscape') return 'landscape';
  return 'unspecified'; // system free rotation
}

/**
 * Rewrite EVERY `UISupportedInterfaceOrientations` (+ the `~ipad` variant the template also sets)
 * array body in an Info.plist string to the given members. Pure string transform — operates on the
 * source it's handed, returns the new source. Keyed by `<key>` name so it touches only those arrays.
 */
export function stampPlistOrientations(src: string, orientations: string[]): string {
  const body = orientations.map((o) => `\t\t<string>${o}</string>`).join('\n');
  return src.replace(
    /(<key>UISupportedInterfaceOrientations(?:~ipad)?<\/key>\s*<array>)[\s\S]*?(<\/array>)/g,
    (_m, open, close) => `${open}\n${body}\n\t${close}`
  );
}

/**
 * Set (or remove) `android:screenOrientation` on the FIRST (main/launcher) `<activity …>` opening tag
 * in an AndroidManifest.xml string. `unspecified` removes the attribute (system default = free).
 * Pure + idempotent: an existing attribute is replaced, otherwise injected after `android:name`.
 */
export function stampAndroidOrientation(src: string, value: string): string {
  return src.replace(/<activity\b[^>]*>/, (tag) => {
    const stripped = tag.replace(/\s*android:screenOrientation="[^"]*"/, '');
    if (value === 'unspecified') return stripped;
    return stripped.replace(/(android:name="[^"]*")/, `$1\n\t\t\tandroid:screenOrientation="${value}"`);
  });
}

/**
 * Rewrite the `<!-- appwrap:queries -->…<!-- /appwrap:queries -->` block in an AndroidManifest string
 * for `kit.app.canOpenUrl()` visibility probes (API 30+). Both child kinds live in ONE `<queries>`:
 *  - each `queryPackages` entry → explicit `<package android:name="…"/>` (Android-only package probe);
 *  - each `queryUrlSchemes` entry → a VIEW `<intent>` on that scheme, so a custom-scheme probe is
 *    symmetric with iOS's `LSApplicationQueriesSchemes` (no hand-mapping scheme→package needed).
 * Pure + idempotent: always rewrites the marker block, so a re-sync never duplicates. No-op (empty
 * block) when both lists are absent.
 */
/**
 * Stamp (or strip) the headless background-task wiring in an Info.plist string for the `backgroundTask`
 * module: `BGTaskSchedulerPermittedIdentifiers` (the permitted ids — iOS requires them declared at
 * build time or `BGTaskScheduler.register` throws) AND the `fetch`+`processing` `UIBackgroundModes`
 * (BGAppRefreshTask needs `fetch`, BGProcessingTask needs `processing`). Pure + idempotent: rewrites an
 * `appwrap:bgtask` marker block (added before `</dict>`), and MERGES the two modes into any existing
 * `UIBackgroundModes` array (a second `<key>` would be invalid plist — same hazard as push's
 * `remote-notification`). `ids` empty/undefined → strips the block + removes the two modes it added.
 */
export function stampPlistBackgroundTasks(src: string, ids: string[] | undefined): string {
  // 1) Always rewrite the marker block (permitted identifiers). Strip first → idempotent.
  src = src.replace(/\s*<!-- appwrap:bgtask -->[\s\S]*?<!-- \/appwrap:bgtask -->/g, '');
  const list = (ids ?? []).filter(Boolean);
  if (list.length) {
    const items = list.map((s) => `    <string>${s}</string>`).join('\n');
    const block =
      `  <!-- appwrap:bgtask -->\n` +
      `  <key>BGTaskSchedulerPermittedIdentifiers</key>\n  <array>\n${items}\n  </array>\n` +
      `  <!-- /appwrap:bgtask -->`;
    src = src.replace(/<\/dict>\s*<\/plist>\s*$/, `${block}\n</dict>\n</plist>\n`);
  }

  // 2) Merge/remove the fetch + processing background modes (separate from the marker — they live in
  //    the shared UIBackgroundModes array, which may also hold audio/remote-notification).
  const modes = ['fetch', 'processing'];
  const bgArray = /(<key>UIBackgroundModes<\/key>\s*<array>)([\s\S]*?)(<\/array>)/;
  if (list.length) {
    const need = modes.filter((m) => !new RegExp(`<string>${m}</string>`).test(src));
    if (need.length) {
      const inject = need.map((m) => `\t<string>${m}</string>`).join('\n');
      src = bgArray.test(src)
        ? src.replace(bgArray, (_m, open, inner, close) => `${open}${inner}${inject}\n\t${close}`)
        : src.replace(
            /<\/dict>\s*<\/plist>\s*$/,
            `  <key>UIBackgroundModes</key>\n  <array>\n${need.map((m) => `    <string>${m}</string>`).join('\n')}\n  </array>\n</dict>\n</plist>\n`
          );
    }
  } else {
    for (const m of modes) src = src.replace(new RegExp(`\\s*<string>${m}</string>`), '');
  }
  return src;
}

export function stampAndroidQueries(src: string, queryPackages?: string[], queryUrlSchemes?: string[]): string {
  const children = [
    ...(queryPackages ?? []).map((p) => `\t\t<package android:name="${p}"/>`),
    ...(queryUrlSchemes ?? []).map(
      (s) => `\t\t<intent><action android:name="android.intent.action.VIEW"/><data android:scheme="${s}"/></intent>`
    ),
  ];
  return src.replace(
    /<!-- appwrap:queries -->[\s\S]*?<!-- \/appwrap:queries -->/,
    children.length
      ? `<!-- appwrap:queries -->\n\t<queries>\n${children.join('\n')}\n\t</queries>\n\t<!-- /appwrap:queries -->`
      : `<!-- appwrap:queries -->\n\t<!-- /appwrap:queries -->`
  );
}
