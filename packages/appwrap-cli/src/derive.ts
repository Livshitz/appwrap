/**
 * Pure manifest-derivation + native-stamp transforms — kept side-effect-free (no fs, no config I/O)
 * so they unit-test against fixture strings, same standard as the urlScheme stamper. The CLI wires
 * these into `loadConfig` (derivation) + the iOS/Android stampers (transforms).
 */

/** Normalized appwrap orientation — the three lock states the native shells can express. */
export type Orientation = 'portrait' | 'landscape' | 'any';

/** The PWA web-manifest fields appwrap derives from (a subset; everything optional). */
export interface WebManifest {
  name?: string;
  short_name?: string;
  background_color?: string;
  theme_color?: string;
  orientation?: string;
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
