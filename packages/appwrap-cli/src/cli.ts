#!/usr/bin/env bun
/**
 * appwrap CLI v0 — scaffold a native wrapper around a built PWA.
 *
 *   appwrap init [--config <path>] [--out native]   # from the PWA project dir
 *   appwrap sync [--config <path>] [--out native]   # re-copy PWA dist into the wrapper
 *
 * Config (TS preferred, JSON fallback) — probed in order: appwrap.config.ts → .js → appwrap.json.
 * Shape: { id, name, version, entry?, backgroundColor?, statusBarStyle?, pwaDist }. See config.ts.
 */
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'fs';
import { networkInterfaces, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';
// PURE-DATA capability manifest (no NativeScript globals) — type-only import (erased at runtime);
// the VALUES are loaded dynamically below from the resolved runtime so the CLI works both in the
// monorepo and from a published tarball (where runtime/ is bundled at the package root).
import type * as CapManifest from '../../../runtime/app/shell/capabilities.manifest';
// Config shape lives in its own import-safe module so a `appwrap.config.ts` file can import the
// type + `defineConfig` helper without pulling in (and running) the CLI dispatch.
import type { AppwrapConfig } from './config';
import {
  androidScreenOrientation,
  iosOrientations,
  mergeManifest,
  resolveBuildNumber,
  stampAndroidOrientation,
  stampAndroidQueries,
  stampPlistBackgroundTasks,
  stampPlistOrientations,
} from './derive';
import type { WebManifest } from './derive';

/** What `child_process.execFileSync` attaches to the Error it throws on a non-zero exit
 * (stdout/stderr are Buffer with the default encoding, string when `encoding` is set). */
interface ExecError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  status?: number | null;
}
const asExecError = (e: unknown): ExecError => (e ?? {}) as ExecError;
/** Combined stdout+stderr captured on an exec failure (empty string when none). */
const execErrText = (e: unknown): string => {
  const err = asExecError(e);
  return `${err.stdout ?? ''}${err.stderr ?? ''}`;
};

/**
 * Resolved monotonic build number (iOS CFBundleVersion / Android versionCode). Thin env wrapper over
 * the pure `resolveBuildNumber` (in derive.ts, where it unit-tests). Precedence: `APPWRAP_BUILD_NUMBER`
 * env (CI run #) > explicit numeric `cfg.buildNumber` > named strategy ('timestamp'|'epoch') > derived
 * from version. The env override gives CI a monotonic, collision-free build for free; the derived
 * default is CONSTANT per version, so repeat uploads of one marketing version would 409 without it.
 */
function buildNumberOf(cfg: AppwrapConfig): number {
  return resolveBuildNumber(cfg, process.env.APPWRAP_BUILD_NUMBER);
}

const IOS_PERMISSION_KEYS: Record<string, string[]> = {
  location: ['NSLocationWhenInUseUsageDescription'],
  photos: ['NSPhotoLibraryUsageDescription'],
  camera: ['NSCameraUsageDescription'],
  microphone: ['NSMicrophoneUsageDescription'],
  faceid: ['NSFaceIDUsageDescription'],
  // iOS 17 key + pre-17 fallback key, same usage string
  calendar: ['NSCalendarsFullAccessUsageDescription', 'NSCalendarsUsageDescription'],
};

/** Runtime permissions stamped into AndroidManifest.xml per declared domain.
 * photos/faceid need none: system picker / USE_BIOMETRIC is baseline. */
const ANDROID_PERMISSION_KEYS: Record<string, string[]> = {
  location: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  camera: ['android.permission.CAMERA'],
  microphone: ['android.permission.RECORD_AUDIO'],
  calendar: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
  contacts: ['android.permission.READ_CONTACTS'],
};

/** Resolve a bundled asset dir. A published tarball ships runtime/ + templates/ at the package root
 * (one level above src/); the monorepo resolves them at the repo root (three levels up). */
function resolveAssetRoot(rel: string): string {
  const local = resolve(import.meta.dir, '..', rel);
  return existsSync(local) ? local : resolve(import.meta.dir, '../../..', rel);
}
const TEMPLATE_DIR = resolveAssetRoot('runtime');
const CI_TEMPLATE_DIR = resolveAssetRoot('templates/ci');

// Load the capability manifest VALUES from the resolved runtime (pure data — safe outside NativeScript).
// Top-level await resolves before any command dispatches at the bottom of this file.
const { MODULES, OPTIONAL_GROUPS } = (await import(
  resolve(TEMPLATE_DIR, 'app/shell/capabilities.manifest')
)) as typeof CapManifest;

/** Native requirements composed for a build: the union (deduped) of the active modules' self-contained
 * manifest declarations. Two modes:
 *  - `modules` ABSENT (legacy): every capability active; permissions come ONLY from `permissions{}`
 *    (the iOS/Android key maps above) — unchanged pre-modules behavior.
 *  - `modules` PRESENT (explicit): core + listed; perms/bg-modes/deps derived from manifests, with
 *    `permissions{}` overriding the default usage copy. Capabilities not listed are stripped.
 */
interface NativeReqs {
  explicit: boolean;
  activeOptIn: string[];           // opt-in capability names that are active (for the handshake map)
  activeOptionalGroups: string[];  // strippable handler groups (own file) that are active
  iosPlist: Array<{ key: string; usage: string }>;
  iosEntitlements: Record<string, boolean | string | string[]>;
  androidPerms: string[];
  androidGradleDeps: string[];
  androidKotlin: boolean;        // any active module ships Kotlin native source
  androidManifestApp: string[];  // raw XML injected inside AndroidManifest <application>
  nativeSrc: string[];           // active modules' nativeSrc dir names (under runtime/modules-native/)
}

function nativeReqs(cfg: AppwrapConfig): NativeReqs {
  const optIn = MODULES.filter((m) => !m.core);
  // Legacy default (no `modules` key) = every opt-in capability EXCEPT strictly-opt-in own-file
  // modules (OPTIONAL_GROUPS, e.g. health): those carry deps/perms legacy won't stamp, so they must
  // be explicitly requested. Explicit mode = exactly what `modules` lists.
  const active = cfg.modules
    ? new Set(cfg.modules)
    : new Set(optIn.filter((m) => !OPTIONAL_GROUPS.includes(m.group as (typeof OPTIONAL_GROUPS)[number])).map((m) => m.name));
  const activeMods = MODULES.filter((m) => m.core || active.has(m.name));

  const iosPlist: Array<{ key: string; usage: string }> = [];
  const seenKeys = new Set<string>();
  const androidPerms = new Set<string>();
  const gradle = new Set<string>();
  const iosEntitlements: Record<string, boolean | string | string[]> = {};
  const nativeSrc: string[] = [];
  const androidManifestApp: string[] = [];
  let androidKotlin = false;

  if (cfg.modules) {
    // explicit: self-contained module declarations win
    for (const m of activeMods) {
      for (const p of m.ios?.permissions ?? []) {
        if (seenKeys.has(p.key)) continue;
        seenKeys.add(p.key);
        iosPlist.push({ key: p.key, usage: cfg.permissions?.[p.domain as keyof typeof cfg.permissions] ?? p.defaultUsage });
      }
      for (const ap of m.android?.permissions ?? []) androidPerms.add(ap);
      for (const g of m.android?.gradleDeps ?? []) gradle.add(g);
      Object.assign(iosEntitlements, m.ios?.entitlements ?? {});
      if (m.android?.kotlin) androidKotlin = true;
      if (m.android?.manifestApplication) androidManifestApp.push(m.android.manifestApplication);
      if (m.nativeSrc) nativeSrc.push(m.nativeSrc);
    }
  } else {
    // legacy: only what `permissions{}` declares (via the key maps) — no behavior change
    for (const [domain, text] of Object.entries(cfg.permissions ?? {})) {
      for (const key of IOS_PERMISSION_KEYS[domain] ?? []) {
        if (text && !seenKeys.has(key)) { seenKeys.add(key); iosPlist.push({ key, usage: text }); }
      }
      for (const p of ANDROID_PERMISSION_KEYS[domain] ?? []) androidPerms.add(p);
    }
  }

  return {
    explicit: !!cfg.modules,
    activeOptIn: optIn.filter((m) => active.has(m.name)).map((m) => m.name),
    activeOptionalGroups: OPTIONAL_GROUPS.filter((g) => activeMods.some((m) => m.group === g)),
    iosPlist,
    iosEntitlements,
    androidPerms: [...androidPerms],
    androidGradleDeps: [...gradle],
    androidKotlin,
    androidManifestApp,
    nativeSrc,
  };
}

/** Map a strippable optional group → its handler file + register fn (for the generated barrel). */
const OPTIONAL_GROUP_HANDLERS: Record<string, { file: string; fn: string }> = {
  health: { file: './handlers-health', fn: 'registerHealthHandlers' },
  oauth: { file: './handlers-oauth', fn: 'registerOAuthHandlers' },
  reviews: { file: './handlers-reviews', fn: 'registerReviewsHandlers' },
  scanner: { file: './handlers-scanner', fn: 'registerScannerHandlers' },
  speech: { file: './handlers-speech', fn: 'registerSpeechHandlers' },
  backgroundTask: { file: './handlers-background', fn: 'registerBackgroundTaskHandlers' },
};

/** Generate the two composition artifacts in the wrapper: the active capability list (drives the
 * handshake map) and the optional-handler barrel (imports only active strippable groups). */
function generateModuleArtifacts(outDir: string, req: NativeReqs): void {
  const shell = join(outDir, 'app/shell');
  writeFileSync(
    join(shell, 'active-modules.generated.ts'),
    `/** Generated by \`appwrap\` from the appwrap config \`modules\`. Do not edit. */\n` +
      `export const ACTIVE_MODULE_NAMES: string[] = ${JSON.stringify(req.activeOptIn)};\n`
  );

  const groups = req.activeOptionalGroups.filter((g) => OPTIONAL_GROUP_HANDLERS[g]);
  const imports = groups.map((g) => `import { ${OPTIONAL_GROUP_HANDLERS[g].fn} } from '${OPTIONAL_GROUP_HANDLERS[g].file}';`).join('\n');
  const calls = groups.map((g) => `  ${OPTIONAL_GROUP_HANDLERS[g].fn}();`).join('\n');
  writeFileSync(
    join(shell, 'optional-handlers.generated.ts'),
    `/** Generated by \`appwrap\` — only the active strippable modules are imported. Do not edit. */\n` +
      `${imports}${imports ? '\n' : ''}\nexport function registerOptionalHandlers(): void {\n${calls}\n}\n`
  );

  // iOS BGTaskScheduler launch handlers must register at didFinishLaunching (the AppDelegate calls
  // registerBackgroundLaunchHandlers) — too early for the page-load barrel. Wire the real impl ONLY
  // when backgroundTask is active, so a build without it never references BGTaskScheduler. No-op default.
  const bgActive = req.activeOptionalGroups.includes('backgroundTask');
  writeFileSync(
    join(shell, 'background-bootstrap.generated.ts'),
    `/** Generated by \`appwrap\` — wires the iOS BGTask launch handlers only when backgroundTask is active. Do not edit. */\n` +
      (bgActive
        ? `export { registerBackgroundTaskLaunchHandlers as registerBackgroundLaunchHandlers } from './handlers-background';\n`
        : `export function registerBackgroundLaunchHandlers(): void {}\n`)
  );
}

/** Stamp the active modules' gradle dependencies into Android app.gradle. Idempotent marker block. */
function stampAndroidGradleDeps(outDir: string, deps: string[]): void {
  const appGradle = join(outDir, 'App_Resources/Android/app.gradle');
  if (!existsSync(appGradle)) return;
  const strip = (s: string) => s.replace(/\n*\/\/ appwrap-modules:begin[\s\S]*?\/\/ appwrap-modules:end\n*/g, '\n');
  let s = strip(readFileSync(appGradle, 'utf8')).trimEnd() + '\n';
  if (deps.length) {
    const lines = deps.map((d) => `  implementation "${d}"`).join('\n');
    s += `\n// appwrap-modules:begin (native deps from active modules)\ndependencies {\n${lines}\n}\n// appwrap-modules:end\n`;
  }
  writeFileSync(appGradle, s);
}

/** Module-owned native source lives here (mirroring App_Resources); copied into native/ when active. */
const MODULES_NATIVE_DIR = resolve(TEMPLATE_DIR, 'modules-native');
const MODULE_KOTLIN_VERSION = '2.1.0';

/** Merge iOS entitlements from active modules + remote push into ONE app.entitlements (NS auto-detects
 * + signs it). Removes the file when empty so a no-entitlement build (personal team, push off) signs. */
function stampEntitlements(outDir: string, cfg: AppwrapConfig, req: NativeReqs): void {
  const iosDir = join(outDir, 'App_Resources/iOS');
  if (!existsSync(iosDir)) return;
  const file = join(iosDir, 'app.entitlements');
  const ent: Record<string, boolean | string | string[]> = { ...req.iosEntitlements };
  if (!!cfg.push?.enabled && cfg.push?.ios !== false) ent['aps-environment'] = cfg.push.apsEnvironment ?? 'development';
  const keys = Object.keys(ent);
  if (keys.length === 0) { rmSync(file, { force: true }); return; }
  const val = (v: boolean | string | string[]): string =>
    typeof v === 'boolean' ? `<${v}/>`
    : Array.isArray(v) ? `<array>\n${v.map((s) => `    <string>${s}</string>`).join('\n')}\n  </array>`
    : `<string>${v}</string>`;
  const body = keys.map((k) => `  <key>${k}</key>\n  ${val(ent[k])}`).join('\n');
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
  );
  console.log(`  entl ← ${keys.join(', ')}`);
}

/** Copy active modules' native source (runtime/modules-native/<name>/) into native/ — only when the
 * module is active, so module native code stays stripped from builds that don't use it. */
function copyModuleNativeSrc(outDir: string, req: NativeReqs): void {
  for (const name of req.nativeSrc) {
    const src = join(MODULES_NATIVE_DIR, name);
    if (!existsSync(src)) { console.warn(`⚠ module nativeSrc not found: ${src}`); continue; }
    cpSync(src, outDir, { recursive: true, force: true });
    console.log(`  natv ← module '${name}' native source`);
  }
}

/** Enable Kotlin in the NS Android build when an active module ships Kotlin native source. Injects
 * useKotlin/kotlinVersion into before-plugins.gradle's project.ext (re-stamped from template each run). */
function stampKotlin(outDir: string, enable: boolean): void {
  const file = join(outDir, 'App_Resources/Android/before-plugins.gradle');
  if (!enable || !existsSync(file)) return;
  let src = readFileSync(file, 'utf8');
  if (!/^\s*useKotlin\s*=/m.test(src)) {
    src = src.replace(/(project\.ext\s*\{)/, `$1\n  useKotlin = true\n  kotlinVersion = "${MODULE_KOTLIN_VERSION}"`);
  }
  writeFileSync(file, src);
  console.log(`  ktln ← Kotlin enabled (${MODULE_KOTLIN_VERSION})`);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t?.startsWith('-')) {
      const key = t.replace(/^-+/, ''); // accept both --long and -short (e.g. -r)
      const next = rest[i + 1];
      // value flag (`--out native`) vs boolean flag (`--aab`, `-r`) → presence as ''
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = '';
      }
    } else if (t !== undefined) {
      positionals.push(t);
    }
  }
  return { command, flags, positionals };
}

/** Parse the PWA's web manifest (manifest.json / .webmanifest) from the dist dir, or null. */
function loadManifest(cwd: string, cfg: AppwrapConfig): WebManifest | null {
  const dist = resolve(cwd, cfg.pwaDist);
  for (const name of ['manifest.json', 'manifest.webmanifest']) {
    const mf = join(dist, name);
    if (!existsSync(mf)) continue;
    try {
      return JSON.parse(readFileSync(mf, 'utf8'));
    } catch (e: unknown) {
      console.warn(`⚠ Could not parse ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return null;
}

/** Config filenames probed (in order) when `--config` is not passed. TS is preferred (typed,
 * autocomplete via `defineConfig`); `.js` then `.json` are supported as fallbacks. */
const CONFIG_CANDIDATES = ['appwrap.config.ts', 'appwrap.config.js', 'appwrap.json'] as const;

/** Load a `.ts`/`.js`/`.json` config. TS/JS are imported (Bun runs them natively — no transpile
 * step) and may `export default` (or a named `config`); JSON is parsed. Returns the raw object. */
async function readConfigFile(configPath: string): Promise<AppwrapConfig> {
  if (configPath.endsWith('.json')) {
    return JSON.parse(readFileSync(configPath, 'utf8')) as AppwrapConfig;
  }
  // .ts / .js — dynamic import (Bun runs it natively). Each CLI command is its own process, so the
  // ESM module cache never outlives a single run.
  const mod = await import(pathToFileURL(configPath).href);
  const cfg = mod.default ?? mod.config;
  if (!cfg || typeof cfg !== 'object') {
    console.error(`✖ ${configPath} must \`export default\` (or export \`config\`) an appwrap config object.`);
    process.exit(1);
  }
  return cfg as AppwrapConfig;
}

/** Resolve the user's appwrap config file path the CLI loads from: explicit --config wins;
 * otherwise probe ts → js → json (TS preferred). Single source of discovery (reused by the
 * team-id pin-to-config writer so it never re-invents the probe). */
function resolveConfigPath(cwd: string, flags: Record<string, string>): string {
  return flags.config
    ? resolve(cwd, flags.config)
    : (CONFIG_CANDIDATES.map((f) => resolve(cwd, f)).find(existsSync) ?? resolve(cwd, CONFIG_CANDIDATES[0]));
}

async function loadConfig(cwd: string, flags: Record<string, string>): Promise<AppwrapConfig> {
  const configPath = resolveConfigPath(cwd, flags);
  if (!existsSync(configPath)) {
    console.error(`✖ Config not found — looked for ${CONFIG_CANDIDATES.join(' / ')} in ${cwd}`);
    process.exit(1);
  }
  const cfg = await readConfigFile(configPath);

  // Manifest as source: the appwrap config wins, the PWA manifest fills the gaps, template default last.
  // (DRY single-source — devs don't re-type identity already declared in the manifest.) See mergeManifest.
  if (cfg.pwaDist) mergeManifest(cfg, loadManifest(cwd, cfg));

  for (const key of ['id', 'name', 'version', 'pwaDist'] as const) {
    if (!cfg[key]) {
      console.error(`✖ config missing required field: ${key}` + (key === 'name' ? ' (and no name/short_name in the PWA manifest)' : ''));
      process.exit(1);
    }
  }
  return cfg;
}

function stampShellConfig(outDir: string, cfg: AppwrapConfig): void {
  const content = `/**
 * Shell config — stamped by \`appwrap init\`/\`sync\` from the appwrap config. Do not edit.
 */
export const SHELL_CONFIG = {
  appId: ${JSON.stringify(cfg.id)},
  name: ${JSON.stringify(cfg.name)},
  version: ${JSON.stringify(cfg.version)},
  entry: ${JSON.stringify(cfg.entry ?? 'index.html')},
  backgroundColor: ${JSON.stringify(cfg.backgroundColor ?? '#ffffff')},
  themeColor: ${JSON.stringify(cfg.themeColor ?? '')},
  statusBarStyle: ${JSON.stringify(cfg.statusBarStyle ?? 'dark')} as 'light' | 'dark',
  orientation: ${JSON.stringify(cfg.orientation ?? '')} as '' | 'portrait' | 'landscape' | 'any',
  edgeToEdge: ${JSON.stringify(cfg.edgeToEdge ?? false)},
  loader: ${JSON.stringify(cfg.loader ?? 'app')} as 'app' | 'file' | 'server',
  serverUrl: ${JSON.stringify(cfg.serverUrl ?? '')},
  backendOrigin: ${JSON.stringify(cfg.backendOrigin ?? '')},
  debug: ${JSON.stringify(cfg.debug ?? false)},
  debugLog: ${JSON.stringify(cfg.debugLog ?? '*')},
  devMenu: ${JSON.stringify(cfg.devMenu ?? true)},
  neutralizeServiceWorker: ${JSON.stringify(cfg.neutralizeServiceWorker ?? true)},
  openNewWindowsInBrowser: ${JSON.stringify(cfg.openNewWindowsInBrowser ?? false)},
  pushIos: ${JSON.stringify(!!cfg.push?.enabled && cfg.push?.ios !== false)},
  pushAndroid: ${JSON.stringify(!!cfg.push?.enabled && cfg.push?.android !== false)},
  pushRegistrationUrl: ${JSON.stringify(cfg.push?.registrationUrl ?? '')},
};
`;
  writeFileSync(join(outDir, 'app/shell/config.ts'), content);
}

function stampNativeScriptConfig(outDir: string, cfg: AppwrapConfig): void {
  const file = join(outDir, 'nativescript.config.ts');
  const src = readFileSync(file, 'utf8').replace(/id: '[^']*'/, `id: '${cfg.id}'`);
  writeFileSync(file, src);
}

function stampIOSDisplayName(outDir: string, cfg: AppwrapConfig, req: NativeReqs): void {
  const plist = join(outDir, 'App_Resources/iOS/Info.plist');
  if (!existsSync(plist)) return;
  let src = readFileSync(plist, 'utf8');
  const stamp = (key: string, value: string) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    src = re.test(src) ? src.replace(re, `$1${value}$2`) : src;
  };
  stamp('CFBundleDisplayName', cfg.name);
  stamp('CFBundleName', cfg.name);
  stamp('CFBundleShortVersionString', cfg.version); // marketing version (user-facing)
  stamp('CFBundleVersion', String(buildNumberOf(cfg))); // monotonic build — store re-uploads need it higher

  // Supported orientation (config > manifest) — rewrites both UISupportedInterfaceOrientations
  // arrays (iPhone + ~ipad). Skipped when unset → keep the template's free-rotation default.
  if (cfg.orientation) src = stampPlistOrientations(src, iosOrientations(cfg.orientation));

  // Headless background tasks (backgroundTask module): stamp BGTaskSchedulerPermittedIdentifiers +
  // fetch/processing background modes from `backgroundTasks`. Idempotent both ways — passing []/undefined
  // strips the block — so it no-ops (and cleans up) when the module is inactive or the field is absent.
  const bgActive = req.activeOptionalGroups.includes('backgroundTask');
  src = stampPlistBackgroundTasks(src, bgActive ? cfg.backgroundTasks : undefined);

  // Permission usage strings + URL scheme + export-compliance — idempotent: strip stamped block, re-add
  src = src.replace(/\s*<!-- appwrap:begin -->[\s\S]*?<!-- appwrap:end -->/g, '');
  const extras: string[] = [];
  // Export compliance: skips the per-upload encryption prompt. Default false; override in config.
  extras.push(`  <key>ITSAppUsesNonExemptEncryption</key>\n  <${cfg.usesNonExemptEncryption ? 'true' : 'false'}/>`);
  // Permissions: composed (deduped) from the active modules — legacy mode falls back to permissions{}.
  for (const { key, usage } of req.iosPlist) {
    extras.push(`  <key>${key}</key>\n  <string>${usage}</string>`);
  }
  if (cfg.urlScheme) {
    extras.push(
      `  <key>CFBundleURLTypes</key>\n  <array>\n    <dict>\n      <key>CFBundleTypeRole</key>\n      <string>Editor</string>\n      <key>CFBundleURLName</key>\n      <string>${cfg.id}</string>\n      <key>CFBundleURLSchemes</key>\n      <array>\n        <string>${cfg.urlScheme}</string>\n      </array>\n    </dict>\n  </array>`
    );
  }
  // Schemes kit.app.canOpenUrl() may probe → LSApplicationQueriesSchemes (iOS 9+ requires declaration
  // for custom schemes). No-op when absent.
  if (cfg.queryUrlSchemes?.length) {
    const items = cfg.queryUrlSchemes.map((s) => `    <string>${s}</string>`).join('\n');
    extras.push(`  <key>LSApplicationQueriesSchemes</key>\n  <array>\n${items}\n  </array>`);
  }
  if (extras.length) {
    src = src.replace(
      /<\/dict>\s*<\/plist>\s*$/,
      `  <!-- appwrap:begin -->\n${extras.join('\n')}\n  <!-- appwrap:end -->\n</dict>\n</plist>\n`
    );
  }

  // Remote push needs the `remote-notification` background mode. The template already ships a
  // UIBackgroundModes array (for `audio`), so MERGE in-place — a second <key> would be a duplicate
  // (invalid plist). Idempotent both ways: add when enabled+missing, strip when disabled.
  const iosPush = !!cfg.push?.enabled && cfg.push?.ios !== false;
  const bgArray = /(<key>UIBackgroundModes<\/key>\s*<array>)([\s\S]*?)(<\/array>)/;
  const hasRN = /<string>remote-notification<\/string>/.test(src);
  if (iosPush && !hasRN) {
    src = bgArray.test(src)
      ? src.replace(bgArray, (_m, open, inner, close) => `${open}${inner}\t<string>remote-notification</string>\n\t${close}`)
      : src.replace(/<\/dict>\s*<\/plist>\s*$/, `  <key>UIBackgroundModes</key>\n  <array>\n    <string>remote-notification</string>\n  </array>\n</dict>\n</plist>\n`);
  } else if (!iosPush && hasRN) {
    src = src.replace(/\s*<string>remote-notification<\/string>/, '');
  }

  writeFileSync(plist, src);
}

function stampTeamId(outDir: string, cfg: AppwrapConfig, ctx?: { cwd: string; configPath: string }): void {
  const xcconfig = join(outDir, 'App_Resources/iOS/build.xcconfig');
  // Resolution order: a real (non-placeholder) cfg.teamId wins; else $APPWRAP_TEAM_ID (headless/CI);
  // else the enriched interactive picker (which then offers to pin its choice to the config). This
  // intercepts BEFORE `ns build` runs so NS never shows its plain, unenriched prompt.
  const isPlaceholder = !cfg.teamId || /YOUR_APPLE_TEAM_ID|^$/.test(cfg.teamId);
  if (isPlaceholder) {
    const envTeam = process.env.APPWRAP_TEAM_ID?.trim();
    if (envTeam) {
      cfg.teamId = envTeam;
      console.log(`  team ← ${envTeam} (from $APPWRAP_TEAM_ID)`);
    } else if (!process.stdout.isTTY) {
      console.warn(`⚠ teamId is unset — set it in appwrap.config, set $APPWRAP_TEAM_ID, or run interactively to pick from your teams.`);
      return;
    } else {
      const picked = pickTeamIdInteractively();
      cfg.teamId = picked.teamId;
      // Offer to persist the choice so the user isn't re-prompted on every deploy. No-TTY/headless is
      // already handled above; promptYesNo additionally guards against a non-interactive stdin.
      if (ctx && promptYesNo(`  Pin "${picked.name} (${picked.teamId})" to appwrap.config so you're not asked again?`, true)) {
        pinTeamIdToConfig(ctx.configPath, picked.teamId);
      } else {
        console.log(`  ⓘ  To skip this prompt: set teamId: "${picked.teamId}" in appwrap.config (or set $APPWRAP_TEAM_ID).`);
      }
    }
  }
  if (!existsSync(xcconfig)) return;
  let src = readFileSync(xcconfig, 'utf8');
  src = /DEVELOPMENT_TEAM\s*=/.test(src)
    ? src.replace(/DEVELOPMENT_TEAM\s*=\s*[^;\n]*;?/, `DEVELOPMENT_TEAM = ${cfg.teamId};`)
    : src + `\nDEVELOPMENT_TEAM = ${cfg.teamId};\n`;
  writeFileSync(xcconfig, src);
}

/** Wire a StoreKit config file for LOCAL iOS IAP testing (no App Store Connect needed).
 * NativeScript copies App_Resources/iOS/* into the generated project and adds it as a file
 * reference — but it never points the scheme at it, so StoreKit has no catalog. We (1) drop the
 * .storekit into App_Resources/iOS so it's bundled + referenced, and (2) install an after-prepare
 * hook that injects `<StoreKitConfigurationFileReference>` into the scheme's LaunchAction (the
 * scheme is regenerated on every `ns prepare`, so a one-time edit won't stick). Only takes effect
 * when launched from Xcode (sim or device-from-Xcode), not a standalone devicectl sideload. */
function stampStoreKit(cwd: string, outDir: string, cfg: AppwrapConfig): void {
  if (!cfg.storekitConfig) return;
  const source = resolve(cwd, cfg.storekitConfig);
  if (!existsSync(source)) {
    console.warn(`⚠ config \`storekitConfig\` not found: ${source} — skipping StoreKit wiring`);
    return;
  }
  const base = source.split('/').pop()!;
  const iosRes = join(outDir, 'App_Resources/iOS');
  if (!existsSync(iosRes)) return;
  cpSync(source, join(iosRes, base));

  // after-prepare hook: resolve the .storekit's real location under platforms/ios at run time and
  // point each app scheme's LaunchAction at it via a path relative to the scheme file (Xcode's rule).
  const hookDir = join(outDir, 'hooks/after-prepare');
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, 'appwrap-storekit.js'), STOREKIT_HOOK(base));
  console.log(`  iap  ← StoreKit config (${base}) wired for local testing`);
}

/** The after-prepare hook source. Self-contained (no deps); zero-arg so NS's DI never chokes. */
const STOREKIT_HOOK = (base: string) => `// Generated by \`appwrap\` — wires ${base} into the iOS scheme for local StoreKit testing.
const fs = require('fs');
const path = require('path');
module.exports = function () {
  const iosDir = path.join(__dirname, '..', '..', 'platforms', 'ios');
  if (!fs.existsSync(iosDir)) return;
  const find = (dir, name) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name === 'Pods') continue; const r = find(p, name); if (r) return r; }
      else if (e.name === name) return p;
    }
    return null;
  };
  const storekit = find(iosDir, ${JSON.stringify(base)});
  if (!storekit) return;
  for (const proj of fs.readdirSync(iosDir).filter((d) => d.endsWith('.xcodeproj') && d !== 'Pods.xcodeproj')) {
    const schemesDir = path.join(iosDir, proj, 'xcshareddata', 'xcschemes');
    if (!fs.existsSync(schemesDir)) continue;
    for (const s of fs.readdirSync(schemesDir).filter((f) => f.endsWith('.xcscheme'))) {
      const file = path.join(schemesDir, s);
      let xml = fs.readFileSync(file, 'utf8');
      if (xml.includes('StoreKitConfigurationFileReference')) continue;
      const id = path.relative(schemesDir, storekit);
      const ref = '      <StoreKitConfigurationFileReference\\n         identifier = "' + id + '">\\n      </StoreKitConfigurationFileReference>';
      xml = xml.replace(/(\\s*)<\\/LaunchAction>/, '\\n' + ref + '$1</LaunchAction>');
      fs.writeFileSync(file, xml);
      console.log('  appwrap: StoreKit config wired into ' + s + ' (' + id + ')');
    }
  }
};
`;

/** Remote-push native wiring (gated on `cfg.push.enabled`). iOS: the `aps-environment` entitlement —
 * NativeScript auto-detects `App_Resources/iOS/app.entitlements` and signs with it. Idempotent:
 * removes the file when push is disabled so a personal-team (no-push) build still signs. Android FCM
 * gradle plumbing is staged separately (needs google-services.json) — only the file is copied here. */
function stampPush(cwd: string, outDir: string, cfg: AppwrapConfig): void {
  const androidPush = !!cfg.push?.enabled && cfg.push?.android !== false;
  // iOS aps-environment entitlement is emitted by stampEntitlements (unified with module entitlements).

  // Android FCM. We deliberately AVOID the `com.google.gms.google-services` gradle plugin: injecting
  // its buildscript classpath via NS's `apply from:` scripts doesn't reach the module's plugin
  // resolver (Gradle scoping → "plugin not found"). The plugin only generates string resources from
  // google-services.json that Firebase auto-init (FirebaseInitProvider) reads — so we generate those
  // resources directly + add the firebase-messaging dep. Same result, no plugin, no classpath fight.
  // Token-only register() works on auto-init; inbound onMessage/onTap to JS needs a
  // FirebaseMessagingService (the @nativescript/firebase-messaging plugin) — 1b.
  let fcmVals: Record<string, string> | null = null;
  if (androidPush && cfg.push?.googleServicesJson) {
    const src = resolve(cwd, cfg.push.googleServicesJson);
    if (existsSync(src)) {
      fcmVals = readGoogleServices(src);
      if (fcmVals) console.log(`  push ← Android FCM wired (firebase resources for ${fcmVals.project_id}, no plugin)`);
      else console.warn(`⚠ Could not parse ${src} — skipping Android FCM`);
    } else {
      console.warn(`⚠ config \`push.googleServicesJson\` not found: ${src} — skipping Android FCM`);
    }
  }
  stampAndroidFcm(outDir, fcmVals);
}

/** Extract the values Firebase auto-init needs from a google-services.json (the subset the
 * google-services plugin would otherwise codegen). Returns null if the shape is unexpected. */
function readGoogleServices(src: string): Record<string, string> | null {
  try {
    const j = JSON.parse(readFileSync(src, 'utf8'));
    const client = (j.client ?? [])[0];
    const vals: Record<string, string> = {
      google_app_id: client?.client_info?.mobilesdk_app_id ?? '',
      gcm_defaultSenderId: j.project_info?.project_number ?? '',
      google_api_key: (client?.api_key ?? [])[0]?.current_key ?? '',
      project_id: j.project_info?.project_id ?? '',
      google_storage_bucket: j.project_info?.storage_bucket ?? '',
    };
    return vals.google_app_id && vals.gcm_defaultSenderId ? vals : null;
  } catch {
    return null;
  }
}

/** Wire (or strip) Android FCM without the google-services plugin: write the firebase string
 * resources Firebase auto-init reads + add the firebase-messaging dependency. Idempotent. */
function stampAndroidFcm(outDir: string, vals: Record<string, string> | null): void {
  const resXml = join(outDir, 'App_Resources/Android/src/main/res/values/appwrap-firebase.xml');
  const appGradle = join(outDir, 'App_Resources/Android/app.gradle');
  const beforePlugins = join(outDir, 'App_Resources/Android/before-plugins.gradle');
  const stripBlock = (s: string) => s.replace(/\n*\/\/ appwrap-fcm:begin[\s\S]*?\/\/ appwrap-fcm:end\n*/g, '\n');

  // before-plugins: ensure any prior plugin-classpath block is gone (we no longer use it).
  if (existsSync(beforePlugins)) writeFileSync(beforePlugins, stripBlock(readFileSync(beforePlugins, 'utf8')).trimEnd() + '\n');

  // Inbound delivery wiring (gated by `vals` = FCM actually wired): the FirebaseMessagingService for
  // foreground/data onMessage. Declaring the <service> + importing the (Firebase-extending) shell
  // class only when FCM is present keeps a non-push build from compiling a class with an absent base.
  stampFcmService(outDir, !!vals);

  if (vals) {
    const strings = Object.entries(vals)
      .filter(([, v]) => v)
      .map(([k, v]) => `  <string name="${k}" translatable="false">${v}</string>`)
      .join('\n');
    writeFileSync(resXml, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${strings}\n</resources>\n`);
    if (existsSync(appGradle)) {
      let s = stripBlock(readFileSync(appGradle, 'utf8')).trimEnd() + '\n';
      s += `\n// appwrap-fcm:begin (remote push — gated by appwrap.json.push + google-services.json)\ndependencies {\n  implementation platform("com.google.firebase:firebase-bom:33.7.0")\n  implementation "com.google.firebase:firebase-messaging"\n}\n// appwrap-fcm:end\n`;
      writeFileSync(appGradle, s);
    }
  } else {
    rmSync(resXml, { force: true });
    rmSync(join(outDir, 'App_Resources/Android/google-services.json'), { force: true });
    if (existsSync(appGradle)) writeFileSync(appGradle, stripBlock(readFileSync(appGradle, 'utf8')).trimEnd() + '\n');
  }
}

/** Wire (or strip) the inbound FCM FirebaseMessagingService: import the shell service via the
 * generated bootstrap + declare the <service> in AndroidManifest — both ONLY when FCM is wired
 * (`on`), so non-push builds never compile/declare a Firebase-extending class. Idempotent. */
function stampFcmService(outDir: string, on: boolean): void {
  writeFileSync(
    join(outDir, 'app/shell/fcm-bootstrap.generated.ts'),
    `/** Generated by \`appwrap\` — imports the FCM messaging service only when push is wired. Do not edit. */\n` +
      (on ? `import './fcm-service'; // side-effect: registers AppwrapMessagingService (JavaProxy)\n` : ``)
  );

  const manifest = join(outDir, 'App_Resources/Android/src/main/AndroidManifest.xml');
  if (!existsSync(manifest)) return;
  const service = on
    ? `\n\t\t<service\n\t\t\tandroid:name="cc.livx.appwrap.AppwrapMessagingService"\n\t\t\tandroid:exported="false">\n\t\t\t<intent-filter>\n\t\t\t\t<action android:name="com.google.firebase.MESSAGING_EVENT" />\n\t\t\t</intent-filter>\n\t\t</service>\n\t\t`
    : '';
  const src = readFileSync(manifest, 'utf8').replace(
    /<!-- appwrap:fcm -->[\s\S]*?<!-- \/appwrap:fcm -->/,
    `<!-- appwrap:fcm -->${service}<!-- /appwrap:fcm -->`
  );
  writeFileSync(manifest, src);
}

function stampAndroidAppName(outDir: string, cfg: AppwrapConfig, req: NativeReqs): void {
  const strings = join(outDir, 'App_Resources/Android/src/main/res/values/strings.xml');
  if (existsSync(strings)) {
    let src = readFileSync(strings, 'utf8');
    src = src.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${cfg.name}$2`);
    writeFileSync(strings, src);
  }
  const manifest = join(outDir, 'App_Resources/Android/src/main/AndroidManifest.xml');
  if (existsSync(manifest)) {
    let src = readFileSync(manifest, 'utf8');
    if (cfg.urlScheme) src = src.replace(/android:scheme="[^"]*"/, `android:scheme="${cfg.urlScheme}"`);
    // Supported orientation (config > manifest) on the main <activity>. Skipped when unset → keep
    // the template default (free); 'any' removes the attribute, so re-sync stays idempotent.
    if (cfg.orientation) src = stampAndroidOrientation(src, androidScreenOrientation(cfg.orientation));
    // Permissions — idempotent: rewrite the marker block from the active modules (deduped).
    const perms = req.androidPerms.map((p) => `\t<uses-permission android:name="${p}"/>`);
    src = src.replace(
      /<!-- appwrap:permissions -->[\s\S]*?<!-- \/appwrap:permissions -->/,
      `<!-- appwrap:permissions -->\n${perms.join('\n')}\n\t<!-- /appwrap:permissions -->`
    );
    // <application> XML from active modules (activities/providers/intent-filters) — idempotent marker.
    src = src.replace(
      /<!-- appwrap:application -->[\s\S]*?<!-- \/appwrap:application -->/,
      `<!-- appwrap:application -->\n\t\t${req.androidManifestApp.join('\n\t\t')}\n\t\t<!-- /appwrap:application -->`
    );
    // <queries> for kit.app.canOpenUrl() visibility probes (API 30+) — idempotent marker. queryPackages
    // → explicit <package>; queryUrlSchemes → a VIEW <intent> per scheme (symmetric with iOS's
    // LSApplicationQueriesSchemes). See stampAndroidQueries.
    src = stampAndroidQueries(src, cfg.queryPackages, cfg.queryUrlSchemes);
    writeFileSync(manifest, src);
  }
}

/** Stamp Android marketing version (versionName) + monotonic build (versionCode) into app.gradle. */
function stampAndroidVersion(outDir: string, cfg: AppwrapConfig): void {
  const gradle = join(outDir, 'App_Resources/Android/app.gradle');
  if (!existsSync(gradle)) return;
  let src = readFileSync(gradle, 'utf8');
  src = src.replace(/versionCode\s+\d+/, `versionCode ${buildNumberOf(cfg)}`);
  src = src.replace(/versionName\s+"[^"]*"/, `versionName "${cfg.version}"`);
  writeFileSync(gradle, src);
}

/** Locate the icon source: explicit cfg.icon, else the largest icon in the PWA manifest. */
function findIconSource(cwd: string, cfg: AppwrapConfig): string | null {
  if (cfg.icon) {
    const p = resolve(cwd, cfg.icon);
    if (existsSync(p)) return p;
    console.warn(`⚠ config \`icon\` not found: ${p}`);
    return null;
  }
  const dist = resolve(cwd, cfg.pwaDist);
  const icons: Array<{ src: string; sizes?: string }> = loadManifest(cwd, cfg)?.icons ?? [];
  const best = icons
    .map((i) => ({ src: i.src, px: parseInt(i.sizes ?? '0', 10) || 0 }))
    .sort((a, b) => b.px - a.px)[0];
  if (best) {
    const p = join(dist, best.src);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Locate the maskable icon source for the Android adaptive-icon foreground (full-bleed, content in
 * the safe zone). Prefers a manifest icon with purpose "maskable"; falls back to the main source so
 * non-maskable icons still get a real foreground (just edge-cropped by the launcher mask).
 */
function findMaskableSource(cwd: string, cfg: AppwrapConfig): string | null {
  const dist = resolve(cwd, cfg.pwaDist);
  const icons: Array<{ src: string; sizes?: string; purpose?: string }> = loadManifest(cwd, cfg)?.icons ?? [];
  const maskable = icons
    .filter((i) => (i.purpose ?? '').split(/\s+/).includes('maskable'))
    .map((i) => ({ src: i.src, px: parseInt(i.sizes ?? '0', 10) || 0 }))
    .sort((a, b) => b.px - a.px)[0];
  if (maskable) {
    const p = join(dist, maskable.src);
    if (existsSync(p)) return p;
  }
  return findIconSource(cwd, cfg);
}

/** Generate iOS appiconset + Android mipmaps from the PWA's icon via sips (macOS). */
function generateIcons(cwd: string, outDir: string, cfg: AppwrapConfig): void {
  const source = findIconSource(cwd, cfg);
  if (!source) {
    console.warn('⚠ No app icon source found (manifest icons or config `icon`) — keeping template icons');
    return;
  }
  const probe = (prop: string) =>
    parseInt(execFileSync('sips', ['-g', prop, source]).toString().match(/(\d+)\s*$/)?.[1] ?? '0', 10);
  const w = probe('pixelWidth');
  if (w < 512) console.warn(`⚠ Icon source is ${w}px — below the 512px App Store minimum (using it anyway)`);

  const resize = (px: number, dest: string) =>
    execFileSync('sips', ['-z', String(px), String(px), source, '--out', dest], { stdio: 'ignore' });

  const iconset = join(outDir, 'App_Resources/iOS/Assets.xcassets/AppIcon.appiconset');
  if (existsSync(iconset)) {
    const contents = JSON.parse(readFileSync(join(iconset, 'Contents.json'), 'utf8'));
    for (const img of contents.images as Array<{ size: string; scale: string; filename: string }>) {
      const px = Math.round(parseFloat(img.size) * parseFloat(img.scale));
      resize(px, join(iconset, img.filename));
    }
  }

  const ANDROID_DENSITIES: Record<string, number> = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  const res = join(outDir, 'App_Resources/Android/src/main/res');
  for (const [density, px] of Object.entries(ANDROID_DENSITIES)) {
    const dir = join(res, `mipmap-${density}`);
    if (existsSync(dir)) resize(px, join(dir, 'ic_launcher.png'));
  }

  // Android 8+ (API 26+) renders the ADAPTIVE icon — mipmap-anydpi-v26/ic_launcher.xml's
  // <foreground>, NOT ic_launcher.png. The NS template ships a vector foreground (the default "N"),
  // so without this the launcher icon stays the template's. Generate full-bleed foreground rasters
  // (108dp per density) from the maskable icon and repoint the adaptive XML at them.
  const fgSource = findMaskableSource(cwd, cfg);
  const ADAPTIVE_DP = 108;
  const adaptiveXml = join(res, 'mipmap-anydpi-v26/ic_launcher.xml');
  if (fgSource && existsSync(adaptiveXml)) {
    const resizeFrom = (src: string, px: number, dest: string) =>
      execFileSync('sips', ['-z', String(px), String(px), src, '--out', dest], { stdio: 'ignore' });
    for (const [density, baseline] of Object.entries(ANDROID_DENSITIES)) {
      const dir = join(res, `mipmap-${density}`);
      if (!existsSync(dir)) continue;
      const px = Math.round((baseline / 48) * ADAPTIVE_DP); // scale 48dp baseline → 108dp foreground
      resizeFrom(fgSource, px, join(dir, 'ic_launcher_foreground.png'));
    }
    let xml = readFileSync(adaptiveXml, 'utf8');
    xml = xml.replace(/(<foreground[^>]*android:drawable=")[^"]*(")/, '$1@mipmap/ic_launcher_foreground$2');
    writeFileSync(adaptiveXml, xml);
  }
  console.log(`  icon ← ${source} (${w}px)`);
}

/** Tint the iOS launch screen to the configured background color. */
function stampLaunchScreen(outDir: string, cfg: AppwrapConfig): void {
  const storyboard = join(outDir, 'App_Resources/iOS/LaunchScreen.storyboard');
  if (!existsSync(storyboard) || !cfg.backgroundColor) return;
  const hex = cfg.backgroundColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return;
  const ch = (i: number) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4);
  const src = readFileSync(storyboard, 'utf8').replace(
    /<color key="backgroundColor"[^/]*\/>/g,
    `<color key="backgroundColor" red="${ch(0)}" green="${ch(2)}" blue="${ch(4)}" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>`
  );
  writeFileSync(storyboard, src);
}

const VERSION_FILE = '.appwrap-version';

/** Read a package.json version, or '?' if unreadable. */
function pkgVersion(pkgPath: string): string {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '?';
  } catch {
    return '?';
  }
}

/** Stamp `.appwrap-version` into the wrapper — the provenance record that makes `native/`
 * a disposable, regenerable artifact: which CLI/shell/protocol generated it, from which app.
 * Its presence also marks the dir as appwrap-managed (so re-`init` regenerates it safely). */
function stampVersionManifest(outDir: string, cfg: AppwrapConfig): void {
  const manifest = {
    cli: pkgVersion(resolve(import.meta.dir, '../package.json')),
    shell: pkgVersion(join(TEMPLATE_DIR, 'package.json')),
    protocol: 1,
    app: { id: cfg.id, version: cfg.version, build: buildNumberOf(cfg) },
    note: 'Generated by `appwrap init` — this directory is DISPOSABLE. Gitignore it; regenerate with `appwrap init`. Custom native code goes in your `overrides/` dir, not here.',
  };
  writeFileSync(join(outDir, VERSION_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

/** Pure-native escape hatch: copy the consumer's overrides dir OVER the generated wrapper, last,
 * so it wins. For legacy/custom native code the declarative config can't express. */
function applyOverrides(cwd: string, outDir: string, cfg: AppwrapConfig): void {
  const dir = resolve(cwd, cfg.overrides ?? 'appwrap.overrides');
  if (!existsSync(dir)) return;
  cpSync(dir, outDir, { recursive: true, force: true });
  console.log(`  over ← ${dir} (native overrides applied)`);
}

function copyPwa(cwd: string, outDir: string, cfg: AppwrapConfig): void {
  // Stage the PWA OUTSIDE appPath ('app') — in a sibling `www-src/` — so NativeScript's webpack
  // never runs its loaders (css2json etc.) over real web CSS/assets. webpack.config.js copies
  // `www-src` → the bundle's `www` verbatim; the app:// scheme handler serves it at runtime.
  const www = join(outDir, 'www-src');
  const legacyWww = join(outDir, 'app/www'); // clear any pre-isolation staging
  rmSync(legacyWww, { recursive: true, force: true });
  // server loader loads `serverUrl` live — the bundle is unused. Don't copy it; and clear any stale
  // www so it isn't shipped.
  if (cfg.loader === 'server') {
    rmSync(www, { recursive: true, force: true });
    console.log('  www  ← skipped (loader:server loads serverUrl)');
    return;
  }
  const dist = resolve(cwd, cfg.pwaDist);
  const entry = join(dist, cfg.entry ?? 'index.html');
  if (!existsSync(entry)) {
    console.error(`✖ PWA entry not found: ${entry} — build your PWA first`);
    process.exit(1);
  }
  rmSync(www, { recursive: true, force: true });
  mkdirSync(www, { recursive: true });
  cpSync(dist, www, { recursive: true });
  console.log(`  www  ← ${dist}`);
  vendorBackendAssets(www, cfg);
}

/** Fetch backend-served static assets (cfg.vendorPaths) into the bundle so they resolve offline at
 * app://. Pins them to the build — re-fetched on every init/sync. Synchronous via curl. */
function vendorBackendAssets(www: string, cfg: AppwrapConfig): void {
  if (!cfg.vendorPaths?.length) return;
  if (!cfg.backendOrigin) {
    console.error('✖ vendorPaths requires backendOrigin in the appwrap config');
    process.exit(1);
  }
  const origin = cfg.backendOrigin.replace(/\/+$/, '');
  for (const p of cfg.vendorPaths) {
    const rel = p.replace(/^\/+/, '');
    const url = `${origin}/${rel}`;
    const dest = join(www, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    // Fetch to a temp file so a transient failure never truncates a previously-vendored asset.
    // Retry a couple times (the backend can briefly reset under deploy/cold-start), and on total
    // failure fall back to the cached copy if one exists rather than breaking the whole sync.
    let ok = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        execFileSync('curl', ['-fsSL', '--retry', '2', url, '-o', tmp], { stdio: 'pipe' });
        cpSync(tmp, dest);
        ok = true;
      } catch (e: unknown) {
        lastErr = e;
      }
    }
    rmSync(tmp, { force: true });
    if (ok) {
      console.log(`  vendor ← ${url}`);
    } else if (existsSync(dest) && readFileSync(dest).length > 0) {
      console.warn(`⚠ vendor fetch failed: ${url} — using cached copy (backend unreachable).`);
      const err = execErrText(lastErr);
      if (err) console.warn(`  ${err.trim()}`);
    } else {
      console.error(`✖ vendor fetch failed: ${url} (backend reachable? path correct?) — no cached copy to fall back to`);
      const err = execErrText(lastErr);
      if (err) console.error(err.trim());
      process.exit(1);
    }
  }
}

/** Walk up from `start` to the git repo root (dir containing `.git`); fall back to `start`. */
function gitRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // reached filesystem root, no .git found
    dir = parent;
  }
}

/** Emit CI scaffolding (GH Actions → git repo root, fastlane → native/). Never overwrites. */
function copyCiTemplates(cwd: string, outDir: string, cfg: AppwrapConfig): void {
  if (!existsSync(CI_TEMPLATE_DIR)) return;
  // GitHub only reads `.github/workflows` at the REPO ROOT — in a monorepo, writing it under the
  // package cwd (e.g. packages/app/.github) is dead config and regenerates a stray workflow each init.
  const targets: Array<[string, string]> = [
    [join(CI_TEMPLATE_DIR, 'github/workflows'), join(gitRoot(cwd), '.github/workflows')],
    [join(CI_TEMPLATE_DIR, 'fastlane'), join(outDir, 'fastlane')],
  ];
  for (const [from, to] of targets) {
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  }
  // Stamp the app id + team into the emitted fastlane (signing needs them; the templates ship
  // `__APP_ID__`/`__TEAM_ID__` placeholders). Idempotent: re-init finds no placeholders → no-op.
  const fastlaneDir = join(outDir, 'fastlane');
  for (const file of ['Fastfile', 'Matchfile']) {
    const p = join(fastlaneDir, file);
    if (!existsSync(p)) continue;
    const stamped = readFileSync(p, 'utf8')
      .replaceAll('__APP_ID__', cfg.id)
      .replaceAll('__TEAM_ID__', cfg.teamId ?? '');
    writeFileSync(p, stamped);
  }
  console.log('  ci   ← GH Actions (.github/workflows) + fastlane (native/fastlane, signing stamped) — see secrets contract in workflow headers');
}

/**
 * Reproduce native/ from source — the shared core of `init` and `sync`. Copies the runtime shell
 * template, re-stamps EVERY config artifact, and re-copies the built PWA. `native/` is disposable, so a
 * full copy every time is correct — and is what keeps `sync` from silently shipping stale runtime/config
 * (the old split made `sync` skip the template + nsconfig id + version manifest → three drift footguns).
 * Excludes the first-time scaffold (managed-guard, CI, .gitignore) + overrides/version-manifest, which the
 * callers sequence around this so overrides win LAST and the marker writes after.
 */
function regenerateCore(cwd: string, outDir: string, cfg: AppwrapConfig, opts: { firstRun?: boolean; flags?: Record<string, string> } = {}): void {
  const req = nativeReqs(cfg);
  if (opts.firstRun && !req.explicit) {
    console.log('  ℹ no `modules` in the appwrap config → all capabilities active. Declare `modules` to shrink the store build (strip unused handlers/perms).');
  }
  cpSync(TEMPLATE_DIR, outDir, {
    recursive: true,
    force: true, // explicit: Bun's cpSync does not overwrite existing files by default
    // modules-native/ is copied selectively per active module (copyModuleNativeSrc), not wholesale.
    // Match RELATIVE to TEMPLATE_DIR — when installed from npm, TEMPLATE_DIR itself sits under
    // node_modules/, so testing the absolute path would wrongly exclude the entire template.
    filter: (src) => !/(?:^|\/)(node_modules|platforms|hooks|app\/www|modules-native)(\/|$)/.test(src.slice(TEMPLATE_DIR.length)),
  });
  stampShellConfig(outDir, cfg);
  stampNativeScriptConfig(outDir, cfg);
  stampIOSDisplayName(outDir, cfg, req);
  stampTeamId(outDir, cfg, { cwd, configPath: resolveConfigPath(cwd, opts.flags ?? {}) });
  stampAndroidAppName(outDir, cfg, req);
  stampAndroidVersion(outDir, cfg);
  stampAndroidGradleDeps(outDir, req.androidGradleDeps);
  stampKotlin(outDir, req.androidKotlin);
  generateModuleArtifacts(outDir, req);
  copyModuleNativeSrc(outDir, req); // module-owned native source (e.g. health's Kotlin shim)
  stampLaunchScreen(outDir, cfg);
  stampStoreKit(cwd, outDir, cfg);
  stampPush(cwd, outDir, cfg);
  stampEntitlements(outDir, cfg, req); // unified app.entitlements: module entitlements + push aps-environment
  generateIcons(cwd, outDir, cfg);
  copyPwa(cwd, outDir, cfg);
}

async function init(cwd: string, flags: Record<string, string>): Promise<void> {
  const cfg = await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');

  if (!existsSync(TEMPLATE_DIR)) {
    console.error(`✖ Runtime template not found at ${TEMPLATE_DIR}`);
    process.exit(1);
  }

  // Managed-model guard: re-`init` regenerates an appwrap-managed wrapper freely (it's disposable),
  // but refuse to clobber a directory we didn't generate unless --force is passed.
  if (existsSync(outDir)) {
    const managed = existsSync(join(outDir, VERSION_FILE));
    const nonEmpty = readdirSync(outDir).length > 0;
    if (nonEmpty && !managed && !('force' in flags)) {
      console.error(
        `✖ ${outDir} exists and is not an appwrap-managed wrapper (no ${VERSION_FILE}).\n` +
          `  Re-run with --force to overwrite it, or choose a different --out.`
      );
      process.exit(1);
    }
  }

  console.log(`🎁 appwrap init → ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  regenerateCore(cwd, outDir, cfg, { firstRun: true, flags });
  copyCiTemplates(cwd, outDir, cfg); // first-time scaffold (never overwrites)
  writeFileSync(join(outDir, '.gitignore'), 'node_modules/\nplatforms/\nhooks/\n');
  applyOverrides(cwd, outDir, cfg); // escape hatch — last, so custom native code wins
  stampVersionManifest(outDir, cfg); // provenance — also marks the dir appwrap-managed
  console.log(`✓ Wrapper ready (generated — gitignore \`${flags.out ?? 'native'}/\`, regenerate with \`appwrap init\`).\n  cd ${flags.out ?? 'native'} && npm install && ns run ios`);
}

// `sync` = the same regenerate as `init`, minus the first-time guard/scaffold. It is a TRUE refresh from
// source (shell + config + PWA), so runtime/config edits never silently lag behind. `native/` is
// disposable; re-copying the shell costs ~ms (the real cost is the later `ns build`, which both share).
async function sync(cwd: string, flags: Record<string, string>): Promise<void> {
  const cfg = await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }
  regenerateCore(cwd, outDir, cfg, { flags });
  applyOverrides(cwd, outDir, cfg); // overrides win last
  stampVersionManifest(outDir, cfg); // keep the managed-marker / provenance current
  console.log('✓ Synced.');
}

/** First non-internal IPv4 — so a physical device on the LAN can reach the dev server (localhost won't). */
function lanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/** `appwrap dev` — point the existing wrapper at a LIVE url (loader 'server') instead of bundled www.
 * Dev runs their own web server (vite host:true) or a deployed URL; this just stamps the shell config.
 * `--url <url>` explicit; else http://<lan-ip>:<port> (default 5173). Re-run `appwrap sync`/`init` to revert. */
async function dev(cwd: string, flags: Record<string, string>): Promise<void> {
  const cfg = await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }
  let url = flags.url;
  if (!url) {
    const ip = lanIp();
    if (!ip) {
      console.error('✖ Could not detect a LAN IP — pass --url http://<host>:<port> explicitly');
      process.exit(1);
    }
    url = `http://${ip}:${flags.port ?? '5173'}`;
  }
  // Dev is inherently a debug workflow: enables the WebView inspector, keep-awake, and the
  // debug-only dev-server SSL bypass (LAN dev servers use self-signed/mkcert certs the device
  // doesn't trust). Revert to a non-debug, bundled build with `appwrap sync`.
  stampShellConfig(outDir, { ...cfg, loader: 'server', serverUrl: url, debug: true });
  console.log(`✓ Dev loader → ${url} (debug)`);
  console.log(`  Web server must bind 0.0.0.0 (vite: \`server.host: true\` / \`--host\`) so the device can reach it.`);
  if (url.startsWith('https:')) {
    console.log(`  ⚠ Android: serve the dev server over HTTP, not HTTPS — the WebView can't bypass wss TLS`);
    console.log(`    errors, so HMR won't live-reload on-device (the page still loads). iOS is fine with HTTPS.`);
  }
  console.log(`  Then: cd ${flags.out ?? 'native'} && ns run ios   (revert with \`appwrap sync\`)`);
}

/** `appwrap build <ios|android> [--release] [--aab]` — store-readiness build path. Re-stamps config,
 * re-copies the PWA, then delegates the actual compile to NativeScript with the right flags. Release
 * Android signing comes from env (APPWRAP_ANDROID_KEYSTORE[_PASSWORD|_ALIAS|_ALIAS_PASSWORD]) — secrets
 * never live in the appwrap config. iOS distribution signing/upload is the fastlane release lane's job (the
 * cicd templates); `--release` here just builds the Release config for the device. */
async function build(cwd: string, flags: Record<string, string>, positionals: string[]): Promise<void> {
  const platform = positionals[0];
  if (platform !== 'ios' && platform !== 'android') {
    console.error('Usage: appwrap build <ios|android> [--release] [--aab] [--config <path>] [--out native]');
    process.exit(1);
  }
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }
  // Make sure the wrapper reflects the latest config + PWA before compiling (also validates the config).
  await sync(cwd, flags);

  const release = 'release' in flags;
  const args = ['build', platform];
  if (release) args.push('--release');
  if (platform === 'ios' && release) args.push('--for-device');
  if (platform === 'android' && 'aab' in flags) args.push('--aab');

  if (platform === 'android' && release) {
    const ks = process.env.APPWRAP_ANDROID_KEYSTORE;
    if (!ks) {
      console.error(
        '✖ Release Android build needs a signing keystore. Set:\n' +
          '    APPWRAP_ANDROID_KEYSTORE=/abs/path/to.keystore\n' +
          '    APPWRAP_ANDROID_KEYSTORE_PASSWORD=…  APPWRAP_ANDROID_KEYSTORE_ALIAS=…  APPWRAP_ANDROID_KEYSTORE_ALIAS_PASSWORD=…\n' +
          '  (generate a throwaway one with `keytool -genkeypair -keystore upload.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000`).'
      );
      process.exit(1);
    }
    args.push(
      '--key-store-path', ks,
      '--key-store-password', process.env.APPWRAP_ANDROID_KEYSTORE_PASSWORD ?? '',
      '--key-store-alias', process.env.APPWRAP_ANDROID_KEYSTORE_ALIAS ?? '',
      '--key-store-alias-password', process.env.APPWRAP_ANDROID_KEYSTORE_ALIAS_PASSWORD ?? ''
    );
  }

  console.log(`▶ ns ${args.join(' ').replace(/(--key-store-password|--key-store-alias-password) [^ ]*/g, '$1 ****')}  (cwd: ${outDir})`);
  execFileSync('ns', args, { cwd: outDir, stdio: 'inherit' });
  if (platform === 'ios' && release) {
    console.log('ℹ App Store distribution (archive + upload) goes through the fastlane release lane (native/fastlane) — needs a paid team + ASC API key.');
  }
}

interface AppleTeam { teamId: string; name: string; email?: string; paid: boolean }
interface DeviceInfo { id: string; name: string; model: string; transport: string }

/** The subset of a `xcrun devicectl list devices --json-output` device entry appwrap reads. */
interface DevicectlDevice {
  identifier?: string;
  deviceProperties?: { name?: string };
  hardwareProperties?: { platform?: string; marketingName?: string; productType?: string };
  connectionProperties?: { tunnelState?: string; transportType?: string };
}

/** Read Apple team metadata from provisioning profiles + distribution certs in the keychain.
 * Provisioning profiles give us the reliable teamId↔teamName mapping; distribution certs
 * often embed the account email in the display name. */
function detectAppleTeams(): AppleTeam[] {
  const teams = new Map<string, AppleTeam>();

  // 1. Provisioning profiles → teamId + teamName (most reliable)
  const profilesDir = join(process.env.HOME ?? '', 'Library/MobileDevice/Provisioning Profiles');
  if (existsSync(profilesDir)) {
    try {
      const files = readdirSync(profilesDir).filter((f) => f.endsWith('.mobileprovision'));
      for (const f of files) {
        try {
          const raw = execFileSync('security', ['cms', '-D', '-i', join(profilesDir, f)],
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
          const idMatch = raw.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
          const nameMatch = raw.match(/<key>TeamName<\/key>\s*<string>([^<]+)<\/string>/);
          if (idMatch && nameMatch) {
            const teamId = idMatch[1];
            const name = nameMatch[1];
            const free = /personal team/i.test(name);
            if (!teams.has(teamId)) teams.set(teamId, { teamId, name, paid: !free });
          }
        } catch { /* skip unreadable profile */ }
      }
    } catch { /* skip if dir unreadable */ }
  }

  // 2. Keychain distribution/Developer-ID certs → teamId + possible email in name
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    for (const line of out.split('\n')) {
      const m = line.match(/"(?:Apple Distribution|Developer ID Application): (.+?) \(([A-Z0-9]{10})\)"/);
      if (!m) continue;
      const [, label, teamId] = m;
      const email = label.includes('@') ? label.trim() : undefined;
      const existing = teams.get(teamId);
      if (existing) {
        if (email && !existing.email) existing.email = email;
      } else {
        teams.set(teamId, { teamId, name: label.trim(), email, paid: !/personal team/i.test(label) });
      }
    }
  } catch { /* keychain unavailable */ }

  return [...teams.values()];
}

/** Arrow-key interactive selector. Returns the index of the chosen item. */
function arrowSelect(prompt: string, items: string[]): number {
  const tty = openSync('/dev/tty', 'r+');
  const write = (s: string) => writeSync(tty, s);
  const ESC = '\x1b';

  write(`${prompt}\n`);
  let idx = 0;
  const HINT = '\x1b[2m  ↑↓ / j k to move · Enter to confirm\x1b[0m';
  const render = (clear: boolean) => {
    if (clear) write(`\x1b[${items.length + 1}A`); // +1 for the hint line
    for (let i = 0; i < items.length; i++)
      write(`\r\x1b[K${i === idx ? '❯ ' : '  '}${items[i]}\n`);
    write(`\r\x1b[K${HINT}\n`);
  };
  render(false);

  // raw mode via stty
  execFileSync('stty', ['-icanon', '-echo'], { stdio: ['inherit', 'inherit', 'inherit'] });
  const buf = Buffer.alloc(6);
  try {
    for (;;) {
      const n = readSync(tty, buf, 0, 6, null);
      const key = buf.slice(0, n).toString();
      if (key === `${ESC}[A` || key === 'k') { idx = (idx - 1 + items.length) % items.length; render(true); }
      else if (key === `${ESC}[B` || key === 'j') { idx = (idx + 1) % items.length; render(true); }
      else if (key === '\r' || key === '\n') break;
      else if (key === '\x03') { write('\n'); process.exit(1); } // Ctrl-C
    }
  } finally {
    execFileSync('stty', ['icanon', 'echo'], { stdio: ['inherit', 'inherit', 'inherit'] });
    // Erase the hint line so the selected value prints cleanly after
    write(`\x1b[1A\r\x1b[K`);
    write('\n');
    closeSync(tty);
  }
  return idx;
}

/** Interactively prompt for an Apple team when teamId is unset. Shows enriched metadata
 * (email, paid/free) sourced from local keychain + provisioning profiles. */
function pickTeamIdInteractively(): { teamId: string; name: string } {
  const teams = detectAppleTeams();
  if (teams.length === 0) {
    console.error('✖ No Apple signing teams found in keychain/provisioning profiles.\n' +
      '  Sign into Xcode → Settings → Accounts, then re-run.');
    process.exit(1);
  }
  if (teams.length === 1) {
    const t = teams[0];
    console.log(`  team ← ${t.name} (${t.teamId})${t.email ? ` <${t.email}>` : ''} [${t.paid ? 'paid' : 'free'}] (only option)`);
    return { teamId: t.teamId, name: t.name };
  }
  const items = teams.map((t) => {
    const badge = t.paid ? '✓ paid' : '○ free';
    const email = t.email ? ` <${t.email}>` : '';
    return `${t.name} (${t.teamId})${email}  [${badge}]`;
  });
  const idx = arrowSelect('Found multiple Apple teams — pick one to use for signing:', items);
  return { teamId: teams[idx].teamId, name: teams[idx].name };
}

/** Y/n confirmation on the TTY (default-yes here). Reuses the global `prompt` primitive. A
 * non-interactive / piped stdin returns null → falls back to `def` ONLY when there's a real TTY;
 * a fully headless run never reaches here (callers gate on `process.stdout.isTTY` first), but be
 * defensive: if stdin can't be read, do NOT pin (safer to re-ask than to silently mutate config). */
function promptYesNo(message: string, def: boolean): boolean {
  if (!process.stdin.isTTY) return false;
  const suffix = def ? ' [Y/n] ' : ' [y/N] ';
  const ans = (globalThis as { prompt(msg?: string): string | null }).prompt(message + suffix);
  if (ans == null) return false;
  const a = ans.trim().toLowerCase();
  if (a === '') return def;
  return a === 'y' || a === 'yes';
}

/** Persist `teamId` into the user's appwrap config so the interactive picker isn't re-run every
 * deploy. Pure string surgery (returns the new file content) so it's unit-testable across both
 * supported formats:
 *  - `.json` — set/replace the top-level `"teamId"` property (preserves 2-space indent).
 *  - `.ts`/`.js` — replace an existing `teamId:` field value (incl. the `YOUR_APPLE_TEAM_ID`
 *    placeholder), else insert a new `teamId: '<id>',` line near the other top-level fields
 *    (after `id:`, matching its indentation/quote style). If the shape is unexpected, returns
 *    `null` so the caller skips the write rather than corrupting the file. */
export function pinTeamIdInConfigSource(src: string, teamId: string, isJson: boolean): string | null {
  if (isJson) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(src) as Record<string, unknown>; } catch { return null; }
    if (typeof obj !== 'object' || obj == null) return null;
    obj.teamId = teamId;
    return JSON.stringify(obj, null, 2) + (src.endsWith('\n') ? '\n' : '');
  }
  // TS/JS: replace an existing teamId field value, preserving its quote style.
  const existing = /(\bteamId\s*:\s*)(['"`])[^'"`]*\2/;
  if (existing.test(src)) {
    return src.replace(existing, (_m, lead: string, q: string) => `${lead}${q}${teamId}${q}`);
  }
  // No teamId field — insert after the `id:` field (mirroring its indentation + quote style).
  const idLine = /^([ \t]*)id\s*:\s*(['"`])[^'"`]*\2\s*,?[ \t]*$/m;
  const m = idLine.exec(src);
  if (!m) return null; // unfamiliar shape — don't risk corrupting it
  const indent = m[1];
  const quote = m[2];
  return src.slice(0, m.index + m[0].length)
    + `\n${indent}teamId: ${quote}${teamId}${quote},`
    + src.slice(m.index + m[0].length);
}

/** Write the pinned teamId to the resolved config file (thin IO wrapper over the pure helper). */
function pinTeamIdToConfig(configPath: string, teamId: string): void {
  if (!existsSync(configPath)) {
    console.warn(`  ⚠ could not pin teamId — config not found at ${configPath}`);
    return;
  }
  const src = readFileSync(configPath, 'utf8');
  const next = pinTeamIdInConfigSource(src, teamId, configPath.endsWith('.json'));
  if (next == null) {
    console.warn(`  ⚠ couldn't safely edit ${configPath} (unexpected shape) — leaving it untouched. Set teamId: '${teamId}' manually.`);
    return;
  }
  writeFileSync(configPath, next);
  console.log(`  ✓ pinned teamId: '${teamId}' to ${configPath}`);
}

// ── Build fingerprint for smart resume ───────────────────────────────────────────────────────────

/** Cheap fingerprint of SOURCE build inputs: mtime sum of the PWA dist/ + appwrap config.
 * App_Resources/ is intentionally excluded — sync() rewrites it every run, so its mtime always
 * changes and would make the fingerprint permanently stale.
 * Collision risk is acceptable — a false "match" just skips a redundant build, not a correctness bug. */
function buildFingerprint(cwd: string, cfg: { pwaDist?: string }, _outDir: string): string {
  const mtime = (p: string): number => {
    if (!existsSync(p)) return 0;
    try {
      const s = statSync(p);
      if (s.isDirectory()) {
        let sum = 0;
        for (const e of readdirSync(p, { withFileTypes: true }))
          sum += mtime(join(p, e.name));
        return sum;
      }
      return s.mtimeMs;
    } catch { return 0; }
  };
  const distDir = cfg.pwaDist ? resolve(cwd, cfg.pwaDist) : join(cwd, 'dist');
  const parts = [mtime(distDir), mtime(join(cwd, 'appwrap.config.ts'))];
  // Simple djb2-style hash — good enough for a build-skip check (not cryptographic).
  let h = 5381;
  for (const n of parts) h = (((h << 5) + h) ^ (n | 0)) >>> 0;
  return h.toString(36);
}

const BUILD_CACHE_FILE = '.appwrap-build-cache.json';
interface BuildCache { fingerprint: string; ipaPath: string; builtAt: string }

function readBuildCache(outDir: string): BuildCache | null {
  try { return JSON.parse(readFileSync(join(outDir, BUILD_CACHE_FILE), 'utf8')); } catch { return null; }
}
function writeBuildCache(outDir: string, cache: BuildCache): void {
  try { writeFileSync(join(outDir, BUILD_CACHE_FILE), JSON.stringify(cache, null, 2)); } catch { /* non-fatal */ }
}

/** Discover usable physical iOS devices via devicectl (USB + network). Excludes 'unavailable'
 * tunnels and non-iOS (watch). Returns [] if none. */
function listIosDevices(): DeviceInfo[] {
  const out = join(tmpdir(), `appwrap-devices-${process.pid}.json`);
  try {
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], { stdio: 'pipe' });
    const j = JSON.parse(readFileSync(out, 'utf8')) as { result?: { devices?: DevicectlDevice[] } };
    rmSync(out, { force: true });
    return (j?.result?.devices ?? [])
      .filter((d) => d?.hardwareProperties?.platform === 'iOS'
        && d?.connectionProperties?.tunnelState !== 'unavailable')
      .map((d) => ({
        id: d.identifier ?? '',
        name: d?.deviceProperties?.name ?? '(unknown)',
        model: d?.hardwareProperties?.marketingName ?? d?.hardwareProperties?.productType ?? '',
        transport: d?.connectionProperties?.transportType ?? '',
      }));
  } catch {
    return [];
  }
}

/** Pick a device: explicit --device wins; else auto-select the only one; else list + prompt. */
function pickDevice(devices: DeviceInfo[], explicitId?: string): DeviceInfo {
  if (explicitId) {
    const m = devices.find((d) => d.id === explicitId || d.name === explicitId);
    if (!m) { console.error(`✖ --device "${explicitId}" not found among connected devices.`); process.exit(1); }
    return m;
  }
  if (devices.length === 0) {
    console.error('✖ No connected iOS device found. Plug in via USB (unlocked, "Trust") or pair over Wi-Fi.');
    process.exit(1);
  }
  if (devices.length === 1) {
    console.log(`📱 Using ${devices[0].name} (${devices[0].model || devices[0].transport})`);
    return devices[0];
  }
  console.log('Multiple devices connected:');
  devices.forEach((d, i) => console.log(`  ${i + 1}) ${d.name} — ${d.model || 'iPhone'} [${d.transport}]`));
  const ans = (globalThis as { prompt(msg?: string): string | null }).prompt(`Select device [1-${devices.length}]: `);
  const idx = Number(ans) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= devices.length) {
    console.error('✖ Invalid selection.'); process.exit(1);
  }
  return devices[idx];
}

/** `appwrap deploy ios [--device <id|name>] [--no-launch]` — build for device, auto-pick the
 * connected phone (USB or network; prompts if several), install + launch. Debug build (no
 * distribution signing) — for testing on your own device. Run the PWA build first (or via the script). */
async function deploy(cwd: string, flags: Record<string, string>, positionals: string[]): Promise<void> {
  const platform = positionals[0];
  if (platform !== 'ios') {
    console.error('Usage: appwrap deploy ios [--device <id|name>] [--no-launch]  (android: use `ns run android`)');
    process.exit(1);
  }
  const cfg = await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }
  // Pick the device up front so we fail fast before a long build if nothing's connected.
  const device = pickDevice(listIosDevices(), flags.device || undefined);

  await sync(cwd, flags); // re-stamp config + copy latest PWA dist (+ vendor backend assets)
  // Dev deploy → debug mode: keep-awake + WebView inspector for continuous troubleshooting.
  stampShellConfig(outDir, { ...cfg, debug: true });

  const ipaDir = join(outDir, 'platforms/ios/build/Debug-iphoneos');

  // Smart resume: skip ns build (pod install + xcodebuild) when inputs haven't changed.
  // --resume (-r): opt in to fingerprint-based skip (same logic as auto, but explicit — useful when
  //   the auto check has no prior cache yet and you want to force a skip on first run after a manual build).
  // Auto: always checks fingerprint; never skips if sources/deps changed.
  const resume = 'resume' in flags || 'r' in flags;
  const force = 'force' in flags || 'f' in flags;
  const fp = buildFingerprint(cwd, cfg, outDir);
  const cache = readBuildCache(outDir);
  const existingIpa = existsSync(ipaDir)
    ? readdirSync(ipaDir).find((f) => f.endsWith('.ipa'))
    : undefined;
  const fingerprintMatch = !force && existingIpa && cache?.fingerprint === fp && cache?.ipaPath === join(ipaDir, existingIpa);
  // --resume also accepts a missing cache file (e.g. after a manual Xcode build or first run),
  // but ONLY when the fingerprint matches what's currently on disk — never skips a needed build.
  const noCache = existingIpa && !cache;
  const canSkipBuild = !force && (fingerprintMatch || (resume && noCache));

  if (canSkipBuild) {
    const reason = fingerprintMatch ? 'inputs unchanged since last build' : '--resume (first run, .ipa present)';
    console.log(`⚡ Skipping build — ${reason} (${existingIpa})`);
  } else {
    console.log(`▶ ns build ios --for-device  (debug: keep-awake + inspector on)${force ? '  [--force: skipping cache]' : ''}`);
    try {
      execFileSync('ns', ['build', 'ios', '--for-device'], { cwd: outDir, stdio: 'inherit' });
    } catch (e) {
      // The xcodebuild dump above is cryptic; surface the two signing failures we actually hit most.
      console.error(
        '\n✖ Device build failed — if the errors above mention signing:\n' +
          `  • "Failed Registering Bundle Identifier … not available" → the App ID "${cfg.id}" is already\n` +
          '    registered to another team (e.g. a prior free-team build). Change `id` in appwrap.config to a\n' +
          '    unique string and re-deploy.\n' +
          '  • "profile doesn\'t include the … entitlement" (e.g. HealthKit) → that capability needs a PAID\n' +
          '    team (Individual). A free Personal Team can\'t hold it — switch teamId or drop the module.\n' +
          '  • "No Account for Team" → sign that Apple ID into Xcode → Settings → Accounts first.'
      );
      process.exit(1);
    }
  }

  const builtIpa = existsSync(ipaDir) ? readdirSync(ipaDir).find((f) => f.endsWith('.ipa')) : undefined;
  const ipa = builtIpa;
  if (!ipa) { console.error(`✖ No .ipa produced in ${ipaDir}`); process.exit(1); }
  const ipaPath = join(ipaDir, ipa);
  if (!canSkipBuild) writeBuildCache(outDir, { fingerprint: fp, ipaPath, builtAt: new Date().toISOString() });

  console.log(`▶ installing ${ipa} → ${device.name} [${device.transport}]`);
  let installedViaUsbmux = false;
  try {
    // Capture (not inherit) so we can recognize specific failures; echo it for visibility.
    // Wrapped so a LOCKED device waits-and-retries instead of hard-failing (the common annoyance).
    // --timeout: devicectl has no first-class "wait for unlock", but its overall-timeout lets a single
    // attempt tolerate a brief locked/unavailable window before erroring; the outer retry covers the
    // fail-fast case + the unlock prompt. (Verified against `devicectl --help`; community wraps it too.)
    const out = withUnlockRetry('Install', () =>
      execFileSync('xcrun', ['devicectl', 'device', 'install', 'app', '--timeout', '25', '--device', device.id, ipaPath], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
    );
    process.stdout.write(out);
  } catch (e: unknown) {
    const log = execErrText(e);
    process.stderr.write(log);
    if (/maximum number of installed apps|MIInstallerErrorDomain error 13|ApplicationVerificationFailed/.test(log)) {
      // Free Apple developer profile caps a device at 3 app IDs — a sibling appwrap/WDA build often eats a slot.
      const ids = [...log.matchAll(/"([A-Z0-9]{10}\.[^"]+)"/g)].map((m) => m[1]);
      console.error(
        "\n✖ Install blocked: this device hit the FREE developer profile's 3-app limit (not a lock).\n" +
          (ids.length ? `  Installed under this team: ${ids.join(', ')}\n` : '') +
          '  → Uninstall one you don\'t need, then re-run:\n' +
          `      xcrun devicectl device uninstall app --device ${device.id} <bundleId>\n` +
          '  (A paid Apple Developer account removes this limit.)'
      );
      process.exit(1);
    } else if (/Command timeout|got stuck|could not be reached|Unable to connect to device/.test(log)) {
      // devicectl/CoreDevice is stuck (a connection hang, NOT a lock). usbmux (ideviceinstaller) is a
      // separate stack that usually still works — auto-fall-back instead of chasing a phantom "unlock".
      console.error('\n⚠ devicectl/CoreDevice is stuck (connection hang, not a lock) — falling back to ideviceinstaller (usbmux)…');
      if (usbmuxInstall(ipaPath)) {
        installedViaUsbmux = true;
      } else {
        console.error(
          '✖ usbmux fallback unavailable.\n' +
            '  → Re-plug the USB cable (re-establishes the CoreDevice tunnel) and re-run, OR\n' +
            '    `brew install ideviceinstaller` for a usbmux install path.\n' +
            `  The built .ipa is ready: ${ipaPath}`
        );
        process.exit(1);
      }
    } else {
      console.error(
        '✖ Install failed (device still locked after waiting, or only on Wi-Fi).\n' +
          '  → Unlock the phone (and plug in USB for a reliable connection), then re-run.\n' +
          `  The built .ipa is ready: ${ipaPath}`
      );
      process.exit(1);
    }
  }

  // devicectl process-launch is also stuck when we fell back to usbmux — skip it; the user taps the icon.
  if (!('no-launch' in flags) && !installedViaUsbmux) {
    console.log(`▶ launching ${cfg.id}`);
    try {
      withUnlockRetry('Launch', () =>
        execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--timeout', '25', '--device', device.id, cfg.id], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
      );
    } catch {
      console.error('⚠ Launch failed (still locked after waiting). The app is installed — unlock and tap it, or re-run.');
    }
  }
  console.log(installedViaUsbmux
    ? `✓ Installed to ${device.name} via usbmux (devicectl was stuck). Tap the app icon to open it.`
    : `✓ Deployed to ${device.name}.`);
}

/** Install an .ipa over usbmux via ideviceinstaller — a separate stack from devicectl/CoreDevice, so it
 * works when the CoreDevice tunnel is stuck. Returns false if ideviceinstaller is absent or the install
 * fails (the caller then prints the re-plug / brew-install remedy). */
function usbmuxInstall(ipaPath: string): boolean {
  try {
    const out = execFileSync('ideviceinstaller', ['install', ipaPath], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    process.stdout.write(out);
    return /Complete|Installed/i.test(out);
  } catch (e: unknown) {
    process.stderr.write(execErrText(e));
    return false;
  }
}

/** Run a devicectl op; if it fails because the device is LOCKED (or transiently unavailable), prompt
 * once and poll-retry until it succeeds or the budget runs out — instead of hard-failing. A free-team
 * 3-app-limit error is NOT a lock, so it's re-thrown immediately for the caller's specific handling.
 * (We can't auto-unlock — that needs the passcode by design — but we can wait gracefully.) */
function withUnlockRetry<T>(label: string, run: () => T, tries = 40, delayMs = 3000): T {
  for (let i = 0; ; i++) {
    try {
      return run();
    } catch (e: unknown) {
      const log = execErrText(e);
      if (/maximum number of installed apps|MIInstallerErrorDomain error 13|ApplicationVerificationFailed/.test(log)) throw e;
      // devicectl/CoreDevice tunnel STUCK (it switches to a [wired] path and hangs) is NOT a lock —
      // retrying as "waiting for unlock" is pointless + misleading. Re-throw so the caller can fall back.
      if (/Command timeout|got stuck|could not be reached|Unable to connect to device/.test(log)) throw e;
      if (i >= tries) throw e;
      if (i === 0) process.stdout.write(`\n🔒 ${label}: device unavailable — unlock your iPhone. Waiting (auto-retries every ${delayMs / 1000}s, up to ${Math.round((tries * delayMs) / 1000)}s)…\n`);
      else process.stdout.write(`  …waiting for unlock (${i}/${tries})\n`);
      try { execFileSync('sleep', [String(delayMs / 1000)], { stdio: 'ignore' }); } catch { /* sleep interrupted */ }
    }
  }
}

/** First connected libimobiledevice UDID (USB, then network). Distinct from devicectl's identifier. */
function libimobiledeviceUdid(): { udid: string; network: boolean } | null {
  for (const [args, network] of [[['-l'], false], [['-n'], true]] as const) {
    try {
      const out = execFileSync('idevice_id', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const first = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
      if (first) return { udid: first.split(/\s+/)[0], network };
    } catch { /* idevice_id missing or no device */ }
  }
  return null;
}

/** `appwrap logs ios` — read the WebView's forwarded console + errors. In debug builds the shell
 * forwards them to a file in the app container (NS `console.log`/`NSLog` do NOT surface to devicectl
 * or idevicesyslog on a device build — a file is the reliable channel), which this pulls via
 * `devicectl device copy`. DEFAULT: watch (poll the file ~every 3s, print new lines). `--once`:
 * one snapshot. `--native`: the OS-level app syslog firehose via idevicesyslog (native crashes; USB).
 * Headless-friendly: redirect to a file and read it. */
async function logs(cwd: string, flags: Record<string, string>, positionals: string[]): Promise<void> {
  const platform = positionals[0] ?? 'ios';
  if (platform !== 'ios') {
    console.error('Usage: appwrap logs ios [--once] [--native] [--device <id|name>]');
    process.exit(1);
  }
  const cfg = await loadConfig(cwd, flags);

  if ('native' in flags) {
    const li = libimobiledeviceUdid();
    if (!li) {
      console.error('✖ No device via libimobiledevice (need USB, or `brew install libimobiledevice`).');
      process.exit(1);
    }
    console.log(`▶ native OS syslog for ${cfg.id} (idevicesyslog -p native) — Ctrl-C to stop.`);
    try {
      execFileSync('idevicesyslog', ['-u', li.udid, ...(li.network ? ['-n'] : []), '-p', 'native'], { stdio: 'inherit' });
    } catch {
      process.exit(1);
    }
    return;
  }

  const device = pickDevice(listIosDevices(), flags.device || undefined);
  const dest = join(tmpdir(), `appwrap-weblog-${process.pid}.log`);
  const pull = (): string => {
    try {
      execFileSync(
        'xcrun',
        ['devicectl', 'device', 'copy', 'from', '--device', device.id, '--domain-type', 'appDataContainer',
          '--domain-identifier', cfg.id, '--source', 'Documents/appwrap-web.log', '--destination', dest],
        { stdio: ['ignore', 'ignore', 'ignore'] }
      );
      return readFileSync(dest, 'utf8');
    } catch {
      return ''; // not yet created (app hasn't logged) or not a debug build
    }
  };

  if ('once' in flags) {
    process.stdout.write(pull() || '(no web log yet — debug build? has the app logged anything?)\n');
    return;
  }

  console.log(`▶ watching web logs from ${cfg.id} on ${device.name} (pull every 3s) — Ctrl-C to stop.`);
  console.log('  [appwrap-web] = forwarded WebView console/errors. (--once = snapshot, --native = OS firehose.)');
  let shown = 0;
  for (;;) {
    const all = pull();
    if (all.length < shown) shown = 0; // app relaunched → file reset; reprint
    if (all.length > shown) { process.stdout.write(all.slice(shown)); shown = all.length; }
    try { execFileSync('sleep', ['3']); } catch { break; }
  }
}

/** CLI dispatch. Guarded by `import.meta.main` so importing this module (e.g. for the `AppwrapConfig`
 * type via the package entry) doesn't run a command. */
async function main(): Promise<void> {
  const { command, flags, positionals } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  switch (command) {
    case 'init':
      await init(cwd, flags);
      break;
    case 'sync':
      await sync(cwd, flags);
      break;
    case 'dev':
      await dev(cwd, flags);
      break;
    case 'build':
      await build(cwd, flags, positionals);
      break;
    case 'deploy':
      await deploy(cwd, flags, positionals);
      break;
    case 'logs':
      await logs(cwd, flags, positionals);
      break;
    default:
      console.log('Usage: appwrap <init|sync|dev|build|deploy|logs> [--config <path>] [--out native]\n' +
        '  config: appwrap.config.ts (preferred) → .js → appwrap.json\n' +
        '  build <ios|android> [--release] [--aab]   deploy ios [--device <id|name>] [--no-launch]\n' +
        '  logs ios [--once] [--native]   dev [--url <url> | --port <p>]');
      process.exit(command ? 1 : 0);
  }
}

if (import.meta.main) {
  main();
}
