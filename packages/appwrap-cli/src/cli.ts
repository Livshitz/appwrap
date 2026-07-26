#!/usr/bin/env bun
/**
 * appwrap CLI v0 — scaffold a native wrapper around a built PWA.
 *
 *   appwrap init [--config <path>] [--out native] [--ci]   # from the PWA project dir; --ci also scaffolds GH Actions workflows
 *   appwrap sync [--config <path>] [--out native]   # re-copy PWA dist into the wrapper
 *
 * Config (TS preferred, JSON fallback) — probed in order: appwrap.config.ts → .js → appwrap.json.
 * Shape: { id, name, version, entry?, backgroundColor?, statusBarStyle?, pwaDist }. See config.ts.
 */
import { execFileSync, spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'fs';
import { builtinModules } from 'module';
import { networkInterfaces, tmpdir } from 'os';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
// PURE-DATA capability manifest (no NativeScript globals) — type-only import (erased at runtime);
// the VALUES are loaded dynamically below from the resolved runtime so the CLI works both in the
// monorepo and from a published tarball (where runtime/ is bundled at the package root).
import type * as CapManifest from '../../../runtime/app/shell/capabilities.manifest';
// Config shape lives in its own import-safe module so a `appwrap.config.ts` file can import the
// type + `defineConfig` helper without pulling in (and running) the CLI dispatch.
import type { AppwrapConfig } from './config';
import { encodeShareDirectSync, unknownConfigKeys } from './config';
import { resolveModulePacks, type ResolvedModule, type SyncContext } from './packs';
import { createHash } from 'crypto';
// Icon helpers re-exported via `@livx.cc/appwrap/cli` so a host-provided platform lane can reuse them.
export { APPLE_ICON_GRID_SCALE, makeDockRuntimeIcon } from './icon';
import {
  androidScreenOrientation,
  applyBuildNumberFlag,
  iosOrientations,
  mergeManifest,
  resolveBuildNumber,
  stampAndroidOrientation,
  stampAndroidQueries,
  stampAppBoundDomains,
  stampPlistBackgroundTasks,
  stampPlistOrientations,
  stampPrivacyTracking,
  stripEmptyBackgroundModes,
} from './derive';
import type { WebManifest } from './derive';

/** What `child_process.execFileSync` attaches to the Error it throws on a non-zero exit
 * (stdout/stderr are Buffer with the default encoding, string when `encoding` is set). */
interface ExecError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  status?: number | null;
  signal?: string | null;
  code?: string | number | null;
}
const asExecError = (e: unknown): ExecError => (e ?? {}) as ExecError;
/** Combined stdout+stderr captured on an exec failure (empty string when none). */
const execErrText = (e: unknown): string => {
  const err = asExecError(e);
  return `${err.stdout ?? ''}${err.stderr ?? ''}`;
};
/** True when an exec failed because OUR process-level `timeout:` killed it (SIGTERM / ETIMEDOUT) —
 * the signature of a child that hung silently, as a wedged CoreDeviceService makes devicectl do. */
const isTimeoutKill = (e: unknown): boolean => {
  const err = asExecError(e);
  return err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(err.message ?? ''));
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
 * (one level above src/); the monorepo resolves them at the repo root (three levels up). Returns the
 * REAL path — a dev checkout may stage the package-root dir as a symlink to the repo-root source (what
 * prepack does with a copy), and Bun's cpSync refuses a symlink as a copy-source root. */
function resolveAssetRoot(rel: string): string {
  const local = resolve(import.meta.dir, '..', rel);
  const dir = existsSync(local) ? local : resolve(import.meta.dir, '../../..', rel);
  try { return realpathSync(dir); } catch { return dir; }
}
const TEMPLATE_DIR = resolveAssetRoot('runtime');
/** Ordered runtime-template roots copied into native/ (later roots overlay earlier — file-level
 * last-wins), defaulting to the single built-in template. runCli (A5) can extend this so a consumer
 * (a host) layers extra shell files on top of the built-in one without forking the template. A single root
 * is byte-identical to the pre-overlay behavior. */
let TEMPLATE_ROOTS: string[] = [TEMPLATE_DIR];
const CI_TEMPLATE_DIR = resolveAssetRoot('templates/ci');
/** Scaffold for `appwrap create-module` — a starter module pack (see packs.ts / @livx.cc/appwrap/testing). */
const MODULE_PACK_TEMPLATE_DIR = resolveAssetRoot('templates/module-pack');
/** Desktop template dir. No desktop template ships here — the desktop lane is host-owned: a consumer
 * points this at its own template via `runCli({ desktopTemplateDir })` (A5). A `let` so runCli can
 * override it; empty by default so the mobile lanes are unaffected. */
let DESKTOP_TEMPLATE_DIR = '';

/** The desktop template dir set via `runCli({ desktopTemplateDir })`. Read by the host-provided desktop
 * lane (composed through the `platforms` seam) so the seam stays authoritative in one place. */
export function getDesktopTemplateDir(): string {
  return DESKTOP_TEMPLATE_DIR;
}

/**
 * Composition seam for a HOST that wraps this CLI (any consumer). Every field is
 * optional and no-op by default, so the bare `appwrap` bin behaves exactly as before. A host calls
 * `runCli({...})` to extend the CLI without forking it.
 */
export interface CliOptions {
  /** Extra or overriding top-level commands, keyed by command name — consulted BEFORE the built-in
   * switch, so a host can add a command or replace a built-in one. */
  commands?: Record<string, (cwd: string, flags: Record<string, string>, positionals: string[]) => Promise<void> | void>;
  /** Pluggable platform handlers for `dev`/`build` (keyed by the platform arg, e.g. 'desktop') —
   * consulted BEFORE the built-in platform routing, so a host can add/replace a platform lane. The
   * 4th arg is the driving command ('dev' | 'build') so a single handler (e.g. a desktop lane)
   * can branch dev-vs-build — `dev desktop` and `build desktop` route to the SAME handler key. */
  platforms?: Record<string, (cwd: string, flags: Record<string, string>, positionals: string[], command: 'dev' | 'build') => Promise<void> | void>;
  /** Module packs injected by the host, applied BEFORE the app config's own `modulePacks` (so the app
   * can still override them, last-wins). */
  modulePacks?: string[];
  /** Extra runtime-template overlay roots, appended after the built-in template (later roots win). */
  templateRoots?: string[];
  /** Override for the desktop template dir. */
  desktopTemplateDir?: string;
}

/** The host composition for THIS run, set once by runCli. Empty by default → bare-bin behavior. */
let cliOptions: CliOptions = {};

/** This CLI's own published version — used to pin the `bunx @livx.cc/appwrap@^x.y.z` invocations the
 * emitted workflow runs. Pinning to THIS version's floor means CI fails LOUDLY ("version not found")
 * until that version is published, instead of bunx silently resolving an older published build that
 * lacks `release`/`init` flags. package.json sits one level above src/ (published) or the monorepo dir. */
const CLI_VERSION: string = (await import(resolve(import.meta.dir, '..', 'package.json'), { with: { type: 'json' } })).default.version;

// Load the capability manifest VALUES from the resolved runtime (pure data — safe outside NativeScript).
// Top-level await resolves before any command dispatches at the bottom of this file.
const { MODULES, OPTIONAL_GROUPS, LEGACY_BUNDLED_GROUPS, MANIFEST_SCHEMA_VERSION } = (await import(
  resolve(TEMPLATE_DIR, 'app/shell/capabilities.manifest')
)) as typeof CapManifest;

/** The composed module set for THIS command run: built-ins + the config's `modulePacks`, resolved once
 * at command entry by `applyModulePacks`. Stays `null` when NO packs are configured — every code path
 * then reads the built-in `MODULES` directly, so a pack-less build is byte-identical to pre-packs. */
let RESOLVED_MODULES: ResolvedModule[] | null = null;

/** The active module set the CLI derives from — merged (built-ins + packs) when packs are configured,
 * else the built-ins verbatim. */
function moduleList(): CapManifest.ModuleManifest[] {
  return RESOLVED_MODULES ? RESOLVED_MODULES.map((r) => r.manifest) : MODULES;
}

/** Pack provenance for a module name (source label + pack dir) — used by the generator to locate a
 * pack module's handler file + native source. Undefined for a built-in. */
function packInfo(name: string): { source: string; packDir: string } | undefined {
  const r = RESOLVED_MODULES?.find((m) => m.manifest.name === name);
  return r && r.packDir ? { source: r.source, packDir: r.packDir } : undefined;
}

/** Resolve the config's `modulePacks` (if any) into RESOLVED_MODULES for this run. No-op (leaves the
 * built-ins untouched → byte-identical) when the config declares no packs. Async because pack manifests
 * are dynamically imported; callers await it before the sync/regenerate pipeline. */
async function applyModulePacks(cwd: string, cfg: AppwrapConfig): Promise<void> {
  // Host-injected packs first (the host's), then the app config's — so the app can override, last-wins.
  const refs = [...(cliOptions.modulePacks ?? []), ...(cfg.modulePacks ?? [])];
  if (refs.length === 0) {
    RESOLVED_MODULES = null;
  } else {
    const ctx: SyncContext = {
      platform: 'both',
      env: process.env.APPWRAP_ENV || 'default',
      ci: !!process.env.CI,
    };
    const map = await resolveModulePacks({
      builtins: MODULES,
      builtinSchemaVersion: MANIFEST_SCHEMA_VERSION,
      packRefs: refs,
      ctx,
      cwd,
    });
    RESOLVED_MODULES = [...map.values()];
  }
  warnUnknownModules(cfg);
}

/** Warn (never fail) for any name in `modules` that resolves to neither a built-in nor a pack module —
 * with the pack model it's easy to list a capability (e.g. 'billing') and forget to add its pack to
 * `modulePacks`, which would otherwise silently no-op (no handler, no capability). */
function warnUnknownModules(cfg: AppwrapConfig): void {
  if (!cfg.modules) return;
  const known = new Set(moduleList().map((m) => m.name));
  for (const name of cfg.modules) {
    if (!known.has(name)) {
      console.warn(`⚠ module '${name}' is listed in \`modules\` but isn't a built-in or provided by any \`modulePacks\` — did you forget to add its pack? (ignored)`);
    }
  }
}

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
  androidManifestActivity: string[];  // raw XML injected inside the main <activity> (intent-filters)
  nativeSrc: string[];           // active BUILT-IN modules' nativeSrc dir names (under runtime/modules-native/)
  packNativeSrc: Array<{ name: string; srcDir: string }>;  // active PACK modules' native source (absolute src dirs)
  packHandlers: Array<{ name: string; source: string; packDir: string; file: string; fn: string }>; // active pack modules with a register handler (for the generated barrel + staging)
  packModules: Array<Pick<CapManifest.ModuleManifest, 'name' | 'core' | 'capabilities' | 'group'>>; // active pack modules' handshake-relevant subset (their capabilities aren't in the runtime's static MODULES)
}

function nativeReqs(cfg: AppwrapConfig): NativeReqs {
  const modules = moduleList();
  const optIn = modules.filter((m) => !m.core);
  // Legacy default (no `modules` key) = every opt-in capability EXCEPT strictly-opt-in own-file
  // modules (OPTIONAL_GROUPS, e.g. health): those carry deps/perms legacy won't stamp, so they must
  // be explicitly requested. Explicit mode = exactly what `modules` lists.
  const active = cfg.modules
    ? new Set(cfg.modules)
    : new Set(optIn.filter((m) =>
        !OPTIONAL_GROUPS.includes(m.group as (typeof OPTIONAL_GROUPS)[number]) ||
        LEGACY_BUNDLED_GROUPS.includes(m.group as (typeof LEGACY_BUNDLED_GROUPS)[number])
      ).map((m) => m.name));
  const activeMods = modules.filter((m) => m.core || active.has(m.name));

  const iosPlist: Array<{ key: string; usage: string }> = [];
  const seenKeys = new Set<string>();
  const androidPerms = new Set<string>();
  const gradle = new Set<string>();
  const iosEntitlements: Record<string, boolean | string | string[]> = {};
  const nativeSrc: string[] = [];
  const packNativeSrc: NativeReqs['packNativeSrc'] = [];
  const packHandlers: NativeReqs['packHandlers'] = [];
  const packModules: NativeReqs['packModules'] = [];
  const androidManifestApp: string[] = [];
  const androidManifestActivity: string[] = [];
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
      if (m.android?.manifestActivity) androidManifestActivity.push(m.android.manifestActivity);
      // built-in native source resolves under runtime/modules-native/; pack native source (below)
      // resolves under the pack's own dir, so it must not be conflated with the built-in dir names.
      if (m.nativeSrc && !packInfo(m.name)) nativeSrc.push(m.nativeSrc);
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

  // Active PACK modules (from the config's modulePacks) — their native source + register handler
  // resolve against the pack's own dir. No-op when no packs are configured (packInfo → undefined).
  for (const m of activeMods) {
    const info = packInfo(m.name);
    if (!info) continue;
    if (m.nativeSrc) packNativeSrc.push({ name: m.name, srcDir: join(info.packDir, 'native-src', m.nativeSrc) });
    if (m.handler) packHandlers.push({ name: m.name, source: info.source, packDir: info.packDir, file: m.handler.file, fn: m.handler.fn });
    // The runtime's static MODULES doesn't include pack modules, so their capabilities must be carried
    // into the generated handshake map explicitly (see generateModuleArtifacts + buildCapabilityMap).
    packModules.push({ name: m.name, core: m.core, capabilities: m.capabilities, group: m.group });
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
    androidManifestActivity,
    nativeSrc,
    packNativeSrc,
    packHandlers,
    packModules,
  };
}

/** Map a strippable optional group → its handler file + register fn (for the generated barrel). */
const OPTIONAL_GROUP_HANDLERS: Record<string, { file: string; fn: string }> = {
  oauth: { file: './handlers-oauth', fn: 'registerOAuthHandlers' },
  reviews: { file: './handlers-reviews', fn: 'registerReviewsHandlers' },
  scanner: { file: './handlers-scanner', fn: 'registerScannerHandlers' },
  speech: { file: './handlers-speech', fn: 'registerSpeechHandlers' },
  tracking: { file: './handlers-tracking', fn: 'registerTrackingHandlers' },
  appleSignIn: { file: './handlers-apple-signin', fn: 'registerAppleSignInHandlers' },
  backgroundTask: { file: './handlers-background', fn: 'registerBackgroundTaskHandlers' },
  shareTarget: { file: './handlers-share-target', fn: 'registerShareTargetHandlers' },
  // billing/health/widget live in host-provided module packs — a consumer opts in via modulePacks.
};

/** The bare specifier a pack handler uses to import a built-in shell API — rewritten to a relative
 * `./<mod>` when the file is staged next to the shell sources. A pack authored out-of-repo imports
 * e.g. `@livx.cc/appwrap/runtime/app/shell/bridge` (resolvable, since the npm package ships runtime/),
 * so it typechecks standalone; staging drops it beside the real shell files, where `./bridge` resolves. */
const SHELL_API_SPECIFIER = /(['"])@livx\.cc\/appwrap\/runtime\/app\/shell\//g;

/** Rewrite a pack handler's shell-API imports from the package specifier to relative, so the file
 * resolves once staged beside the real shell sources. Pure (exported for tests). */
export function rewritePackShellImports(src: string): string {
  return src.replace(SHELL_API_SPECIFIER, '$1./');
}

/** Resolve a pack-local relative import specifier to an absolute source file (trying the usual TS/JS
 * extensions + an index file), or null if it doesn't resolve to a real file. */
function resolvePackImport(fromDir: string, spec: string): string | null {
  const base = resolve(fromDir, spec);
  const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, join(base, 'index.ts'), join(base, 'index.js')];
  return cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Replace an exact (quoted) import specifier in source with another — anchored so `./x` never
 * partial-matches `./x-y`. Pure (exported for tests). */
export function replaceImportSpecifier(src: string, oldSpec: string, newSpec: string): string {
  const esc = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src.replace(new RegExp(`(['"])${esc}\\1`, 'g'), `$1${newSpec}$1`);
}

/** Stage a pack source file into the shell, namespaced `pack-<label>-<name>.ts` (never colliding with a
 * built-in file — keeps built-in staged filenames stable, preserving the byte-compare gate). Rewrites
 * (a) shell-API imports → relative `./<x>`, and (b) pack-LOCAL relative imports → their namespaced
 * staged sibling, staging each RECURSIVELY — so a handler's own helper modules (e.g. billing's
 * billing-offer.ts) are staged too. `staged` memoizes by abs path (dedup + cycle guard). `entryName`
 * overrides the staged basename for the handler entry (so the barrel imports it by module identity). */
function stagePackFile(shell: string, label: string, packDir: string, absFile: string, staged: Map<string, string>, entryName?: string): string {
  const cached = staged.get(absFile);
  if (cached) return cached;
  if (!existsSync(absFile)) {
    console.error(`✖ module pack "${label}": imported file not found: ${absFile}`);
    process.exit(1);
  }
  const name = entryName ?? basename(absFile).replace(/\.(tsx?|jsx?)$/, '');
  const destName = `pack-${label}-${name}.ts`;
  const spec = `./${destName.replace(/\.ts$/, '')}`;
  staged.set(absFile, spec); // set BEFORE recursing so an import cycle terminates

  let src = rewritePackShellImports(readFileSync(absFile, 'utf8'));
  const fromDir = dirname(absFile);
  for (const imp of new Bun.Transpiler({ loader: loaderForEntry(absFile) }).scanImports(src)) {
    if (!imp.path.startsWith('.')) continue; // only pack-LOCAL relative imports need staging
    const depAbs = resolvePackImport(fromDir, imp.path);
    if (!depAbs || !depAbs.startsWith(packDir + '/')) continue; // must stay inside the pack dir
    const depSpec = stagePackFile(shell, label, packDir, depAbs, staged);
    src = replaceImportSpecifier(src, imp.path, depSpec);
  }
  writeFileSync(join(shell, destName), src);
  return spec;
}

/** Stage a pack module's handler (+ its pack-local imports) into the shell. Returns the import
 * specifier the generated barrel imports the handler by. */
function stagePackHandler(shell: string, h: NativeReqs['packHandlers'][number]): string {
  const srcFile = resolve(h.packDir, h.file);
  if (!existsSync(srcFile)) {
    console.error(`✖ module pack "${h.source}": handler file not found: ${srcFile}`);
    process.exit(1);
  }
  const label = h.source.replace(/[^a-zA-Z0-9_-]/g, '_');
  const spec = stagePackFile(shell, label, h.packDir, srcFile, new Map(), h.name);
  console.log(`  pack ← ${h.source}  (${h.name} handler)`);
  return spec;
}

/** Generate the two composition artifacts in the wrapper: the active capability list (drives the
 * handshake map) and the optional-handler barrel (imports only active strippable groups). */
function generateModuleArtifacts(outDir: string, req: NativeReqs): void {
  const shell = join(outDir, 'app/shell');
  // Sweep stale pack-staged handlers first so a removed/renamed pack never leaves an orphan behind
  // (self-pruning, like regenerateMobilePlugins wiping its dir) — the active ones are re-staged below.
  for (const f of existsSync(shell) ? readdirSync(shell) : []) {
    if (f.startsWith('pack-') && f.endsWith('.ts')) rmSync(join(shell, f), { force: true });
  }
  writeFileSync(
    join(shell, 'active-modules.generated.ts'),
    `/** Generated by \`appwrap\` from the appwrap config \`modules\` + \`modulePacks\`. Do not edit. */\n` +
      `import type { ModuleManifest } from './capabilities.manifest';\n` +
      `export const ACTIVE_MODULE_NAMES: string[] = ${JSON.stringify(req.activeOptIn)};\n` +
      // Pack modules aren't in the runtime's static MODULES, so their handshake capabilities travel here
      // and buildCapabilityMap merges them (empty for a pack-less build).
      `export const PACK_MODULES: Array<Pick<ModuleManifest, 'name' | 'core' | 'capabilities' | 'group'>> = ${JSON.stringify(req.packModules)};\n`
  );

  const groups = req.activeOptionalGroups.filter((g) => OPTIONAL_GROUP_HANDLERS[g]);
  const importLines = groups.map((g) => `import { ${OPTIONAL_GROUP_HANDLERS[g].fn} } from '${OPTIONAL_GROUP_HANDLERS[g].file}';`);
  const callLines = groups.map((g) => `  ${OPTIONAL_GROUP_HANDLERS[g].fn}();`);
  // Active PACK modules with a register handler — staged into the shell + APPENDED after the built-in
  // groups (empty when no packs → byte-identical to the pre-packs barrel).
  for (const h of req.packHandlers) {
    const spec = stagePackHandler(shell, h);
    importLines.push(`import { ${h.fn} } from '${spec}';`);
    callLines.push(`  ${h.fn}();`);
  }
  const imports = importLines.join('\n');
  const calls = callLines.join('\n');
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

/** Make `cfg.plugins` LIVE for the MOBILE (NativeScript) shell — the in-process analog of the desktop
 * `regeneratePlugins`. There is no separate host on mobile (one WebView, the NS runtime IS the trusted
 * host), so a plugin's `handlers` register directly on the bridge at boot. For each configured plugin:
 * resolve the entry (path or npm), bun-build it to a single ESM bundle under
 * `native/app/shell/plugins/<id>.js` (definePlugin inlined; @nativescript/core externalized), emit a
 * typed `.d.ts` shim so the barrel type-checks, and generate `app/shell/plugins.generated.ts` that
 * imports + registers each. No plugins → rewrite the barrel to the committed no-op default and drop the
 * plugins dir, so a non-plugin build compiles NO plugin glue (parity with the module barrels).
 *
 * SKELETON scope: only `handlers` are consumed on mobile. `attachTo`/`onWindow`/`WindowCtx` are
 * desktop-only; a plugin declaring them still builds here (those fields are ignored).
 *
 * CROSS-LANE SKIP: a plugin that fails to resolve OR that pulls in a Node.js CORE module
 * (`net`/`fs`/`child_process`/…, unavailable in the NativeScript runtime) is skipped with a warning,
 * so a shared `plugins:[]` list genuinely builds on both lanes. The build alone is NOT enough to
 * decide this: `bun build --target=node` treats node builtins as valid passthrough externals, so a
 * desktop-only plugin importing `net` builds successfully and the incompatible `import "net"` lands
 * in the emitted bundle — which then breaks the NS webpack build. We therefore SCAN the plugin's
 * authored SOURCE for node-builtin imports/requires and skip on a hit (deterministic across import
 * styles). We scan the source (not the emitted bundle) on purpose: a raw-text/bundle scan false-
 * positives on (a) builtin specifiers that appear inside STRING LITERALS in a handler body, and (b)
 * bun's own `import { createRequire } from "node:module"` interop shim, which it injects into the
 * bundle for ANY CJS plugin — even one that only `require()`s the documented external
 * `@nativescript/core`. The source reflects the author's real imports; bun's shims do not.
 * KNOWN LIMITATION: only the ENTRY's own imports are scanned — a builtin pulled in TRANSITIVELY via a
 * dependency slips through and fails the NS webpack build later (loud, not silent). Acceptable at this
 * stage: it degrades in the right direction (a rare, self-announcing build error) vs the silent-drop a
 * bundle scan caused, and such a plugin is desktop-only by construction. Revisit with a resolve-graph
 * walk if transitive desktop deps become common. */
/** Node.js core module names (bare + `node:` forms) — anything here is unavailable in the NS runtime. */
const NODE_BUILTIN_SET = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** The distinct Node.js core modules a plugin's SOURCE actually imports/requires. Uses
 * `Bun.Transpiler.scanImports`, which returns only real import/require STATEMENTS (never a specifier
 * that merely appears inside a string literal), so a handler body containing `"x from 'fs'"` is not
 * flagged. Subpaths like `fs/promises` and the `node:` prefix are normalised to the base module
 * before the membership test. `loader` matches the source dialect (ts/tsx/js/jsx). */
function nodeBuiltinImports(src: string, loader: 'ts' | 'tsx' | 'js' | 'jsx'): string[] {
  const hits = new Set<string>();
  for (const { path } of new Bun.Transpiler({ loader }).scanImports(src)) {
    const base = path.replace(/^node:/, '').split('/')[0];
    if (NODE_BUILTIN_SET.has(path) || NODE_BUILTIN_SET.has(base)) hits.add(path);
  }
  return [...hits];
}

/** Map a plugin entrypoint's extension to the Bun.Transpiler loader for its source dialect. */
function loaderForEntry(entrypoint: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  const ext = extname(entrypoint).toLowerCase();
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts';
  return 'js';
}

export function regenerateMobilePlugins(cwd: string, cfg: AppwrapConfig, outDir: string): void {
  const shellDir = join(outDir, 'app/shell');
  const pluginsDir = join(shellDir, 'plugins');
  // Start clean: stale bundles from a previous config must not linger in the disposable native/.
  rmSync(pluginsDir, { recursive: true, force: true });

  const barrelPath = join(shellDir, 'plugins.generated.ts');
  const header = `/** Generated by \`appwrap\` from the appwrap config \`plugins\`. Do not edit. */\n`;
  const writeNoop = () => writeFileSync(barrelPath, `${header}export function registerPlugins(): void {\n}\n`);

  const entries = cfg.plugins ?? [];
  if (entries.length === 0) { writeNoop(); return; }

  mkdirSync(pluginsDir, { recursive: true });
  const bun = process.execPath; // the CLI runs under bun → the exact runtime to build with
  const imports: string[] = [];
  const calls: string[] = [];
  let idx = 0;
  for (const raw of entries) {
    const name = typeof raw === 'string' ? raw : raw.name;
    // Resolve: an existing path (relative to the app root) wins; else treat as an npm package name.
    let entrypoint = resolve(cwd, name);
    if (!existsSync(entrypoint)) {
      try {
        entrypoint = (Bun as unknown as { resolveSync(id: string, parent: string): string }).resolveSync(name, cwd);
      } catch {
        console.warn(`⚠ mobile plugin "${name}" not found (no such path, not resolvable as an npm package) — skipping.`);
        continue;
      }
    }
    const bundleId = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const outfile = join(pluginsDir, `${bundleId}.js`);
    // Cross-lane guard: a desktop-only plugin (importing net/fs/child_process/…) BUILDS fine here — node
    // builtins pass through as valid externals — so scan the plugin's SOURCE for real builtin imports and
    // skip on a hit, BEFORE building (no point bundling a plugin we'll drop).
    const nodeBuiltins = nodeBuiltinImports(readFileSync(entrypoint, 'utf8'), loaderForEntry(entrypoint));
    if (nodeBuiltins.length) {
      console.warn(`⚠ mobile plugin "${name}" imports Node.js core module(s) [${nodeBuiltins.join(', ')}] unavailable in the NativeScript runtime (desktop-only plugin on the mobile lane) — skipping.`);
      continue;
    }
    try {
      // ESM single-file so NS webpack bundles it; @nativescript/core stays external (provided by the shell).
      execFileSync(bun, ['build', entrypoint, '--format=esm', '--target=node', '--external=@nativescript/core', '--outfile', outfile], { stdio: 'pipe' });
    } catch (e: unknown) {
      console.warn(`⚠ mobile plugin bun-build failed (${name}): ${e instanceof Error ? e.message : String(e)} — skipping.`);
      continue;
    }
    // Typed shim so the generated barrel resolves the JS bundle's default export under tsc.
    writeFileSync(
      join(pluginsDir, `${bundleId}.d.ts`),
      `import type { MobilePluginDef } from '../plugin-host';\ndeclare const plugin: MobilePluginDef;\nexport default plugin;\n`
    );
    const ident = `plugin_${idx++}`;
    imports.push(`import ${ident} from './plugins/${bundleId}.js';`);
    calls.push(`  registerPluginHandlers(${ident});`);
    console.log(`  plugin ← ${name}  (mobile: handlers)`);
  }

  if (imports.length === 0) { writeNoop(); return; }
  writeFileSync(
    barrelPath,
    `${header}import { registerPluginHandlers } from './plugin-host';\n${imports.join('\n')}\n\n` +
      `export function registerPlugins(): void {\n${calls.join('\n')}\n}\n`
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
  const ent: Record<string, boolean | string | string[]> = { ...req.iosEntitlements, ...cfg.iosEntitlements };
  if (!!cfg.push?.enabled && cfg.push?.ios !== false) ent['aps-environment'] = cfg.push.apsEnvironment ?? 'development';
  // Resolve build tokens in entitlement values (e.g. a module's `__APP_GROUP__` → group.<appId>) so a
  // module declaring an app-derived entitlement (widget's App Group) needs no hardcoded stamper case.
  const tokens = buildTokens(cfg);
  for (const [k, v] of Object.entries(ent)) {
    if (typeof v === 'string') ent[k] = substituteBuildTokens(v, tokens);
    else if (Array.isArray(v)) ent[k] = v.map((x) => substituteBuildTokens(x, tokens));
  }
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

/** Stamp the App Tracking Transparency declarations into the store-readiness privacy manifest
 * (PrivacyInfo.xcprivacy). EXTENDS that single manifest — flips NSPrivacyTracking + fills
 * NSPrivacyTrackingDomains only when the `tracking` module is active, else leaves the template's
 * `false` + empty defaults. Idempotent both ways (a build that later drops the module resets them). */
function stampPrivacyManifest(outDir: string, cfg: AppwrapConfig, req: NativeReqs): void {
  const file = join(outDir, 'App_Resources/iOS/PrivacyInfo.xcprivacy');
  if (!existsSync(file)) return;
  const active = req.activeOptionalGroups.includes('tracking');
  const next = stampPrivacyTracking(readFileSync(file, 'utf8'), active, cfg.trackingDomains ?? []);
  writeFileSync(file, next);
  if (active) console.log(`  priv ← NSPrivacyTracking=true${cfg.trackingDomains?.length ? ` (${cfg.trackingDomains.length} domain${cfg.trackingDomains.length > 1 ? 's' : ''})` : ''}`);
}

/** Copy active modules' native source (runtime/modules-native/<name>/ for built-ins, <packDir>/
 * native-src/<name>/ for packs) into native/ — only when the module is active, so module native code
 * stays stripped from builds that don't use it. Returns the set of dest paths (relative to outDir) it
 * copied, so regenerateCore can prune a now-INACTIVE module's native files on re-sync (they mirror the
 * App_Resources layout and cpSync only overwrites, never deletes). */
function copyModuleNativeSrc(outDir: string, req: NativeReqs): Set<string> {
  const copied = new Set<string>();
  const copyFrom = (src: string, label: string) => {
    if (!existsSync(src)) { console.warn(`⚠ module nativeSrc not found: ${src}`); return; }
    cpSync(src, outDir, { recursive: true, force: true });
    for (const rel of collectRelFiles(src)) copied.add(rel);
    console.log(`  natv ← ${label} native source`);
  };
  for (const name of req.nativeSrc) copyFrom(join(MODULES_NATIVE_DIR, name), `module '${name}'`);
  for (const { name, srcDir } of req.packNativeSrc) copyFrom(srcDir, `pack module '${name}'`);
  return copied;
}

/** Build-time tokens a module's native source / entitlements may reference — resolved from the app
 * config so a module ships app-agnostic and the CLI stamps the app-specific value in. Not module-
 * specific: any module (built-in or pack) can use these tokens. `__APP_GROUP__` → the App Group id
 * shared by the app + an extension (e.g. widget, shareTarget); `__URL_SCHEME__` → config `urlScheme`
 * (the shareTarget extension forwards to the host app through it); `__APP_NAME__` → display name;
 * `__SHARE_SYNC_B64__` → base64(JSON) of `shareTarget.directSync` with defaults applied (empty =
 * direct sync off — base64 so arbitrary config JSON is safe inside a Swift string literal). */
function buildTokens(cfg: AppwrapConfig): Record<string, string> {
  return {
    __APP_GROUP__: `group.${cfg.id}`,
    __URL_SCHEME__: cfg.urlScheme ?? '',
    __APP_NAME__: cfg.name,
    __SHARE_SYNC_B64__: encodeShareDirectSync(cfg.shareTarget?.directSync),
  };
}

/** Substitute any {@link buildTokens} in a stamped string (entitlement value or native-source file). */
function substituteBuildTokens(s: string, tokens: Record<string, string>): string {
  let out = s;
  for (const [tok, val] of Object.entries(tokens)) out = out.replaceAll(tok, val);
  return out;
}

/** Substitute build-time tokens in copied module native source (after copyModuleNativeSrc) — applied
 * generically to every iOS extension file AND every Android module source file (Kotlin/Java/XML —
 * e.g. shareTarget's AppwrapShareActivity), so a module's app-agnostic source gets the app-specific
 * value stamped in. Idempotent (source is re-copied verbatim each sync, then re-substituted). */
function substituteModuleTokens(outDir: string, cfg: AppwrapConfig): void {
  const tokens = buildTokens(cfg);
  let touched = false;
  const subst = (file: string) => {
    const s = readFileSync(file, 'utf8');
    const next = substituteBuildTokens(s, tokens);
    if (next !== s) { writeFileSync(file, next); touched = true; }
  };
  const walk = (dir: string, exts: RegExp) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, exts);
      else if (exts.test(e.name)) subst(p);
    }
  };
  walk(join(outDir, 'App_Resources/iOS/extensions'), /\.(swift|entitlements|plist|json)$/);
  // Android module source: only java/ (module-owned code) — NOT the whole src/main (res/ + template
  // manifest have their own stamping and must not see generic token substitution).
  walk(join(outDir, 'App_Resources/Android/src/main/java'), /\.(kt|java|xml)$/);
  if (touched) console.log(`  tokn ← __APP_GROUP__ = ${tokens.__APP_GROUP__} (module native source)`);
}

/** Hosts to register as Android App Links (autoVerify https intent-filters). Explicit
 * `config.androidAppLinks` wins; otherwise derived from the iOS `associated-domains` `applinks:<host>`
 * entries so a single universal-link declaration covers both platforms. */
function androidAppLinkHosts(cfg: AppwrapConfig): string[] {
  if (cfg.androidAppLinks) return cfg.androidAppLinks.filter(Boolean);
  const ad = cfg.iosEntitlements?.['com.apple.developer.associated-domains'];
  const arr = Array.isArray(ad) ? ad : [];
  return arr
    .filter((d): d is string => typeof d === 'string' && d.startsWith('applinks:'))
    .map((d) => d.slice('applinks:'.length).split(/[?/]/)[0].trim())
    .filter(Boolean);
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

export async function loadConfig(cwd: string, flags: Record<string, string>): Promise<AppwrapConfig> {
  const configPath = resolveConfigPath(cwd, flags);
  if (!existsSync(configPath)) {
    console.error(`✖ Config not found — looked for ${CONFIG_CANDIDATES.join(' / ')} in ${cwd}`);
    process.exit(1);
  }
  const cfg = await readConfigFile(configPath);

  // Warn (never fail) on keys this appwrap doesn't recognize. A config authored for a NEWER appwrap
  // silently no-ops its unknown keys on an older install (e.g. `targetedDevices` before 0.39 → wrong
  // device family, no error). Turn that silent no-op into a signal.
  const stray = unknownConfigKeys(cfg as unknown as Record<string, unknown>);
  if (stray.length) {
    const ver = pkgVersion(resolve(import.meta.dir, '../package.json'));
    for (const k of stray) console.warn(`⚠ appwrap: unrecognized config key '${k}' — ignored. If you expect it to apply, your installed @livx.cc/appwrap (${ver}) may predate it — upgrade.`);
  }

  // Manifest as source: the appwrap config wins, the PWA manifest fills the gaps, template default last.
  // (DRY single-source — devs don't re-type identity already declared in the manifest.) See mergeManifest.
  if (cfg.pwaDist) mergeManifest(cfg, loadManifest(cwd, cfg));

  for (const key of ['id', 'name', 'version', 'pwaDist'] as const) {
    if (!cfg[key]) {
      console.error(`✖ config missing required field: ${key}` + (key === 'name' ? ' (and no name/short_name in the PWA manifest)' : ''));
      process.exit(1);
    }
  }

  // loader:'server' bakes serverUrl into the shell and loads it via NSURL/WKWebView. A scheme-less
  // value (e.g. "app.example.com") produces an unusable URL — the app silently fails to load (or
  // shows a stale page) with no error. Normalize to https:// when no scheme is present, and fail loud
  // on a genuinely malformed URL rather than shipping a broken build.
  if (cfg.serverUrl) {
    const raw = String(cfg.serverUrl).trim();
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      new URL(withScheme);
    } catch {
      console.error(`✖ invalid serverUrl: ${JSON.stringify(cfg.serverUrl)} — must be an absolute http(s) URL (e.g. https://app.example.com)`);
      process.exit(1);
    }
    if (withScheme !== raw) console.log(`  serverUrl ← ${withScheme} (added https:// — scheme was missing)`);
    cfg.serverUrl = withScheme;
  }

  return cfg;
}

export function stampShellConfig(outDir: string, cfg: AppwrapConfig): void {
  // Resolve the env-switcher block. Absent block OR `enabled:false` → the whole feature is inert
  // (the shell reads `envSwitcher.enabled`). `allowPattern`/`envs` default to empty (default-deny).
  const es = cfg.envSwitcher;
  const envSwitcher = {
    enabled: !!es && es.enabled !== false,
    envs: (es?.envs ?? []).map((e) => ({ label: String(e.label), url: String(e.url) })),
    allowPattern: es?.allowPattern ?? '',
  };
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
  urlScheme: ${JSON.stringify(cfg.urlScheme ?? '')},
  debug: ${JSON.stringify(cfg.debug ?? false)},
  debugLog: ${JSON.stringify(cfg.debugLog ?? '*')},
  devMenu: ${JSON.stringify(cfg.devMenu ?? true)},
  neutralizeServiceWorker: ${JSON.stringify(cfg.neutralizeServiceWorker ?? true)},
  appBoundDomains: ${JSON.stringify(cfg.appBoundDomains ?? [])} as string[],
  openNewWindowsInBrowser: ${JSON.stringify(cfg.openNewWindowsInBrowser ?? false)},
  pushIos: ${JSON.stringify(!!cfg.push?.enabled && cfg.push?.ios !== false)},
  pushAndroid: ${JSON.stringify(!!cfg.push?.enabled && cfg.push?.android !== false)},
  pushRegistrationUrl: ${JSON.stringify(cfg.push?.registrationUrl ?? '')},
  iosKeyboardExtraLift: ${JSON.stringify(cfg.iosKeyboardExtraLift ?? 82)},
  envSwitcher: ${JSON.stringify(envSwitcher)} as { enabled: boolean; envs: { label: string; url: string }[]; allowPattern: string },
};
`;
  writeFileSync(join(outDir, 'app/shell/config.ts'), content);
}

/** `deploy` (ios + android) stamps the shell with **`debug: true` FORCED, overriding your config**.
 *
 * This is INTENTIONAL and load-bearing: `deploy` is the local dev-install loop, and debug mode is what
 * enables keep-awake + the WebView inspector for continuous troubleshooting. `sync`, `release` and
 * `submit` all honour `cfg.debug` verbatim — `deploy` is the deliberate exception, not an oversight.
 *
 * ⚠️ THE TRAP: any feature gated on `SHELL_CONFIG.debug` is **unfalsifiable on a deployed build** — the
 * gate is always open, so "it worked when I deployed it" proves nothing about a real (`debug:false`)
 * build, and a debug-gated regression cannot reproduce here. To verify debug-gated behaviour, build via
 * `appwrap release` (which honours the config) — do NOT conclude from a `deploy` build.
 * Hence the printed line: the forcing must never be silent. */
function stampDeployShellConfig(outDir: string, cfg: AppwrapConfig): void {
  stampShellConfig(outDir, { ...cfg, debug: true });
  console.log(cfg.debug === false
    ? '  ⚠ deploy forces debug:true (keep-awake + WebView inspector) — OVERRIDING debug:false from your config.\n    debug-gated behaviour cannot be verified on this build; use `appwrap release` for that.'
    : '  ℹ debug:true — forced by deploy (keep-awake + WebView inspector); debug-gated code is always ON here.');
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

  // iOS App-Bound Domains — gate for a WKWebView service worker (paired with
  // limitsNavigationsToAppBoundDomains in the shell config). Idempotent both ways: empty/undefined
  // strips the WKAppBoundDomains key, so it no-ops when the field is absent.
  src = stampAppBoundDomains(src, cfg.appBoundDomains);

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
  // Communication Notifications (iOS 15+): an app that holds the `usernotifications.communication`
  // entitlement MUST also declare it supports donating these intents, or SpringBoard denies the
  // communication API at runtime ("has entitlement but does not support donating [INSendMessageIntent]")
  // and notifications fall back to a plain banner with the host app icon. native-kit's notification
  // identity path (INSendMessageIntent → communication notification) needs this to render the sender.
  if (cfg.iosEntitlements?.['com.apple.developer.usernotifications.communication']) {
    // ONLY the intents the shell actually donates: INSendMessageIntent (communication-notification
    // styling). Declaring INStartCallIntent in an app with no calling feature is an App Review flag.
    extras.push(`  <key>NSUserActivityTypes</key>\n  <array>\n    <string>INSendMessageIntent</string>\n  </array>`);
  }
  if (extras.length) {
    src = src.replace(
      /<\/dict>\s*<\/plist>\s*$/,
      `  <!-- appwrap:begin -->\n${extras.join('\n')}\n  <!-- appwrap:end -->\n</dict>\n</plist>\n`
    );
  }

  // UIBackgroundModes is opt-in per module/config (the template ships none). Toggle each mode in the
  // shared array — a second <key> would be a duplicate (invalid plist). Idempotent both ways: MERGE
  // in-place (creating the key when absent) if wanted, strip when not.
  const bgArray = /(<key>UIBackgroundModes<\/key>\s*<array>)([\s\S]*?)(<\/array>)/;
  const toggleBgMode = (s: string, mode: string, want: boolean): string => {
    const has = new RegExp(`<string>${mode}</string>`).test(s);
    if (want && !has) {
      return bgArray.test(s)
        ? s.replace(bgArray, (_m, open, inner, close) => `${open}${inner}\t<string>${mode}</string>\n\t${close}`)
        : s.replace(/<\/dict>\s*<\/plist>\s*$/, `  <key>UIBackgroundModes</key>\n  <array>\n    <string>${mode}</string>\n  </array>\n</dict>\n</plist>\n`);
    }
    if (!want && has) return s.replace(new RegExp(`\\s*<string>${mode}</string>`), '');
    return s;
  };
  // Remote push needs `remote-notification`; apps that genuinely play audio in the background opt in
  // via `backgroundAudio: true` (Apple 2.5.4 rejects `audio` without a real background-audio feature).
  src = toggleBgMode(src, 'remote-notification', !!cfg.push?.enabled && cfg.push?.ios !== false);
  src = toggleBgMode(src, 'audio', !!cfg.backgroundAudio);
  src = stripEmptyBackgroundModes(src);

  writeFileSync(plist, src);
}

/** Stamp each app extension's Info.plist CFBundleShortVersionString + CFBundleVersion to match the
 * main app (marketing version + monotonic build). App Store validation HARD-FAILS on a mismatch.
 * Extension Info.plists ship verbatim from overrides (NS never stamps them), so this MUST run AFTER
 * applyOverrides — same seam as stampManualSigning (an override would otherwise clobber the stamp). */
function stampIOSExtensionVersions(outDir: string, cfg: AppwrapConfig): void {
  const extRoot = join(outDir, 'App_Resources/iOS/extensions');
  if (!existsSync(extRoot)) return;
  const build = String(buildNumberOf(cfg));
  for (const ext of readdirSync(extRoot, { withFileTypes: true })) {
    if (!ext.isDirectory()) continue;
    const plist = join(extRoot, ext.name, 'Info.plist');
    if (!existsSync(plist)) continue;
    let src = readFileSync(plist, 'utf8');
    const stamp = (key: string, value: string) => {
      const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
      src = re.test(src) ? src.replace(re, `$1${value}$2`) : src;
    };
    stamp('CFBundleShortVersionString', cfg.version);
    stamp('CFBundleVersion', build);
    writeFileSync(plist, src);
  }
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

/** Profile kind, derived from the .mobileprovision payload: ProvisionsAllDevices → enterprise;
 * ProvisionedDevices + get-task-allow → development; ProvisionedDevices w/o it → adhoc; else appstore. */
type ProvKind = 'development' | 'adhoc' | 'enterprise' | 'appstore';

interface ProvProfile { name: string; uuid: string; teamId: string; bundleId: string; exp: number; kind: ProvKind }

/** Discover provisioning profiles installed on this machine (both the legacy MobileDevice dir and
 * the modern Xcode UserData dir). Each is decoded with `security cms` and reduced to the fields we
 * match on: profile Name, its TeamIdentifier, the bundle id (application-identifier minus the team
 * prefix), and expiration (ms epoch). Unreadable/legacy profiles are skipped. */
function findProvisioningProfiles(): ProvProfile[] {
  const dirs = [
    join(process.env.HOME ?? '', 'Library/MobileDevice/Provisioning Profiles'),
    join(process.env.HOME ?? '', 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
  ];
  // Dedup by UUID: the SAME profile commonly lives in BOTH dirs (Xcode copies from MobileDevice into
  // its UserData store) — without this, selectSigningProfile would see one profile as two and
  // spuriously prompt / warn of "ambiguity".
  const byUuid = new Map<string, ProvProfile>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.mobileprovision')); } catch { continue; }
    for (const f of files) {
      try {
        const raw = execFileSync('security', ['cms', '-D', '-i', join(dir, f)],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const name = raw.match(/<key>Name<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        const uuid = raw.match(/<key>UUID<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        const team = raw.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1];
        const appId = raw.match(/<key>application-identifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        const expStr = raw.match(/<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/)?.[1];
        if (!name || !uuid || !team || !appId || byUuid.has(uuid)) continue;
        // application-identifier is `<TEAM>.<bundle.id>`; strip the team prefix to get the bundle id.
        const bundleId = appId.startsWith(team + '.') ? appId.slice(team.length + 1) : appId;
        const kind: ProvKind = /<key>ProvisionsAllDevices<\/key>\s*<true\s*\/>/.test(raw) ? 'enterprise'
          : /<key>ProvisionedDevices<\/key>/.test(raw)
            ? (/<key>get-task-allow<\/key>\s*<true\s*\/>/.test(raw) ? 'development' : 'adhoc')
            : 'appstore';
        byUuid.set(uuid, { name, uuid, teamId: team, bundleId, exp: expStr ? Date.parse(expStr) : 0, kind });
      } catch { /* skip unreadable profile */ }
    }
  }
  return [...byUuid.values()];
}

/** Pick the provisioning-profile NAME to sign `bundleId` with, from the installed profiles for `teamId`.
 * Order: a valid pinned choice (cfg.signingProfiles) → the sole match → interactive pick (TTY, then
 * pinned) → newest-expiry (headless). Returns null when nothing matches (caller warns + skips). */
function selectSigningProfile(
  profiles: ProvProfile[], teamId: string, bundleId: string, cfg: AppwrapConfig,
  ctx?: { configPath: string }, kind: ProvKind | 'device' = 'device',
): string | null {
  const now = Date.now();
  // 'appstore' (store archive) must sign with an App Store distribution profile; 'device' (deploy)
  // must NOT — an appstore profile can't install on a device. Filtering here is what keeps ONE
  // signingProfiles pin map safe: a pin of the wrong kind simply doesn't match this lane.
  const kindOk = (p: ProvProfile): boolean => (kind === 'device' ? p.kind !== 'appstore' : p.kind === kind);
  const matches = profiles.filter((p) => p.teamId === teamId && p.bundleId === bundleId && p.exp > now && kindOk(p));
  if (matches.length === 0) return null;
  const pinned = cfg.signingProfiles?.[bundleId];
  if (pinned && matches.some((p) => p.name === pinned)) return pinned;
  if (matches.length === 1) return matches[0].name;
  // Ambiguous: prompt on a real TTY (and pin the choice), else deterministically take newest expiry.
  if (process.stdout.isTTY) {
    const sorted = [...matches].sort((a, b) => b.exp - a.exp);
    const idx = arrowSelect(`Multiple profiles for ${bundleId} — pick one to sign with:`,
      sorted.map((p) => `${p.name}  (expires ${new Date(p.exp).toISOString().slice(0, 10)})`));
    const chosen = sorted[idx].name;
    if (ctx) pinSigningProfileToConfig(ctx.configPath, bundleId, chosen);
    return chosen;
  }
  const newest = [...matches].sort((a, b) => b.exp - a.exp)[0];
  console.warn(`  ⚠ ${matches.length} profiles match ${bundleId}; using newest "${newest.name}" (pin one via signingProfiles to silence).`);
  return newest.name;
}

/** True if the persisted iOS project carries Manual / App-Store (match/fastlane) signing residue —
 * `CODE_SIGN_STYLE = Manual` or a `PROVISIONING_PROFILE_SPECIFIER`. `appwrap release/publish`
 * (fastlane `update_code_signing_settings`) writes these DIRECTLY into project.pbxproj, which NS
 * PRESERVES across prepares and which OVERRIDES build.xcconfig — so a later device `deploy`/`dev`
 * (auto lane) would inherit App-Store distribution signing and fail to install on a device. */
export function pbxHasManualSigningResidue(pbxSrc: string): boolean {
  return /^\s*CODE_SIGN_STYLE\s*=\s*Manual\s*;/m.test(pbxSrc)
    || /^\s*PROVISIONING_PROFILE_SPECIFIER\s*=/m.test(pbxSrc);
}

/** Rewrite App-Store/manual signing residue in a project.pbxproj back to Xcode AUTOMATIC signing:
 * Manual→Automatic, drop match/App-Store profile pins (PROVISIONING_PROFILE_SPECIFIER + UUID form),
 * and Apple Distribution→Apple Development (plain + `[sdk=…]` variants). DEVELOPMENT_TEAM is left as
 * is (correct for the current app). Pure + idempotent — a clean project passes through unchanged. */
export function resetPbxToAutomaticSigning(pbxSrc: string): string {
  let s = pbxSrc;
  s = s.replace(/(^\s*CODE_SIGN_STYLE\s*=\s*)Manual(\s*;)/mg, '$1Automatic$2');
  s = s.replace(/^[ \t]*PROVISIONING_PROFILE_SPECIFIER\s*=\s*[^;\n]*;[ \t]*\n?/mg, '');
  s = s.replace(/^[ \t]*PROVISIONING_PROFILE\s*=\s*[^;\n]*;[ \t]*\n?/mg, '');
  s = s.replace(/("?CODE_SIGN_IDENTITY(?:\[[^\]]*\])?"?\s*=\s*)"?Apple Distribution"?(\s*;)/mg, '$1"Apple Development"$2');
  return s;
}

/** Self-heal for the auto lane (`deploy`/`dev`, signing≠manual): if a prior `release`/`publish` left
 * Manual/App-Store signing in platforms/ios/project.pbxproj (fastlane `update_code_signing_settings`,
 * which NS preserves across prepares + which OVERRIDES build.xcconfig), rewrite it back to automatic
 * development signing IN PLACE. Surgical (no rebuild, deterministic — unlike wiping the platform dir,
 * which fights the build-cache skip). Keeps device installs working across lane/app switches; a normal
 * deploy with no residue is a no-op. */
function resetStaleSigningForAutoLane(outDir: string, cfg: AppwrapConfig): void {
  const mode = process.env.APPWRAP_SIGNING?.trim() || cfg.signing;
  if (mode === 'manual') return;
  const iosDir = join(outDir, 'platforms', 'ios');
  if (!existsSync(iosDir)) return;
  let proj: string | undefined;
  try { proj = readdirSync(iosDir).find((d) => d.endsWith('.xcodeproj') && d !== 'Pods.xcodeproj'); } catch { return; }
  if (!proj) return;
  const pbx = join(iosDir, proj, 'project.pbxproj');
  if (!existsSync(pbx)) return;
  const src = readFileSync(pbx, 'utf8');
  if (!pbxHasManualSigningResidue(src)) return;
  writeFileSync(pbx, resetPbxToAutomaticSigning(src));
  console.log('  ⚠ cleared stale manual/App-Store signing (from a prior `release`/`publish`) → automatic dev signing for this device build.');
}

/** Manual code-signing for device builds (`signing: 'manual'`). Resolves the app + each extension
 * target to an installed provisioning profile (by `<teamId>.<bundleId>`) and stamps Manual signing
 * into build.xcconfig (main app) + each extension's extension.json targetBuildConfigurationProperties.
 * This is what makes `appwrap deploy ios` provision extensions + special entitlements without an Xcode
 * GUI login. No-op unless signing==='manual'. iOS-only files; harmless on other platforms. */
function stampManualSigning(outDir: string, cfg: AppwrapConfig, ctx?: { configPath: string }): void {
  const mode = process.env.APPWRAP_SIGNING?.trim() || cfg.signing;
  if (mode !== 'manual') {
    // Not manual → tear down any artifacts a PREVIOUS manual run left in native/ (it isn't fully
    // wiped on sync), so `deploy` doesn't keep passing a now-stale --provision / export map.
    for (const p of ['.appwrap-signing.json', 'hooks/after-prepare/appwrap-signing.js', 'App_Resources/iOS/extensions/provisioning.json']) {
      const f = join(outDir, p);
      if (existsSync(f)) rmSync(f, { force: true });
    }
    return;
  }
  const teamId = cfg.teamId;
  if (!teamId || /YOUR_APPLE_TEAM_ID|^$/.test(teamId)) {
    console.warn('  ⚠ signing: manual but teamId is unset — skipping manual signing.');
    return;
  }
  // Store archives (`appwrap build ios --release`) sign with App Store distribution profiles +
  // "Apple Distribution"; device deploys with development/adhoc profiles + "Apple Development".
  // A signing-DISABLED archive that's re-signed at exportArchive gets its entitlements SYNTHESIZED
  // from the profile (dropping app.entitlements — e.g. declared-age-range); signing the archive
  // itself is what preserves them, so the store lane rides this same manual stamp.
  const kind: ProvKind | 'device' = process.env.APPWRAP_SIGNING_KIND === 'appstore' ? 'appstore' : 'device';
  const identity = kind === 'appstore' ? 'Apple Distribution' : 'Apple Development';
  // Don't pin interactive picks from the store lane — the single signingProfiles map is keyed by
  // bundle id only, so a store pin would clobber the device pin (and vice versa).
  const pinCtx = kind === 'device' ? ctx : undefined;
  const profiles = findProvisioningProfiles();
  let mainProvision: string | null = null;

  // Main app target → build.xcconfig.
  const xcconfig = join(outDir, 'App_Resources/iOS/build.xcconfig');
  if (existsSync(xcconfig)) {
    const name = selectSigningProfile(profiles, teamId, cfg.id, cfg, pinCtx, kind);
    if (!name) {
      // Store lane must NOT fall through to automatic signing: an unsigned archive gets its
      // entitlements re-synthesized from the profile at export, silently dropping any
      // config-stamped entitlement (the declared-age-range failure this lane exists to prevent).
      if (kind === 'appstore') {
        console.error(`  ✗ no valid App Store distribution profile for ${cfg.id} (team ${teamId}). Install one (ASC → Profiles) or seed via Xcode, then retry.`);
        process.exit(1);
      }
      console.warn(`  ⚠ no valid profile for ${cfg.id} (team ${teamId}) — automatic signing will run. Install one or seed via Xcode.`);
    } else {
      mainProvision = name;
      let src = readFileSync(xcconfig, 'utf8');
      const setKey = (s: string, key: string, val: string): string =>
        // Anchored + multiline so we never rewrite the commented `// CODE_SIGN_IDENTITY = …` template line.
        new RegExp(`^\\s*${key}\\s*=`, 'm').test(s)
          ? s.replace(new RegExp(`^\\s*${key}\\s*=\\s*[^;\\n]*;?`, 'm'), `${key} = ${val};`)
          : s + `\n${key} = ${val};`;
      src = setKey(src, 'CODE_SIGN_STYLE', 'Manual');
      src = setKey(src, 'CODE_SIGN_IDENTITY', identity);
      src = setKey(src, 'PROVISIONING_PROFILE_SPECIFIER', name);
      writeFileSync(xcconfig, src.endsWith('\n') ? src : src + '\n');
      console.log(`  sign ← ${cfg.id} → "${name}" (manual, ${identity})`);
    }
  }

  // Extension targets (bundle id = <appId>.<Name>). extension.json CAN'T carry the signing: NS's
  // prepareSigning runs AFTER it and force-propagates the MAIN app's signing onto every extension
  // (clobbering the team/profile — and an extension needs a DIFFERENT profile than the app). So we
  // install an after-prepare hook that stamps each extension target's signing into project.pbxproj
  // LAST, after NS is done. Same seam StoreKit wiring uses.
  const extRoot = join(outDir, 'App_Resources/iOS/extensions');
  const extEntries: Array<{ bundleId: string; profile: string }> = [];
  if (existsSync(extRoot)) {
    for (const ext of readdirSync(extRoot, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      if (!existsSync(join(extRoot, ext.name, 'extension.json'))) continue;
      const extBundle = `${cfg.id}.${ext.name}`;
      const name = selectSigningProfile(profiles, teamId, extBundle, cfg, pinCtx, kind);
      if (!name) { console.warn(`  ⚠ no valid profile for extension ${extBundle} — it may fail to sign.`); continue; }
      extEntries.push({ bundleId: extBundle, profile: name });
      console.log(`  sign ← ${extBundle} → "${name}" (manual, via hook)`);
    }
  }
  const hookDir = join(outDir, 'hooks/after-prepare');
  const hookFile = join(hookDir, 'appwrap-signing.js');
  if (extEntries.length) {
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(hookFile, SIGNING_HOOK(teamId, extEntries, identity));
    // NS's exportOptions reads extension profiles from this file (extensions/provisioning.json) —
    // it maps each extension bundle id → profile name so `xcodebuild -exportArchive` can build the .ipa.
    writeFileSync(join(extRoot, 'provisioning.json'),
      JSON.stringify(Object.fromEntries(extEntries.map((e) => [e.bundleId, e.profile])), null, 2) + '\n');
  } else {
    // No extensions to sign → clear any hook / provisioning map a prior run left behind.
    if (existsSync(hookFile)) rmSync(hookFile, { force: true });
    const provJson = join(extRoot, 'provisioning.json');
    if (existsSync(provJson)) rmSync(provJson, { force: true });
  }

  // Sidecar the resolved main-app profile so the device-build step can pass `ns build … --provision
  // <name>` — that's the switch that makes NS emit a manual-signing exportOptions.plist (with the app
  // AND each extension's provisioningProfiles) for `xcodebuild -exportArchive`. Without it the export
  // has no profile map and fails even though the archive signed fine.
  const sidecar = join(outDir, '.appwrap-signing.json');
  if (mainProvision) writeFileSync(sidecar, JSON.stringify({ provision: mainProvision }) + '\n');
  else if (existsSync(sidecar)) rmSync(sidecar, { force: true });
}

/** After-prepare hook source: stamps manual signing into each extension target's build settings in
 * project.pbxproj — run AFTER `ns prepare` (hence after NS's prepareSigning), so it's the final word.
 * Self-contained (no deps), zero-arg (NS DI won't choke). Per extension it upserts DEVELOPMENT_TEAM,
 * PROVISIONING_PROFILE_SPECIFIER, CODE_SIGN_STYLE=Manual, CODE_SIGN_IDENTITY in every buildSettings
 * block whose PRODUCT_BUNDLE_IDENTIFIER matches the extension's bundle id. */
const SIGNING_HOOK = (team: string, entries: Array<{ bundleId: string; profile: string }>, identity = 'Apple Development') => `// Generated by \`appwrap\` — stamps manual signing onto extension targets in project.pbxproj.
const fs = require('fs');
const path = require('path');
const TEAM = ${JSON.stringify(team)};
const ENTRIES = ${JSON.stringify(entries)};
const IDENTITY = ${JSON.stringify(identity)};
module.exports = function () {
  const iosDir = path.join(__dirname, '..', '..', 'platforms', 'ios');
  if (!fs.existsSync(iosDir)) return;
  const projDir = fs.readdirSync(iosDir).find((d) => d.endsWith('.xcodeproj') && d !== 'Pods.xcodeproj');
  if (!projDir) return;
  const pbx = path.join(iosDir, projDir, 'project.pbxproj');
  if (!fs.existsSync(pbx)) return;
  let src = fs.readFileSync(pbx, 'utf8');
  const q = (v) => (/\\s/.test(v) ? '"' + v + '"' : v);
  // Upsert a key inside one buildSettings block: replace its line if present, else insert after
  // PRODUCT_BUNDLE_IDENTIFIER. Also strips PROVISIONING_PROFILE (UUID form) to avoid a stale mismatch.
  const upsert = (block, key, val) => {
    const re = new RegExp('(^\\\\s*)' + key + '\\\\s*=\\\\s*[^;\\\\n]*;', 'm');
    if (re.test(block)) return block.replace(re, (_m, indent) => indent + key + ' = ' + val + ';');
    return block.replace(/(^(\\s*)PRODUCT_BUNDLE_IDENTIFIER\\s*=\\s*[^;\\n]*;)/m,
      (m, _l, indent) => m + '\\n' + indent + key + ' = ' + val + ';');
  };
  for (const { bundleId, profile } of ENTRIES) {
    // Each XCBuildConfiguration's buildSettings block (Debug + Release) for this extension target.
    src = src.replace(/buildSettings = \\{[\\s\\S]*?\\n(\\t*)\\};/g, (block) => {
      const bidRe = new RegExp('PRODUCT_BUNDLE_IDENTIFIER\\\\s*=\\\\s*"?' + bundleId.replace(/[.]/g, '\\\\.') + '"?;');
      if (!bidRe.test(block)) return block;
      block = block.replace(/^\\s*PROVISIONING_PROFILE\\s*=\\s*[^;\\n]*;\\n?/m, '');
      block = upsert(block, 'CODE_SIGN_STYLE', 'Manual');
      block = upsert(block, 'DEVELOPMENT_TEAM', TEAM);
      block = upsert(block, 'CODE_SIGN_IDENTITY', q(IDENTITY));
      block = upsert(block, 'PROVISIONING_PROFILE_SPECIFIER', q(profile));
      return block;
    });
  }
  fs.writeFileSync(pbx, src);
  console.log('  appwrap: manual signing stamped for ' + ENTRIES.map((e) => e.bundleId).join(', '));
};
`;

/** Persist a manual-signing profile choice (bundle id → profile name) so an ambiguous match isn't
 * re-prompted. JSON configs are updated structurally; TS/JS get a best-effort inserted line (a hint
 * is printed if the shape is unfamiliar — the deterministic newest-expiry pick still works meanwhile). */
function pinSigningProfileToConfig(configPath: string, bundleId: string, profileName: string): void {
  if (!existsSync(configPath)) return;
  const src = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.json')) {
    try {
      const obj = JSON.parse(src) as Record<string, unknown>;
      const map = (obj.signingProfiles as Record<string, string>) ?? {};
      map[bundleId] = profileName;
      obj.signingProfiles = map;
      writeFileSync(configPath, JSON.stringify(obj, null, 2) + (src.endsWith('\n') ? '\n' : ''));
      console.log(`  ✓ pinned signingProfiles['${bundleId}'] = '${profileName}'`);
    } catch { /* leave untouched */ }
    return;
  }
  if (/\bsigningProfiles\s*:/.test(src)) {
    console.log(`  ⓘ add '${bundleId}': '${profileName}' to signingProfiles in ${configPath} to silence this prompt.`);
    return;
  }
  const anchor = /^([ \t]*)(signing|id)\s*:\s*(['"`])[^'"`]*\3\s*,?[ \t]*$/m;
  const m = anchor.exec(src);
  if (!m) { console.log(`  ⓘ set signingProfiles: { '${bundleId}': '${profileName}' } in ${configPath} to silence this prompt.`); return; }
  const indent = m[1];
  const next = src.slice(0, m.index + m[0].length)
    + `\n${indent}signingProfiles: { '${bundleId}': '${profileName}' },`
    + src.slice(m.index + m[0].length);
  writeFileSync(configPath, next);
  console.log(`  ✓ pinned signingProfiles['${bundleId}'] = '${profileName}' in ${configPath}`);
}

/** Stamp TARGETED_DEVICE_FAMILY into build.xcconfig from cfg.targetedDevices. `'iphone'` → `1`
 * (iPhone-only → UIDeviceFamily=[1], so the App Store doesn't require iPad screenshots);
 * `'universal'`/unset → `1,2` (NativeScript's default). Idempotent: replaces any prior value. */
function stampDeviceFamily(outDir: string, cfg: AppwrapConfig): void {
  const xcconfig = join(outDir, 'App_Resources/iOS/build.xcconfig');
  if (!existsSync(xcconfig)) return;
  const value = cfg.targetedDevices === 'iphone' ? '1' : '1,2';
  let src = readFileSync(xcconfig, 'utf8');
  src = /TARGETED_DEVICE_FAMILY\s*=/.test(src)
    ? src.replace(/TARGETED_DEVICE_FAMILY\s*=\s*[^;\n]*;?/, `TARGETED_DEVICE_FAMILY = ${value};`)
    : src + `\nTARGETED_DEVICE_FAMILY = ${value};\n`;
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
  // Write res/values/strings.xml defining app_name = cfg.name. The NS template ships NO strings.xml
  // (the default app_name/activity title resolve to "native" from @nativescript/core), so a regex
  // replace was a no-op and the launcher showed "native". Write the file so app_name is authoritative
  // (the manifest's <application> AND launcher <activity> both label off @string/app_name). XML-escape.
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stringsDir = join(outDir, 'App_Resources/Android/src/main/res/values');
  mkdirSync(stringsDir, { recursive: true });
  writeFileSync(
    join(stringsDir, 'strings.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">${esc(cfg.name)}</string>\n    <string name="title_activity_kimera">${esc(cfg.name)}</string>\n</resources>\n`
  );
  const manifest = join(outDir, 'App_Resources/Android/src/main/AndroidManifest.xml');
  if (existsSync(manifest)) {
    let src = readFileSync(manifest, 'utf8');
    if (cfg.urlScheme) src = src.replace(/android:scheme="[^"]*"/, `android:scheme="${cfg.urlScheme}"`);
    // Extra OAuth redirect schemes (e.g. Google's `com.googleusercontent.apps.<client>`) as additional
    // BROWSABLE <data> on the deep-link filter, so the Custom Tab redirect re-enters the app instead of
    // web-searching an unhandled scheme. Idempotent marker → re-sync-safe. See config.oauthRedirectSchemes.
    {
      const extra = (cfg.oauthRedirectSchemes ?? []).filter(Boolean);
      const body = extra.map((s) => `\n\t\t\t<data android:scheme="${esc(s)}" />`).join('') + (extra.length ? '\n\t\t\t' : '');
      src = src.replace(
        /<!-- appwrap:oauth-redirect-schemes -->[\s\S]*?<!-- \/appwrap:oauth-redirect-schemes -->/,
        `<!-- appwrap:oauth-redirect-schemes -->${body}<!-- /appwrap:oauth-redirect-schemes -->`
      );
    }
    // App Links: an `android:autoVerify="true"` VIEW intent-filter per https host, so `https://<host>/…`
    // links open the app directly (Android's Universal-Links equivalent). Hosts come from
    // config.androidAppLinks or, unset, the iOS associated-domains applinks (one declaration → both
    // platforms). The host must ALSO serve /.well-known/assetlinks.json (package + signing SHA-256) for
    // Android to verify the association. Idempotent marker → re-sync-safe.
    {
      const hosts = androidAppLinkHosts(cfg);
      const filter = (h: string) =>
        `<intent-filter android:autoVerify="true">\n\t\t\t<action android:name="android.intent.action.VIEW" />\n` +
        `\t\t\t<category android:name="android.intent.category.DEFAULT" />\n` +
        `\t\t\t<category android:name="android.intent.category.BROWSABLE" />\n` +
        `\t\t\t<data android:scheme="https" android:host="${esc(h)}" />\n\t\t</intent-filter>`;
      const body = hosts.length ? '\n\t\t' + hosts.map(filter).join('\n\t\t') + '\n\t\t' : '';
      src = src.replace(
        /<!-- appwrap:app-links -->[\s\S]*?<!-- \/appwrap:app-links -->/,
        `<!-- appwrap:app-links -->${body}<!-- /appwrap:app-links -->`
      );
      if (hosts.length) console.log(`  alnk ← Android App Links: ${hosts.join(', ')}`);
    }
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
    // Main-<activity> XML from active modules (e.g. shareTarget's ACTION_SEND filter) — idempotent marker.
    src = src.replace(
      /<!-- appwrap:activity -->[\s\S]*?<!-- \/appwrap:activity -->/,
      `<!-- appwrap:activity -->\n\t\t${req.androidManifestActivity.join('\n\t\t')}\n\t\t<!-- /appwrap:activity -->`
    );
    // <queries> for kit.app.canOpenUrl() visibility probes (API 30+) — idempotent marker. queryPackages
    // → explicit <package>; queryUrlSchemes → a VIEW <intent> per scheme (symmetric with iOS's
    // LSApplicationQueriesSchemes). See stampAndroidQueries.
    src = stampAndroidQueries(src, cfg.queryPackages, cfg.queryUrlSchemes);
    writeFileSync(manifest, src);
  }
}

/** Google Play's hard versionCode ceiling (a 32-bit int, but Play caps it here). */
const ANDROID_VERSION_CODE_MAX = 2_100_000_000;

/** Android versionCode must fit ANDROID_VERSION_CODE_MAX. The default 'timestamp' build strategy yields
 * a 10-digit YYMMDDHHMM (~2.6e9) that's fine for iOS's CFBundleVersion but OVERFLOWS here — gradle then
 * fails cryptically ("app.gradle … Value is null") on every local `appwrap deploy android`. When the
 * resolved build exceeds the cap, fall back to unix-epoch seconds (~1.78e9, monotonic, Android-safe).
 * CI passes an explicit small APPWRAP_BUILD_NUMBER, so it never trips this. */
function androidVersionCodeOf(cfg: AppwrapConfig): number {
  const n = buildNumberOf(cfg);
  if (n <= ANDROID_VERSION_CODE_MAX) return n;
  const safe = Math.floor(Date.now() / 1000);
  console.warn(`  ⚠ build ${n} exceeds Android's versionCode cap (${ANDROID_VERSION_CODE_MAX}); using epoch ${safe}. Set APPWRAP_BUILD_NUMBER for a deterministic value.`);
  return safe;
}

/** Stamp Android marketing version (versionName) + monotonic build (versionCode) into app.gradle. */
function stampAndroidVersion(outDir: string, cfg: AppwrapConfig): void {
  const gradle = join(outDir, 'App_Resources/Android/app.gradle');
  if (!existsSync(gradle)) return;
  let src = readFileSync(gradle, 'utf8');
  src = src.replace(/versionCode\s+\d+/, `versionCode ${androidVersionCodeOf(cfg)}`);
  src = src.replace(/versionName\s+"[^"]*"/, `versionName "${cfg.version}"`);
  writeFileSync(gradle, src);
}

/** Locate the icon source: explicit cfg.icon, else the largest icon in the PWA manifest. */
export function findIconSource(cwd: string, cfg: AppwrapConfig): string | null {
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

/** Square-resize/probe abstraction over `sips` (macOS) or ImageMagick (`magick` v7 / `convert` v6),
 * so icon generation works on Linux/CI too — not just macOS. Returns null if neither tool is present. */
function imageRasterizer(): { width: (src: string) => number; resize: (src: string, px: number, dest: string) => void } | null {
  // Probe by RUNNING the tool, not by PATH lookup. `which`/`Bun.which` both consult process.env.PATH,
  // which can be undefined under some Bun launch contexts (observed: PATH unset yet `sips` still execs
  // fine via the OS default path) → PATH-based detection returned false and silently shipped the
  // NativeScript template icon. execFileSync resolves + runs the binary the same way the actual
  // resize/probe calls below do, so detection and invocation always agree. ENOENT = absent; any other
  // failure (e.g. bad flag, nonzero exit) means the binary IS present.
  const has = (cmd: string) => {
    try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; }
    catch (e) { return (e as { code?: string }).code !== 'ENOENT'; }
  };
  if (has('sips')) {
    return {
      width: (src) => parseInt(execFileSync('sips', ['-g', 'pixelWidth', src]).toString().match(/(\d+)\s*$/)?.[1] ?? '0', 10),
      resize: (src, px, dest) => execFileSync('sips', ['-z', String(px), String(px), src, '--out', dest], { stdio: 'ignore' }),
    };
  }
  const magick = has('magick') ? 'magick' : has('convert') ? 'convert' : null;
  if (magick) {
    // v7: `magick identify` / `magick <src> -resize`. v6: `identify` / `convert <src> -resize`. `!` forces exact (square) dims.
    return {
      width: (src) => {
        const args = magick === 'magick' ? ['identify', '-format', '%w', src] : ['-format', '%w', src];
        const bin = magick === 'magick' ? 'magick' : 'identify';
        return parseInt(execFileSync(bin, args).toString().trim() || '0', 10);
      },
      resize: (src, px, dest) => execFileSync(magick, [src, '-resize', `${px}x${px}!`, dest], { stdio: 'ignore' }),
    };
  }
  return null;
}

/** Generate iOS appiconset + Android mipmaps from the PWA's icon (via sips on macOS or ImageMagick on CI). */
function generateIcons(cwd: string, outDir: string, cfg: AppwrapConfig): void {
  const source = findIconSource(cwd, cfg);
  if (!source) {
    console.warn('⚠ No app icon source found (manifest icons or config `icon`) — keeping template icons');
    return;
  }
  // Pick an image rasterizer: `sips` (macOS) OR ImageMagick (`magick` v7 / `convert` v6) so icons are
  // generated on Linux/CI too (GitHub ubuntu runners ship ImageMagick) — NOT just macOS. Previously CI
  // skipped icon gen entirely → the default NativeScript "N" icon shipped. If NEITHER tool exists, keep
  // the template icons rather than failing the build.
  const ras = imageRasterizer();
  if (!ras) {
    console.warn('⚠ no image tool (sips / ImageMagick) — keeping template icons; install ImageMagick or build on macOS');
    return;
  }
  const w = ras.width(source);
  if (w && w < 512) console.warn(`⚠ Icon source is ${w}px — below the 512px App Store minimum (using it anyway)`);

  const resize = (px: number, dest: string) => ras.resize(source, px, dest);

  const iconset = join(outDir, 'App_Resources/iOS/Assets.xcassets/AppIcon.appiconset');
  if (existsSync(iconset)) {
    const contents = JSON.parse(readFileSync(join(iconset, 'Contents.json'), 'utf8'));
    for (const img of contents.images as Array<{ size: string; scale: string; filename: string }>) {
      const px = Math.round(parseFloat(img.size) * parseFloat(img.scale));
      resize(px, join(iconset, img.filename));
    }
  }

  // iOS launch screen: stamp the centered splash logo — ONLY from an explicit `splashIcon`
  // (a transparent-bg wordmark/glyph). NOT the app icon: an icon carries its own opaque background,
  // which would render as an ugly box floating on the solid splash. Without `splashIcon` the Center
  // layer is blanked in stampLaunchScreen → clean solid-backgroundColor splash, no logo. Square, ~220pt.
  if (cfg.splashIcon) {
    const splashSrc = resolve(cwd, cfg.splashIcon);
    const centerSet = join(outDir, 'App_Resources/iOS/Assets.xcassets/LaunchScreen.Center.imageset');
    if (!existsSync(splashSrc)) {
      console.warn(`⚠ config \`splashIcon\` not found: ${splashSrc} — splash will be a plain background`);
    } else if (existsSync(join(centerSet, 'Contents.json'))) {
      const c = JSON.parse(readFileSync(join(centerSet, 'Contents.json'), 'utf8'));
      for (const img of c.images as Array<{ scale: string; filename: string }>) {
        ras.resize(splashSrc, Math.round(220 * parseFloat(img.scale)), join(centerSet, img.filename));
      }
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
    const resizeFrom = (src: string, px: number, dest: string) => ras.resize(src, px, dest);
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

/** De-NativeScript the launch screen: blank the iOS NS-blue AspectFill layer (UNCONDITIONAL — the
 * default must never ship), then tint the iOS storyboard + Android splash to the app's backgroundColor. */
function stampLaunchScreen(outDir: string, cfg: AppwrapConfig): void {
  // iOS: blank the full-screen AspectFill layer FIRST, regardless of backgroundColor. The template
  // ships the default NativeScript-blue background bitmap there, which paints OVER the storyboard
  // background → the tint (and any brand color) is invisible and every app shows the NS splash.
  // Overwrite those rasters with a 1×1 transparent pixel so the storyboard's solid background shows
  // through; the centered app-icon logo (branded in generateIcons) sits on top. Tool-free (no
  // sips/magick → works on any CI).
  const TRANSPARENT_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const blankImageset = (name: string): void => {
    const set = join(outDir, `App_Resources/iOS/Assets.xcassets/${name}.imageset`);
    if (!existsSync(join(set, 'Contents.json'))) return;
    const c = JSON.parse(readFileSync(join(set, 'Contents.json'), 'utf8'));
    for (const img of c.images as Array<{ filename: string }>) writeFileSync(join(set, img.filename), TRANSPARENT_PNG);
  };
  blankImageset('LaunchScreen.AspectFill');
  // Blank the centered NS wordmark too → clean solid-color splash. generateIcons repaints Center from
  // `splashIcon` AFTER this (it runs later in regenerateCore), so an opted-in logo survives.
  blankImageset('LaunchScreen.Center');

  if (!cfg.backgroundColor) return;
  const hex = cfg.backgroundColor.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return;

  // iOS: tint the storyboard launch background.
  const storyboard = join(outDir, 'App_Resources/iOS/LaunchScreen.storyboard');
  if (existsSync(storyboard)) {
    const ch = (i: number) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4);
    const src = readFileSync(storyboard, 'utf8').replace(
      /<color key="backgroundColor"[^/]*\/>/g,
      `<color key="backgroundColor" red="${ch(0)}" green="${ch(2)}" blue="${ch(4)}" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>`
    );
    writeFileSync(storyboard, src);
  }

  // Android: replace the default NativeScript splash (background bitmap + NS logo) with a solid fill
  // of the app's backgroundColor — parity with the iOS solid launch screen, and no NS branding flash.
  const splash = join(outDir, 'App_Resources/Android/src/main/res/drawable-nodpi/splash_screen.xml');
  if (existsSync(splash)) {
    writeFileSync(splash,
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<layer-list xmlns:android="http://schemas.android.com/apk/res/android" android:gravity="fill">\n` +
      `    <item>\n` +
      `        <shape android:shape="rectangle">\n` +
      `            <solid android:color="#${hex.toUpperCase()}" />\n` +
      `        </shape>\n` +
      `    </item>\n` +
      `</layer-list>\n`
    );
  }
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
export function applyOverrides(cwd: string, outDir: string, cfg: AppwrapConfig): void {
  const dir = resolve(cwd, cfg.overrides ?? 'appwrap.overrides');
  // Files the template still provides must survive an override removal (regenerateCore ran first and
  // re-copied them) → protect them from the override prune.
  const templateFiles = allTemplateFiles();
  // ACTIVE modules' native source needs the SAME protection: copyModuleNativeSrc re-copied it into
  // these exact relative paths, but it lives under runtime/modules-native/<name>/, which
  // templateCopyFilter deliberately excludes — so it is absent from templateFiles above. Without this,
  // dropping a consumer override that happened to shadow a module file prunes the MODULE's own copy
  // too (the prune only sees "was in the overrides manifest, isn't in overrides now"), silently
  // deleting e.g. res/xml/appwrap_widget_info.xml and failing the build at AAPT.
  const reqs = nativeReqs(cfg);
  for (const name of reqs.nativeSrc) {
    const modDir = join(MODULES_NATIVE_DIR, name);
    if (existsSync(modDir)) for (const rel of collectRelFiles(modDir)) templateFiles.add(rel);
  }
  // Same protection for active PACK modules' native source (lives under the pack dir, absent from the
  // template file set) — so an override removal never prunes a pack module's own copied files.
  for (const { srcDir } of reqs.packNativeSrc) {
    if (existsSync(srcDir)) for (const rel of collectRelFiles(srcDir)) templateFiles.add(rel);
  }
  if (!existsSync(dir)) {
    // No overrides now: prune anything a PRIOR overrides run left behind (renamed/removed override files).
    pruneStale(outDir, OVERRIDES_MANIFEST, new Set(), templateFiles);
    return;
  }
  cpSync(dir, outDir, { recursive: true, force: true });
  pruneStale(outDir, OVERRIDES_MANIFEST, collectRelFiles(dir), templateFiles);
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
    // Loudly surface the live URL the app will load — the single most deploy-critical value for a
    // server loader (easy to get wrong via env/scheme/cache). Visible in every sync/deploy output.
    console.log(`  🌐 serverUrl → ${cfg.serverUrl}  (the app loads this live; verify it before shipping)`);
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

/** True when `root` is the appwrap framework monorepo itself (not an external consumer project).
 * Running `appwrap init` on an in-repo example (examples/*) resolves `gitRoot` to the framework root,
 * so scaffolding consumer CI workflows there pollutes the framework's OWN `.github/workflows` with a
 * stray app-template workflow each init. The framework manages its own CI — skip the workflow scaffold. */
export function isFrameworkRepo(root: string): boolean {
  return existsSync(join(root, 'packages/appwrap-cli/src/cli.ts'));
}

/** Context the CI workflow templates are rendered against — derived from the repo shape + config.
 *  - `subdir`: app dir relative to the git root ('' = app at repo root). Auto-detected from where the
 *    appwrap config lives, so a monorepo gets path-scoped jobs + a PR paths filter for free.
 *  - `tagPrefix`: release-trigger tag prefix. Monorepo default `<subdir>-v` (NOT `v`) so an unrelated
 *    repo `v*` tag can never cut a store release; overridable via config `ci.tagPrefix`.
 *  - `webBuild`: false for loader:'server' wraps (no local PWA bundle) — web build steps drop out. */
export interface CiRenderContext { subdir: string; tagPrefix: string; webBuild: boolean; }

/** Derive the render context for `cwd` (the app dir holding the appwrap config) inside `repoRoot`. */
export function ciRenderContext(cwd: string, repoRoot: string, cfg: AppwrapConfig): CiRenderContext {
  const rel = relative(repoRoot, cwd);
  const subdir = rel === '' || rel === '.' ? '' : rel;
  // Default tag prefix uses the LAST path segment (apps/foo → foo-v): tags are flat names, not paths.
  const tagPrefix = cfg.ci?.tagPrefix ?? (subdir ? `${basename(subdir)}-v` : 'v');
  return { subdir, tagPrefix, webBuild: cfg.loader !== 'server' };
}

/** Render a CI workflow template: substitute tokens and resolve `#@if:` directives.
 * Directives (never survive into output): a trailing ` #@if:<cond>` keeps that line only when the
 * condition holds; standalone `#@if:<cond>` … `#@end` lines gate a block (non-nesting). Conds:
 * `monorepo` (subdir set) / `root` / `web` (local PWA build) / `server`. Tokens: `__DIR__` →
 * `<subdir>/` or '' (path prefix), `__APP_DIR__` → subdir (working-directory), `__TAG_PREFIX__`. */
export function renderCiWorkflow(src: string, ctx: CiRenderContext): string {
  const holds = (c: string): boolean =>
    c === 'monorepo' ? !!ctx.subdir : c === 'root' ? !ctx.subdir : c === 'web' ? ctx.webBuild : c === 'server' ? !ctx.webBuild
    : c === 'doc' ? false // template-authoring notes — never emitted
    : true;
  const out: string[] = [];
  let dropBlock = false;
  let inBlock = false; // block directives DON'T nest — fail loud rather than silently mis-render
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#@if:')) {
      if (inBlock) throw new Error('renderCiWorkflow: nested #@if: block directives are unsupported');
      inBlock = true; dropBlock = !holds(t.slice(5)); continue;
    }
    if (t === '#@end') { inBlock = false; dropBlock = false; continue; }
    if (dropBlock) continue;
    const m = line.match(/^(.*?)\s*#@if:([a-z]+)$/);
    if (m) { if (holds(m[2])) out.push(m[1]); }
    else out.push(line);
  }
  if (inBlock) throw new Error('renderCiWorkflow: unterminated #@if: block (missing #@end)');
  return out.join('\n')
    .replaceAll('__DIR__', ctx.subdir ? `${ctx.subdir}/` : '')
    .replaceAll('__APP_DIR__', ctx.subdir)
    .replaceAll('__TAG_PREFIX__', ctx.tagPrefix);
}

/** Emit CI scaffolding (GH Actions → git repo root ONLY with --ci, fastlane → native/).
 * Writing `.github/workflows` into a consumer repo is a repo-level side effect (it can shadow or
 * clash with the project's own CI), so it is OPT-IN via `appwrap init --ci` — never implicit.
 * GH workflows are never overwritten (users may customize them). The fastlane lane IS appwrap-managed
 * (the release recipe, not for hand-editing — see AGENTS.md), so it is RE-EMITTED on `--force` to keep
 * the recipe current after a framework upgrade; without --force it's still first-time-only. */
function copyCiTemplates(cwd: string, outDir: string, cfg: AppwrapConfig, force = false, withWorkflows = false): void {
  if (!existsSync(CI_TEMPLATE_DIR)) return;
  const repoRoot = gitRoot(cwd);
  // GitHub only reads `.github/workflows` at the REPO ROOT — in a monorepo, writing it under the
  // package cwd (e.g. packages/app/.github) is dead config and regenerates a stray workflow each init.
  // [from, to, overwritable]
  const targets: Array<[string, string, boolean]> = [[join(CI_TEMPLATE_DIR, 'fastlane'), join(outDir, 'fastlane'), force]];
  // Even with --ci: if the repo root IS the appwrap framework itself (in-repo example), DON'T scaffold
  // consumer workflows into the framework's .github — that's the stray-workflow-each-init bug.
  const scaffoldWorkflows = withWorkflows && !isFrameworkRepo(repoRoot);
  if (withWorkflows && !scaffoldWorkflows) {
    console.log('  ci   ← GH Actions scaffold skipped (inside the appwrap framework repo — manages its own CI)');
  }
  for (const [from, to, overwrite] of targets) {
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true, force: overwrite, errorOnExist: false });
  }
  // Workflows are RENDERED per-repo-shape (not raw-copied): monorepo path scoping + tag prefix +
  // loader-aware web steps (see renderCiWorkflow), and the `bunx @livx.cc/appwrap@^x.y.z` pin is
  // stamped to THIS CLI's version floor so a CI run can't silently resolve an older published build
  // that lacks the `init`/`release` commands (it fails loudly instead). Never overwritten (users may
  // customize); re-init on an existing file is a no-op.
  if (scaffoldWorkflows) {
    const ctx = ciRenderContext(cwd, repoRoot, cfg);
    const wfSrcDir = join(CI_TEMPLATE_DIR, 'github/workflows');
    const wfDir = join(repoRoot, '.github/workflows');
    mkdirSync(wfDir, { recursive: true });
    for (const file of readdirSync(wfSrcDir)) {
      const dest = join(wfDir, file);
      if (existsSync(dest)) continue;
      const rendered = renderCiWorkflow(readFileSync(join(wfSrcDir, file), 'utf8'), ctx)
        .replaceAll('__APPWRAP_VERSION__', CLI_VERSION);
      writeFileSync(dest, rendered);
    }
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
  const ci = scaffoldWorkflows
    ? '  ci   ← GH Actions (.github/workflows) + fastlane (native/fastlane, signing stamped) — see secrets contract in workflow headers'
    : '  ci   ← fastlane (native/fastlane, signing stamped) — GH Actions workflows are opt-in: `appwrap init --ci`';
  console.log(ci);
}

// Manifests of what the two sync-owned sources (runtime template, consumer overrides) generated LAST run.
// Used to prune files that were REMOVED/renamed in the source — cpSync(force) overwrites but never deletes,
// so without this a relocated source lingers in native/ and gets re-bundled.
const TEMPLATE_MANIFEST = '.appwrap-template-manifest.json';
const OVERRIDES_MANIFEST = '.appwrap-overrides-manifest.json';
/** Tracks module-owned native source copied into native/ (built-in + pack), so a module DEACTIVATED
 * since the last sync has its App_Resources files pruned rather than lingering (cpSync never deletes). */
const MODULE_NATIVE_MANIFEST = '.appwrap-module-native-manifest.json';

/** Files under TEMPLATE_DIR to skip when copying/walking it (deps, build output, PWA staging, per-module
 * native — those are handled selectively elsewhere). Shared by the cpSync filter and the prune walk so
 * the copied set and the pruned set are defined identically. */
const templateCopyFilterFor = (root: string) => (src: string): boolean =>
  !/(?:^|\/)(node_modules|platforms|hooks|app\/www|modules-native)(\/|$)/.test(src.slice(root.length));
/** Single-root filter for the built-in template (the common path). */
const templateCopyFilter = templateCopyFilterFor(TEMPLATE_DIR);
/** Every file the active template roots contribute, relative to each root (deduped across roots) —
 * the union prune set + override-protection set for the overlay chain. */
function allTemplateFiles(): Set<string> {
  const out = new Set<string>();
  for (const root of TEMPLATE_ROOTS) {
    if (!existsSync(root)) continue;
    for (const rel of collectRelFiles(root, templateCopyFilterFor(root))) out.add(rel);
  }
  return out;
}

/** File (not dir) paths under `root`, relative to it, skipping entries `accept` rejects. */
function collectRelFiles(root: string, accept: (abs: string) => boolean = () => true): Set<string> {
  const out = new Set<string>();
  const rec = (dir: string, rel: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (!accept(abs)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(abs, r);
      else out.add(r);
    }
  };
  rec(root, '');
  return out;
}

/** Prune generated files sync OWNS that vanished from their source. Deletes only paths recorded in the
 * PRIOR manifest that are absent from the `current` source set — so it never touches user data or any
 * region absent from a previous run's manifest. `protect` keeps paths another owned source still ships
 * (e.g. an override was removed but the template still provides that file). */
function pruneStale(outDir: string, manifest: string, current: Set<string>, protect?: Set<string>): void {
  const mf = join(outDir, manifest);
  let prev: string[] = [];
  try { prev = JSON.parse(readFileSync(mf, 'utf8')) as string[]; } catch { /* first run — nothing to prune */ }
  for (const rel of prev) {
    if (current.has(rel) || protect?.has(rel)) continue;
    const abs = join(outDir, rel);
    try {
      if (existsSync(abs)) { rmSync(abs, { force: true }); console.log(`  prune ✕ ${rel} (removed from source)`); }
    } catch { /* non-fatal */ }
  }
  try { writeFileSync(mf, JSON.stringify([...current])); } catch { /* non-fatal */ }
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
  // shareTarget forwards the shared payload to the host app over the custom URL scheme — without one
  // the iOS share extension has no way back into the app (Android delivery still works via intents).
  if (req.activeOptIn.includes('shareTarget') && !cfg.urlScheme) {
    console.warn('  ⚠ `shareTarget` is active but `urlScheme` is unset — the iOS share extension cannot forward to the app. Set `urlScheme` in the appwrap config.');
  }
  // Copy each template root in order — later roots OVERLAY earlier (file-level last-wins), so a
  // consumer template can add or replace shell files without forking the template. Single root (default) is
  // exactly the pre-overlay copy.
  for (const root of TEMPLATE_ROOTS) {
    if (!existsSync(root)) { console.warn(`⚠ template root not found: ${root}`); continue; }
    cpSync(root, outDir, {
      recursive: true,
      force: true, // explicit: Bun's cpSync does not overwrite existing files by default
      // modules-native/ is copied selectively per active module (copyModuleNativeSrc), not wholesale.
      // Match RELATIVE to the root — when installed from npm, a root itself sits under node_modules/,
      // so testing the absolute path would wrongly exclude the entire template.
      filter: templateCopyFilterFor(root),
    });
  }
  // Delete template files removed/renamed since the last regenerate (cpSync only overwrites, never
  // deletes) — pruned against the UNION of all roots' files so an overlay-provided file isn't culled.
  pruneStale(outDir, TEMPLATE_MANIFEST, allTemplateFiles());
  stampShellConfig(outDir, cfg);
  stampNativeScriptConfig(outDir, cfg);
  stampIOSDisplayName(outDir, cfg, req);
  stampTeamId(outDir, cfg, { cwd, configPath: resolveConfigPath(cwd, opts.flags ?? {}) });
  stampDeviceFamily(outDir, cfg);
  stampAndroidAppName(outDir, cfg, req);
  stampAndroidVersion(outDir, cfg);
  stampAndroidGradleDeps(outDir, req.androidGradleDeps);
  stampKotlin(outDir, req.androidKotlin);
  generateModuleArtifacts(outDir, req);
  regenerateMobilePlugins(cwd, cfg, outDir); // config-gated TS plugins → bridge handlers (in-process)
  const moduleNativeFiles = copyModuleNativeSrc(outDir, req); // module-owned native source (e.g. health's Kotlin shim)
  // Prune a now-inactive module's native files (in the prior manifest, not re-copied this sync). Protect
  // base-template files so a module that overrode a template App_Resources file, once removed, reverts to
  // the template copy instead of being deleted outright.
  pruneStale(outDir, MODULE_NATIVE_MANIFEST, moduleNativeFiles, allTemplateFiles());
  substituteModuleTokens(outDir, cfg); // stamp __APP_GROUP__ etc. into the copied extension source
  stampLaunchScreen(outDir, cfg);
  stampStoreKit(cwd, outDir, cfg);
  stampPush(cwd, outDir, cfg);
  stampEntitlements(outDir, cfg, req); // unified app.entitlements: module entitlements + push aps-environment
  stampPrivacyManifest(outDir, cfg, req); // ATT tracking declarations into the store-readiness privacy manifest
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
  await applyModulePacks(cwd, cfg); // resolve config `modulePacks` (no-op when none) before deriving
  regenerateCore(cwd, outDir, cfg, { firstRun: true, flags });
  copyCiTemplates(cwd, outDir, cfg, 'force' in flags, 'ci' in flags); // GH workflows: opt-in (--ci), first-time only; fastlane lane: re-emit on --force
  writeFileSync(join(outDir, '.gitignore'), 'node_modules/\nplatforms/\nhooks/\n');
  applyOverrides(cwd, outDir, cfg); // escape hatch — last, so custom native code wins
  stampManualSigning(outDir, cfg, { configPath: resolveConfigPath(cwd, flags) }); // AFTER overrides: a consumer's extension.json / build.xcconfig would otherwise clobber the signing stamp
  stampIOSExtensionVersions(outDir, cfg); // AFTER overrides: extension Info.plist ships from overrides; version must match the app's or App Store validation fails
  stampVersionManifest(outDir, cfg); // provenance — also marks the dir appwrap-managed
  console.log(`✓ Wrapper ready (generated — gitignore \`${flags.out ?? 'native'}/\`, regenerate with \`appwrap init\`).\n  Run it: appwrap dev ios   (or: appwrap dev android)`);
}

// `sync` = the same regenerate as `init`, minus the first-time guard/scaffold. It is a TRUE refresh from
// source (shell + config + PWA), so runtime/config edits never silently lag behind. `native/` is
// disposable; re-copying the shell costs ~ms (the real cost is the later `ns build`, which both share).
async function sync(cwd: string, flags: Record<string, string>, cfgOverride?: AppwrapConfig): Promise<void> {
  const cfg = cfgOverride ?? await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }
  await applyModulePacks(cwd, cfg); // resolve config `modulePacks` (no-op when none) before deriving
  regenerateCore(cwd, outDir, cfg, { flags });
  applyOverrides(cwd, outDir, cfg); // overrides win last
  stampManualSigning(outDir, cfg, { configPath: resolveConfigPath(cwd, flags) }); // AFTER overrides: a consumer's extension.json / build.xcconfig would otherwise clobber the signing stamp
  stampIOSExtensionVersions(outDir, cfg); // AFTER overrides: extension Info.plist ships from overrides; version must match the app's or App Store validation fails
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

/** Resolve the `--url <devserver>` / `--port <p>` dev-server URL, or null when neither is given.
 * Explicit `--url` wins; else `http://<lan-ip>:<port>` (port default 5173). Exits if no LAN IP. */
function resolveDevUrl(flags: Record<string, string>): string | null {
  if (!('url' in flags) && !('port' in flags)) return null;
  if (flags.url) return flags.url;
  const ip = lanIp();
  if (!ip) {
    console.error('✖ Could not detect a LAN IP — pass --url http://<host>:<port> explicitly');
    process.exit(1);
  }
  return `http://${ip}:${flags.port ?? '5173'}`;
}

/** `--debug` fold-in: open the on-device WebView inspector. Android adb-forwards the devtools socket →
 * chrome://inspect; iOS prints the Safari Web Inspector path. Best-effort (a non-debug build / not-running
 * app just gets a hint). Shared by `dev --debug` and the `debug` back-compat alias. */
function openInspector(cfg: AppwrapConfig, flags: Record<string, string>, platform: 'ios' | 'android', outDir: string): void {
  if (platform === 'android') {
    const adb = androidAdb();
    const device = resolveDevice(outDir, 'android', flags).id;
    const pid = (() => { try { return execFileSync(adb, ['-s', device, 'shell', 'pidof', cfg.id], { encoding: 'utf8' }).trim().split(/\s+/)[0]; } catch { return ''; } })();
    if (pid) {
      try {
        execFileSync(adb, ['-s', device, 'forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`], { stdio: 'pipe' });
        console.log('✓ WebView devtools forwarded → open chrome://inspect (or http://localhost:9222) in desktop Chrome to inspect the page.');
      } catch {
        console.log('⚠ Could not forward the devtools socket — open chrome://inspect and look for the device there.');
      }
    } else {
      console.log(`⚠ ${cfg.id} not running yet — open chrome://inspect once it launches.`);
    }
    console.log('  (Needs a DEBUG build — `appwrap dev`/`deploy android` installs one with the inspector enabled.)\n');
  } else {
    console.log('▶ iOS WebView inspector: Safari → Develop → [your iPhone] → [the app]. Enable it first in iOS Settings → Safari → Advanced → Web Inspector.\n');
  }
}

/** `appwrap dev <ios|android> [--sim] [--detached] [--debug] [--url <devserver>|--port <p>]` — the
 * live-dev loop. Subsumes the old `run`/`debug` verbs AND the old `dev` (loader:server stamp).
 *
 *  Default target = the physical DEVICE.
 *   • ANDROID: `ns run` livesync for true on-device HMR (incremental, no full reinstall) + a source
 *     watcher that rebuilds the web & re-stages www on save so PWA edits flow into the livesync. The old
 *     "Invalid version … Got type object" crash that made this look unfixable was just the shell
 *     package.json failing to declare @nativescript/android → ns read the runtime version as null.
 *   • iOS: the proven deploy + redeploy-on-save loop (NOT ns run — `ns run ios --device` hits the
 *     personal-team signing/registration path `deploy ios` handles bespokely; pending device-verify).
 *
 *  Flags:
 *   --sim       → emulator/simulator via `ns run` (HMR is reliable there); `--debug` → `ns debug`.
 *   --url/--port→ stamp loader:'server' at that dev-server URL (web hot-reloads inside the WebView), deploy + attach.
 *   --detached  → deploy + exit (install & launch only; don't attach/watch — the MIUI-safe `--user 0` install).
 *   --debug     → android: `ns debug` (inspector); iOS/url: open the WebView inspector then attach.
 */
async function dev(cwd: string, flags: Record<string, string>, positionals: string[]): Promise<void> {
  const platform = positionals[0];
  if (platform && cliOptions.platforms?.[platform]) return void await cliOptions.platforms[platform](cwd, flags, positionals, 'dev');
  const sim = 'sim' in flags || positionals[1] === 'sim';
  const wantDebug = 'debug' in flags;
  if (platform !== 'ios' && platform !== 'android') {
    console.error('Usage: appwrap dev <ios|android> [--sim] [--detached] [--debug] [--wifi] [--device <id|ip[:port]>] [--url <devserver>|--port <p>]');
    process.exit(1);
  }
  const cfg = await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }

  // `--url`/`--port` → point the wrapper at a live dev server (loader:'server', web HMR inside the WebView).
  const devUrl = resolveDevUrl(flags);
  // The cfg the deploy/sim path stamps: server-loader when a dev URL is given, else the bundled config.
  // debug:true here = keep-awake + WebView inspector + the dev-server SSL bypass (LAN self-signed certs).
  const effectiveCfg: AppwrapConfig = devUrl
    ? { ...cfg, loader: 'server', serverUrl: devUrl, debug: true }
    : cfg;
  if (devUrl) {
    console.log(`✓ Dev loader → ${devUrl} (web hot-reloads from the dev server inside the WebView)`);
    console.log('  Dev server must bind 0.0.0.0 (vite: `server.host: true` / `--host`) so the device can reach it.');
    if (devUrl.startsWith('https:') && platform === 'android') {
      console.log("  ⚠ Android: serve the dev server over HTTP, not HTTPS — the WebView can't bypass wss TLS errors (page loads, HMR won't).");
    }
  }

  // ── --sim: emulator/simulator → ns run (HMR) / ns debug. Reliable there; refresh the wrapper first. ──
  if (sim) {
    // Preserve an already-active dev loader (stamped by a prior `dev --url`) if no URL was passed now.
    const stamped = !devUrl ? readStampedLoader(outDir) : null;
    const simCfg: AppwrapConfig = devUrl
      ? effectiveCfg
      : stamped?.loader === 'server'
        ? { ...cfg, loader: 'server', serverUrl: stamped.serverUrl, debug: stamped.debug }
        : cfg;
    await applyModulePacks(cwd, simCfg); // resolve config `modulePacks` (no-op when none) before deriving
    regenerateCore(cwd, outDir, simCfg, { flags });
    applyOverrides(cwd, outDir, simCfg); // overrides win last — same order as sync
    stampIOSExtensionVersions(outDir, simCfg); // AFTER overrides: keep extension version matching the app's (Xcode warns on mismatch)
    stampVersionManifest(outDir, simCfg);
    console.log(simCfg.loader === 'server' ? `✓ Refreshed wrapper (dev loader → ${simCfg.serverUrl})` : '✓ Refreshed wrapper from template + PWA');
    runNs(outDir, [wantDebug ? 'debug' : 'run', platform, ...(flags.device ? ['--device', flags.device] : [])]);
    return;
  }

  // ── ANDROID device + bundled loader: ns run livesync = true on-device HMR (incremental, no reinstall) ──
  // Unblocked by declaring @nativescript/android in the shell package.json: ns reads the android runtime
  // version on the livesync path; when it's undeclared that lookup returns null → `semver.gt(null, …)` →
  // the "Invalid version … Got type object" crash that long made on-device livesync look unfixable.
  // ns watches native/app + native/www-src; since the PWA SOURCE lives OUTSIDE native/, we run a source
  // watcher alongside that rebuilds the web + re-stages www on save — ns's livesync then pushes it.
  // (Must spawn ns async, not execFileSync: a sync exec freezes the fs.watch loop.)
  // iOS is intentionally NOT on ns run here: `ns run ios --device` hits the personal-team device
  // registration/signing path that `deploy ios` handles bespokely — unverified, so iOS keeps the proven
  // deploy + redeploy-on-save loop below until it's device-verified.
  if (platform === 'android' && !devUrl && !('detached' in flags)) {
    const device = resolveDevice(outDir, 'android', flags);
    // MIUI/Xiaomi auto-denies a bare `adb install`; only `--user 0` works (deploy uses it). Pre-installing
    // via deploy establishes the package so `ns run`'s subsequent install lands as an allowed UPDATE
    // rather than a blocked fresh bare-install — the device-verified path. (~one extra fast install.)
    await deploy(cwd, { ...flags, 'no-launch': '' }, ['android'], cfg);
    const nsArgs = [wantDebug ? 'debug' : 'run', 'android', '--device', device.id];
    const env = prepareNsEnv(outDir, nsArgs);
    console.log(`\n▶ dev: ns ${nsArgs.join(' ')} (on-device HMR) + watching sources → re-stage on save. Ctrl-C to stop.`);
    // Own process group so Ctrl-C / kill reaps ns AND its grandchildren (gradle, adb logcat, webpack).
    const nsChild = spawn('ns', nsArgs, { cwd: outDir, stdio: 'inherit', detached: true, env });
    const stop = () => { try { if (nsChild.pid) process.kill(-nsChild.pid); } catch { /* already gone */ } };
    process.on('exit', stop);
    process.on('SIGINT', () => { stop(); process.exit(0); });
    nsChild.on('exit', (code) => process.exit(code ?? 0));
    await watchAndSync(cwd, flags, outDir, cfg); // rebuild + re-stage on save; ns livesync pushes it
    return;
  }

  // ── iOS device (bundled), --url, or --detached: the proven one-shot deploy path ──
  await deploy(cwd, flags, [platform], devUrl ? effectiveCfg : undefined);
  // Follow-ups reuse the just-deployed device from last-device memory — drop an interactive `-d`.
  const followFlags = { ...flags }; delete followFlags.d;
  if (wantDebug) openInspector(effectiveCfg, followFlags, platform, outDir);
  if ('detached' in flags) {
    console.log('\n✓ --detached — installed & launched; not attaching/watching.');
    return;
  }
  if (devUrl) {
    // --url: the web hot-reloads from the dev server INSIDE the WebView; just stream the console.
    console.log('\n▶ dev: web hot-reloads from the dev server inside the WebView; streaming the console. Ctrl-C to stop.');
    await logs(cwd, followFlags, [platform]);
    return;
  }
  // iOS bundled device: stream the WebView console + redeploy (rebuild+reinstall) on save. No ns livesync
  // on an iOS device yet (see above), so a full redeploy is the device-safe refresh path.
  console.log('\n▶ dev: streaming WebView console + watching sources (edit a file → rebuild+reinstall). Ctrl-C to stop.');
  const logArgs = [import.meta.path, 'logs', platform];
  if (followFlags.device) logArgs.push('--device', followFlags.device);
  if (followFlags.out) logArgs.push('--out', followFlags.out);
  if (followFlags.config) logArgs.push('--config', followFlags.config);
  // `detached: true` → own process group so we reap the whole tree (bun → adb/idevicesyslog) on Ctrl-C.
  const logChild = spawn('bun', logArgs, { stdio: 'inherit', detached: true });
  const stopLog = () => { try { if (logChild.pid) process.kill(-logChild.pid); } catch { /* already gone */ } };
  process.on('exit', stopLog);
  process.on('SIGINT', () => { stopLog(); process.exit(0); });
  await watchAndRedeploy(cwd, followFlags, platform);
}

/** Ensure the wrapper's deps are installed (bun — honoring the repo's package manager, so callers
 * never `cd native` or remember the tool) then exec an `ns` subcommand in it with inherited stdio.
 * The single place appwrap shells out to ns for the interactive run loop. Best-effort bun: we only
 * install when node_modules is absent — if ns later reinstalls on package.json drift it uses npm
 * (NativeScript has no bun package-manager mode), so trustedDependencies in the shell package.json
 * is what keeps the bun-installed tree behaving like npm's (parcel/watcher, ns CLI hooks). */
/** Resolve a usable Android SDK dir: an already-valid ANDROID_HOME/ANDROID_SDK_ROOT, else the first
 * common install location that actually contains an SDK. Lets `deploy/run android` work without the
 * user having exported ANDROID_HOME in their shell (the #1 "ns can't find the SDK" foot-gun). */
function resolveAndroidSdk(): string | undefined {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (env && existsSync(env)) return env;
  const home = process.env.HOME || '';
  const candidates = [
    join(home, 'Library/Android/sdk'),    // macOS (Android Studio default)
    join(home, 'Library/Android/Sdk'),
    join(home, 'Android/Sdk'),            // Linux (Android Studio default)
    '/usr/local/share/android-sdk',       // homebrew cask
    '/opt/android-sdk',
  ];
  // A usable SDK has platform-tools (adb) or installed platforms; cmdline-tools-only dirs don't count.
  return candidates.find((d) => existsSync(join(d, 'platform-tools')) || existsSync(join(d, 'platforms')));
}

/** Build the env for an `ns` invocation in `outDir` (auto-detect Android SDK, ensure bun-installed deps).
 * Shared by the blocking `runNs` (sim) and the non-blocking spawn in `dev` (device livesync). */
function prepareNsEnv(outDir: string, args: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Android: inject a discovered SDK so `ns` finds it even when the user's shell never exported
  // ANDROID_HOME (new terminal not sourced, conda base shell, etc.) — the common deploy blocker.
  if (args.includes('android')) {
    const sdk = resolveAndroidSdk();
    if (sdk) {
      env.ANDROID_HOME = sdk;
      env.ANDROID_SDK_ROOT = sdk;
      env.PATH = [process.env.PATH, join(sdk, 'platform-tools'), join(sdk, 'emulator')].filter(Boolean).join(':');
      if (!process.env.ANDROID_HOME) console.log(`  android SDK ← ${sdk}  (ANDROID_HOME not set; auto-detected)`);
    } else {
      console.warn('  ⚠ No Android SDK found (set ANDROID_HOME). Install Android Studio or the command-line tools, then `sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"`.');
    }
  }
  if (!existsSync(join(outDir, 'node_modules'))) {
    console.log(`▶ bun install  (cwd: ${outDir})`);
    execFileSync('bun', ['install'], { cwd: outDir, stdio: 'inherit', env });
  }
  return env;
}

function runNs(outDir: string, args: string[]): void {
  const env = prepareNsEnv(outDir, args);
  console.log(`▶ ns ${args.join(' ')}  (cwd: ${outDir})`);
  execFileSync('ns', args, { cwd: outDir, stdio: 'inherit', env });
  if (args.includes('android')) assertSbgParsedCleanly(outDir);
}

/** Fail an Android build when SBG's js_parser ABANDONED a bundled file.
 *
 * This is the root check; assertJavaProxyBindings() below is the outcome check. The parser catches errors
 * PER FILE, drops that file's ENTIRE remaining AST, logs nothing unless JS_PARSER_ENABLE_LOGGING is set
 * (runSbg.log stays empty), and the gradle task still exits 0 — so every binding declared after the throw
 * silently vanishes from a green build. Measured blast radius when a spread in a `.extend({...})` literal
 * threw ~1/3 of the way through bundle.js: bundle-sourced bindings went 24 -> 1. Gone were not just
 * @JavaProxy('cc.livx.appwrap.AppwrapMessagingService') (a FATAL boot crash) but SensorEventListener x4,
 * LocationListener, OnCompleteListener x2, RecognitionListener, ContentObserver, Runnable x5 and
 * ValueCallback — i.e. sensors, geolocation, FCM token, speech and background threads, each failing later
 * and far from the cause.
 *
 * Asserting only "@JavaProxy present" would miss all of that whenever the throw lands after the last
 * @JavaProxy, so re-run the parser with logging and treat ANY abandoned file as a build failure. This is
 * read-only w.r.t. the APK (gradle already generated the java); it only rewrites build-tools/sbg-*.txt with
 * identical content, and those are not gradle inputs.
 */
function assertSbgParsedCleanly(outDir: string): void {
  const buildTools = join(outDir, 'platforms/android/build-tools');
  const parser = join(buildTools, 'jsparser/js_parser.js');
  if (!existsSync(parser)) return assertJavaProxyBindings(outDir); // no parser here → nothing to re-run

  // spawnSync, not execFileSync: the parser logs its fatal "Error processing" lines to STDERR, and
  // execFileSync returns stdout ONLY — reading just stdout silently sees a clean log and passes.
  const run = spawnSync('node', [parser, 'enableVerboseLogging'], {
    cwd: buildTools,
    encoding: 'utf8',
    env: { ...process.env, JS_PARSER_ENABLE_LOGGING: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  // Couldn't re-run (no node on PATH, parser layout changed). Don't fail the build on the CHECK's own
  // failure — fall back to the cheaper outcome assertion, which needs no subprocess.
  if (run.error || run.status !== 0) return assertJavaProxyBindings(outDir);
  const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;

  // "Error processing '<file>:' <err>" = that file was abandoned mid-AST. (Distinct from the parser's
  // benign per-node "JSParser Error: Node type is not a call expression" chatter, which is not fatal.)
  const abandoned = [...log.matchAll(/Error processing '([^']+):?'\s*(.*)/g)].map((m) => ({
    file: basename(m[1].replace(/:$/, '')),
    err: (m[2] || '').split('\n')[0].trim(),
  }));
  if (abandoned.length) {
    console.error(
      `\n✖ Android build is BROKEN: NativeScript's static-binding-generator ABANDONED ${abandoned.length} bundled\n` +
        `  file(s) mid-parse. Every Java binding declared after the throw was silently dropped — the gradle\n` +
        `  task still exited 0, so this APK/AAB is missing classes it needs:\n` +
        abandoned.map((a) => `    • ${a.file}: ${a.err}`).join('\n') +
        `\n\n  Symptoms this causes, all far from the cause: "LookedUpClassNotFound: <class>" FATAL at boot for a\n` +
        `  @JavaProxy, or sensors/geolocation/speech/FCM-token/background-threads silently doing nothing.\n\n` +
        `  The known offender is a SPREAD inside an \`X.extend({...})\` literal: the parser reads\n` +
        `  \`prop.key.name\` for every property and a SpreadElement has no \`key\`. Keep .extend() literals\n` +
        `  spread-free (select between two whole literals instead), and never pass a variable to .extend().\n\n` +
        `  Full parse log:\n` +
        `    cd ${buildTools} && JS_PARSER_ENABLE_LOGGING=true node jsparser/js_parser.js enableVerboseLogging\n`
    );
    process.exit(1);
  }
  assertJavaProxyBindings(outDir); // parse was clean — still assert the outcome
}

/** Fail an Android build when a `@JavaProxy` class silently lost its generated Java binding.
 *
 * NativeScript's static-binding-generator (SBG) reads the BUNDLED js and synthesizes the Java class each
 * `@JavaProxy('a.b.C')` declares — the same class AndroidManifest entries and `new a.b.C()` reference. Its
 * js_parser catches errors PER FILE: on an unsupported construct it abandons THE ENTIRE FILE, logs only
 * under JS_PARSER_ENABLE_LOGGING (runSbg.log stays empty), and the gradle task still exits 0. So every
 * @JavaProxy declared after that point in the bundle vanishes with a green build, and the app dies at boot
 * on a device with `LookedUpClassNotFound: a.b.C` — the worst possible place to find out.
 *
 * This turns that silent, ship-to-prod failure into a build error. It is deliberately generic (assert the
 * BINDING exists, not "no spreads"): it catches any future parser quirk, not just the one that bit us —
 * a spread inside a `X.extend({...})` literal (a SpreadElement has no `.key`, so the parser threw on
 * `prop.key.name` and dropped cc.livx.appwrap.AppwrapMessagingService, boot-crashing every server-loader
 * app with push).
 *
 * Inputs are SBG's OWN records, so this checks exactly what SBG saw: sbg-js-parsed-files.txt (the files it
 * parsed) and sbg-bindings.txt (what it decided to generate).
 */
function assertJavaProxyBindings(outDir: string): void {
  const buildTools = join(outDir, 'platforms/android/build-tools');
  const bindingsFile = join(buildTools, 'sbg-bindings.txt');
  const parsedFile = join(buildTools, 'sbg-js-parsed-files.txt');
  // Absent → SBG never ran for this invocation (e.g. `ns clean`, a prepare-only pass). Nothing to assert.
  if (!existsSync(bindingsFile) || !existsSync(parsedFile)) return;

  const bindings = readFileSync(bindingsFile, 'utf8');
  const missing: Array<{ cls: string; file: string }> = [];
  for (const jsFile of readFileSync(parsedFile, 'utf8').split('\n').map((l) => l.trim())) {
    if (!jsFile || !existsSync(jsFile)) continue;
    const js = readFileSync(jsFile, 'utf8');
    // Only a real decorator call `JavaProxy('a.b.C')` matches — prose mentions like "(JavaProxy)" don't.
    for (const m of js.matchAll(/JavaProxy\(\s*['"]([\w.$]+)['"]\s*\)/g)) {
      const cls = m[1];
      // sbg-bindings.txt is `*`-delimited; the proxy name is one field — a substring test is enough.
      if (!bindings.includes(cls) && !missing.some((x) => x.cls === cls)) missing.push({ cls, file: basename(jsFile) });
    }
  }
  if (!missing.length) return;

  console.error(
    `\n✖ Android build is BROKEN: ${missing.length} @JavaProxy class(es) got no Java binding from the\n` +
      `  NativeScript static-binding-generator, so the APK/AAB is missing them. This build would install\n` +
      `  and then CRASH AT BOOT with "LookedUpClassNotFound":\n` +
      missing.map((m) => `    • ${m.cls}   (declared in ${m.file})`).join('\n') +
      `\n\n  CAUSE: SBG's js_parser hit an unsupported construct, abandoned the whole file, and still exited 0,\n` +
      `  dropping every @JavaProxy after that point. It does NOT report this itself.\n\n` +
      `  The known offender is a SPREAD inside an \`X.extend({...})\` literal — the parser reads\n` +
      `  \`prop.key.name\` for every property and a SpreadElement has no \`key\`. Keep .extend() literals\n` +
      `  spread-free (select between two literals instead), and never pass a variable to .extend().\n\n` +
      `  To see the real parse error:\n` +
      `    cd ${buildTools} && JS_PARSER_ENABLE_LOGGING=true node jsparser/js_parser.js enableVerboseLogging\n`
  );
  process.exit(1);
}

/** Wipe the generated NativeScript state (`ns clean`: platforms/, hooks/, node_modules/) then restore
 * deps. The escape hatch when the generated tree drifts from the current project — e.g. a moved/renamed
 * repo leaves a STALE platforms/ios/Podfile that ns keeps appending to (corrupt merge, orphaned
 * post_install, mixed old/new paths) → CocoaPods "unexpected end" and the build never recovers on its own. */
async function clean(cwd: string, flags: Record<string, string>): Promise<void> {
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — nothing to clean (run \`appwrap init\` first)`);
    process.exit(1);
  }
  console.log(`▶ ns clean  (cwd: ${outDir})  — wiping platforms/, hooks/, node_modules/`);
  execFileSync('ns', ['clean'], { cwd: outDir, stdio: 'inherit', env: { ...process.env } });
  // ns clean also removes node_modules; restore it so the tree is usable and the next deploy doesn't
  // pay the reinstall inline (prepareNsEnv would otherwise lazily bun-install on the following build).
  console.log(`▶ bun install  (cwd: ${outDir})  — restoring deps`);
  execFileSync('bun', ['install'], { cwd: outDir, stdio: 'inherit', env: { ...process.env } });
  console.log('✓ Cleaned. Next `appwrap deploy` regenerates platforms/ from App_Resources.');
}

/** Read the loader currently stamped into the generated shell (app/shell/config.ts). Used to
 * preserve an ACTIVE dev loader across a `dev --sim` refresh. Returns null if the
 * generated config is absent/unreadable — the caller then falls back to the appwrap config. */
function readStampedLoader(outDir: string): { loader: string; serverUrl: string; debug: boolean } | null {
  try {
    const src = readFileSync(join(outDir, 'app/shell/config.ts'), 'utf8');
    const loader = src.match(/loader:\s*"([^"]*)"/)?.[1];
    if (!loader) return null;
    return {
      loader,
      serverUrl: src.match(/serverUrl:\s*"([^"]*)"/)?.[1] ?? '',
      debug: /debug:\s*true/.test(src),
    };
  } catch {
    return null;
  }
}

/** Watch loop for iOS `dev` (no on-device ns livesync yet): re-run the clean deploy path on a project
 * source change (debounced) — a full rebuild+reinstall, the device-safe refresh for iOS. Skips
 * generated/output dirs. macOS recursive fs.watch. (Android uses watchAndSync + ns livesync instead.) */
async function watchAndRedeploy(cwd: string, flags: Record<string, string>, platform: 'ios' | 'android'): Promise<void> {
  const { watch } = await import('fs');
  const ignore = /(^|\/)(native|node_modules|dist|public|\.git|\.appwrap)(\/|$)/;
  console.log(`\n👀 watching ${cwd} for changes → rebuild+reinstall on save (Ctrl-C to stop).`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let quietUntil = 0;
  watch(cwd, { recursive: true }, (_evt, file) => {
    if (!file || ignore.test(String(file)) || busy || Date.now() < quietUntil) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      busy = true;
      console.log(`\n🔁 change: ${file} → redeploying…`);
      try { await deploy(cwd, flags, [platform]); } catch (e) { console.error(`⚠ redeploy failed: ${(e as Error).message}`); }
      quietUntil = Date.now() + 1500;
      busy = false;
    }, 600);
  });
  await new Promise<void>(() => { /* run until Ctrl-C */ });
}

/** Lean watch loop for Android `dev`: on a project source change, rebuild the web + RE-STAGE only
 * the web bundle (dist → native/www-src) — debounced. Deliberately NOT a full `regenerateCore`: that
 * re-copies App_Resources/package.json and makes ns do a full native rebuild+reinstall (defeating HMR
 * and tripping MIUI). Staging www-src only keeps the `ns run` livesync on the JS hot-push path. The
 * watcher sees the PROJECT dir, so it only catches PWA source edits (the shell template lives elsewhere).
 * Skips generated/output dirs. macOS recursive fs.watch. */
async function watchAndSync(cwd: string, flags: Record<string, string>, outDir: string, cfg: AppwrapConfig): Promise<void> {
  const { watch } = await import('fs');
  // Skip generated/output trees. `dist` is the web build output; `public` is where many build steps
  // ALSO emit (e.g. a copied bundle / stamped index) — both must be ignored or the rebuild's own writes
  // re-trigger the watch in a loop. A post-rebuild cooldown is the generic backstop for any other
  // output dir we don't know about (the project's build target is project-specific).
  const ignore = /(^|\/)(native|node_modules|dist|public|\.git|\.appwrap)(\/|$)/;
  console.log(`👀 watching ${cwd} → rebuild + re-stage on save (ns livesync pushes it).`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let quietUntil = 0; // ignore events for a beat after a rebuild — its own file writes aren't user edits
  watch(cwd, { recursive: true }, (_evt, file) => {
    if (!file || ignore.test(String(file)) || busy || Date.now() < quietUntil) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      busy = true;
      console.log(`\n🔁 change: ${file} → rebuild web + re-stage www…`);
      try {
        buildWebIfBundled(cwd, cfg, flags);
        copyPwa(cwd, outDir, cfg); // stage dist → www-src only; ns livesync hot-pushes it (no reinstall)
      } catch (e) { console.error(`⚠ re-stage failed: ${(e as Error).message}`); }
      quietUntil = Date.now() + 1500;
      busy = false;
    }, 600);
  });
  await new Promise<void>(() => { /* run until Ctrl-C */ });
}

/** `appwrap build <ios|android> [--release] [--aab]` — store-readiness build path. Re-stamps config,
 * re-copies the PWA, then delegates the actual compile to NativeScript with the right flags. Release
 * Android signing comes from env (APPWRAP_ANDROID_KEYSTORE[_PASSWORD|_ALIAS|_ALIAS_PASSWORD]) — secrets
 * never live in the appwrap config. iOS distribution signing/upload is the fastlane release lane's job (the
 * cicd templates); `--release` here just builds the Release config for the device. */

async function build(cwd: string, flags: Record<string, string>, positionals: string[]): Promise<void> {
  const platform = positionals[0];
  if (platform && cliOptions.platforms?.[platform]) return void await cliOptions.platforms[platform](cwd, flags, positionals, 'build');
  if (platform !== 'ios' && platform !== 'android') {
    console.error('Usage: appwrap build <ios|android> [--release] [--aab] [--config <path>] [--out native]');
    process.exit(1);
  }
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }
  // --build-number → process.env.APPWRAP_BUILD_NUMBER before sync() stamps the plist/gradle (same
  // mechanism `release` uses). Env-var path still honored by sync()'s buildNumberOf when no flag.
  try {
    applyBuildNumberFlag(flags['build-number']);
  } catch (e) {
    console.error(`✖ ${(e as Error).message}`);
    process.exit(1);
  }
  const release = 'release' in flags;
  // iOS release archive = the STORE artifact. With signing:'manual', stamp App Store distribution
  // signing (profile kind 'appstore' + "Apple Distribution") so xcodebuild archives a SIGNED binary —
  // an unsigned archive re-signed at exportArchive gets its entitlements SYNTHESIZED from the
  // provisioning profile, silently dropping app.entitlements (e.g. declared-age-range).
  if (platform === 'ios' && release) process.env.APPWRAP_SIGNING_KIND = 'appstore';
  // Make sure the wrapper reflects the latest config + PWA before compiling (also validates the config).
  await sync(cwd, flags);

  const args = ['build', platform];
  if (release) args.push('--release');
  if (platform === 'ios' && release) {
    args.push('--for-device');
    // Manual signing: pass the resolved App Store profile so NS emits a manual exportOptions.plist
    // (app + extensions via extensions/provisioning.json) for `xcodebuild -exportArchive`. The export
    // method comes from the archive's embedded profile (Distribution → app-store), so this yields a
    // store .ipa whose entitlements are the archive's own (app.entitlements intact).
    const sidecar = join(outDir, '.appwrap-signing.json');
    if (existsSync(sidecar)) {
      const sc = JSON.parse(readFileSync(sidecar, 'utf8')) as { provision?: string };
      if (sc.provision) args.push('--provision', sc.provision);
    }
  }
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
  // This is the RELEASE path (CI's `build android --release --aab`) — the one whose output actually ships.
  // It calls `ns` directly rather than via runNs, so it needs its own check. See assertSbgParsedCleanly.
  if (platform === 'android') assertSbgParsedCleanly(outDir);
  if (platform === 'ios' && release) {
    const ipa = join(outDir, 'platforms/ios/build/Release-iphoneos');
    console.log(`ℹ Signed store .ipa in ${ipa} — upload via \`bunx @livx.cc/mcp-appstores apple-upload\` or the fastlane release lane (native/fastlane).`);
  }
}

/** `appwrap release ios` — the ONE build+sign+upload-to-TestFlight command, identical locally and in CI.
 *
 * It re-stamps the config + PWA (`sync`) and then delegates the full archive/sign/upload to the emitted
 * fastlane lane (`native/fastlane` `:beta`) — the SINGLE source of truth for the iOS release recipe (the
 * lane runs `ns prepare ios --release` → match signing → build_app → upload_to_testflight). CI is a thin
 * wrapper that just calls this. Keeping the recipe in fastlane (not duplicated in TS) means local and CI
 * run byte-identical steps.
 *
 * Knobs (all optional; mirror the workflow):
 *   --server-url <url>   override loader:'server' serverUrl for this release (lab vs prod backend)
 *   --env <name>         convenience: resolve serverUrl from cfg.envs[name] when present (see config)
 *   --build-number <n>   set the store CFBundleVersion (sets APPWRAP_BUILD_NUMBER for the lane)
 *
 * Signing/ASC config is read from env by the lane (ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 /
 * MATCH_GIT_URL / MATCH_PASSWORD) — secrets never live in appwrap.config.
 *
 * `appwrap submit ios` reuses this same body with `lane: 'release'` → fastlane `:release`
 * (`upload_to_app_store`): a binary-only App Store production promote. Metadata/screenshots stay in
 * ASC; pass `--submit-for-review` to also submit the build for review. */
async function release(cwd: string, flags: Record<string, string>, positionals: string[], lane: 'beta' | 'release' = 'beta'): Promise<void> {
  const submit = lane === 'release';
  const cmd = submit ? 'submit' : 'release';
  const platform = positionals[0];
  if (platform !== 'ios') {
    console.error(`Usage: appwrap ${cmd} ios [--server-url <url>] [--env <name>] [--build-number <n>]` +
      (submit ? ' [--submit-for-review]' : '') + ' [--config <path>] [--out native]\n' +
      '  (Android: `appwrap build android --release --aab` then `fastlane android beta`.)');
    process.exit(1);
  }
  const cfg = await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first (CI must \`init\`, native/ is gitignored).`);
    process.exit(1);
  }
  const fastfile = join(outDir, 'fastlane', 'Fastfile');
  if (!existsSync(fastfile)) {
    console.error(`✖ No fastlane lane at ${fastfile} — run \`appwrap init\` to emit it (it carries the release recipe).`);
    process.exit(1);
  }

  // Optional backend-url override for loader:'server' apps (lab vs prod). --server-url wins; else
  // --env resolves from cfg.envs[name] when the consumer config declares it.
  let serverUrl = flags['server-url'] || undefined;
  if (!serverUrl && flags.env) {
    serverUrl = (cfg as { envs?: Record<string, string> }).envs?.[flags.env];
    if (!serverUrl) {
      console.error(`✖ --env ${flags.env} given but cfg.envs[${flags.env}] is not set in the config.`);
      process.exit(1);
    }
  }
  const stampCfg = serverUrl ? { ...cfg, loader: 'server' as const, serverUrl } : cfg;

  // Build number: explicit flag → APPWRAP_BUILD_NUMBER. Stamping (sync → stampIOSDisplayName →
  // buildNumberOf) reads process.env.APPWRAP_BUILD_NUMBER, and sync() runs BEFORE fastlane archives
  // the (already-stamped) Info.plist — so the flag must land on process.env *here*, before sync(),
  // not only on the child env. In CI the workflow sets APPWRAP_BUILD_NUMBER itself (env path).
  try {
    applyBuildNumberFlag(flags['build-number']);
  } catch (e) {
    console.error(`✖ ${(e as Error).message}`);
    process.exit(1);
  }
  const env = { ...process.env };
  // `submit ios --submit-for-review` → also submit the binary for App Store review (the lane defaults
  // to a safe binary-only promote). The flag is boolean (presence = '' via parseArgs).
  if (submit && 'submit-for-review' in flags) env.APPWRAP_SUBMIT_FOR_REVIEW = 'true';

  // Re-stamp config + copy the latest PWA into native/ so the lane archives current sources. (The lane
  // also runs `ns prepare ios --release`; sync here makes the wrapper config/PWA authoritative first.)
  await sync(cwd, flags);
  if (serverUrl) {
    stampShellConfig(outDir, stampCfg);
    console.log(`✓ ${submit ? 'Submit' : 'Release'} loader → ${serverUrl}${flags.env ? ` (env: ${flags.env})` : ''}`);
  }

  console.log(`▶ fastlane ios ${lane}  (cwd: ${outDir}/fastlane → native/)${env.APPWRAP_BUILD_NUMBER ? `  build #${env.APPWRAP_BUILD_NUMBER}` : ''}`);
  try {
    execFileSync('fastlane', ['ios', lane], { cwd: outDir, stdio: 'inherit', env });
  } catch {
    console.error(`\n✖ ${submit ? 'App Store submit' : 'TestFlight release'} failed. Common causes:\n` +
      '  • Missing ASC/match env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 (base64), MATCH_GIT_URL, MATCH_PASSWORD.\n' +
      '  • Certs/profiles not seeded — run `fastlane match appstore` once against MATCH_GIT_URL.\n' +
      '  • CFBundleVersion already used for this marketing version → pass a higher --build-number.');
    process.exit(1);
  }
  console.log(submit
    ? `✓ Binary promoted to the App Store (production)${env.APPWRAP_SUBMIT_FOR_REVIEW === 'true' ? ' and submitted for review' : ' — submit for review in App Store Connect (or pass --submit-for-review)'}.`
    : '✓ Uploaded to TestFlight (App Store Connect processing — check the build list / wait for the email).');
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

/** Files under TEMPLATE_DIR that are NOT build inputs, for fingerprinting. Deliberately a superset-keeper
 * vs `templateCopyFilter`: `modules-native/` IS excluded there (copied selectively per active module) but
 * IS compiled into bundle.js, so editing it MUST invalidate the cache — it stays in the fingerprint here.
 * `app/www` (PWA staging) is build OUTPUT and `node_modules`/`platforms`/`hooks` are generated, so all four
 * would make the hash unstable across runs. Matched RELATIVE to TEMPLATE_DIR: when installed from npm
 * TEMPLATE_DIR itself lives under node_modules/, and testing the absolute path would exclude everything. */
const templateFingerprintFilterFor = (root: string) => (src: string): boolean =>
  !/(?:^|\/)(node_modules|platforms|hooks|app\/www)(\/|$)/.test(src.slice(root.length));

/** Cheap fingerprint of SOURCE build inputs: mtime sum of the PWA dist/ + appwrap config + the appwrap
 * `runtime/` template tree + this CLI's version.
 * App_Resources/ (under the app's native/ outDir) is intentionally excluded — sync() rewrites it every
 * run, so its mtime always changes and would make the fingerprint permanently stale.
 * runtime/ IS included: it is compiled straight into bundle.js, so omitting it made a runtime edit print
 * "Skipping build — inputs unchanged" and then install an artifact carrying the PREVIOUS runtime — a
 * silent stale build that reads as a pass. CLI_VERSION covers codegen changes that touch no source file.
 * Cost: ~150 stat() calls on a 1MB tree, sub-millisecond — no need for content hashing.
 * Collision risk is acceptable — a false "match" just skips a redundant build, not a correctness bug. */
function mtimeStats(p: string): { sum: number; newest: number } {
  if (!existsSync(p)) return { sum: 0, newest: 0 };
  try {
    const s = statSync(p);
    if (s.isDirectory()) {
      let sum = 0, newest = 0;
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const c = mtimeStats(join(p, e.name));
        sum += c.sum;
        if (c.newest > newest) newest = c.newest;
      }
      return { sum, newest };
    }
    return { sum: s.mtimeMs, newest: s.mtimeMs };
  } catch { return { sum: 0, newest: 0 }; }
}

/** THE build-input set, walked once — the single source of truth for both consumers below:
 * `parts` (per-input mtime SUMS) feed the fingerprint hash; `newest` (max mtime across every input)
 * feeds the `--resume` staleness gate. Keeping them on one walk means an input can never be in the
 * hash but out of the gate (or vice versa) — that divergence is exactly how stale builds ship. */
function buildInputStats(cwd: string, cfg: { pwaDist?: string; overrides?: string }, flags: Record<string, string>): { parts: number[]; newest: number } {
  // Fingerprint EVERY app source the build actually consumes — not just dist. Missing the overrides dir
  // (native escape hatch) or a `.js`/`.json`/`--config` config file made edits there produce a stale
  // "inputs unchanged" skip. Resolve the real config path (ts→js→json / --config) instead of hardcoding.
  const distDir = cfg.pwaDist ? resolve(cwd, cfg.pwaDist) : join(cwd, 'dist');
  const overridesDir = resolve(cwd, cfg.overrides ?? 'appwrap.overrides');
  const stats = [mtimeStats(distDir), mtimeStats(overridesDir), mtimeStats(resolveConfigPath(cwd, flags))];
  // The appwrap runtime template(s) — bundled into bundle.js, so a first-class build input. Every
  // overlay root counts, so editing a host-provided template file busts the cache.
  let runtime = 0, runtimeNewest = 0;
  for (const root of TEMPLATE_ROOTS) {
   if (!existsSync(root)) continue;
   for (const rel of collectRelFiles(root, templateFingerprintFilterFor(root))) {
    const s = mtimeStats(join(root, rel));
    runtime += s.sum;
    if (s.newest > runtimeNewest) runtimeNewest = s.newest;
   }
  }
  stats.push({ sum: runtime, newest: runtimeNewest });
  return { parts: stats.map((s) => s.sum), newest: Math.max(...stats.map((s) => s.newest)) };
}

/** Newest mtime across every build input — the evidence the `--resume` gate needs when no build cache
 * exists to compare a fingerprint against. Same input set as `buildFingerprint` by construction. */
export function newestBuildInputMtime(cwd: string, cfg: { pwaDist?: string; overrides?: string }, flags: Record<string, string> = {}): number {
  return buildInputStats(cwd, cfg, flags).newest;
}

export function buildFingerprint(cwd: string, cfg: { pwaDist?: string; overrides?: string }, flags: Record<string, string> = {}): string {
  const { parts } = buildInputStats(cwd, cfg, flags);
  // Simple djb2-style hash — good enough for a build-skip check (not cryptographic).
  let h = 5381;
  for (const n of parts) h = (((h << 5) + h) ^ (n | 0)) >>> 0;
  // Mix in the CLI version — a `bunx appwrap` upgrade changes codegen without touching any app source.
  for (const c of CLI_VERSION) h = (((h << 5) + h) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** The iOS build-skip decision — pure, so it is testable without a device, an Xcode toolchain, or an .ipa.
 *
 * INVARIANT (the whole point of this function): a skip REQUIRES positive evidence that the existing .ipa
 * already contains the current inputs. Two forms of evidence are accepted:
 *   1. fingerprintMatch — the recorded cache fingerprint equals the current one. Strongest; the default.
 *   2. --resume with NO cache (manual Xcode build / first run) — nothing recorded a fingerprint, so we
 *      fall back to the .ipa being at least as new as every build input. An input touched after the .ipa
 *      was written provably postdates it, so the .ipa cannot contain it → rebuild.
 * `--resume` relaxes WHICH evidence is required; it never removes the requirement. Before this, form 2
 * was `resume && !cache` with NO comparison at all — `--resume` silently shipped stale .ipas, the exact
 * failure the fingerprint exists to kill. Android has no equivalent branch (strictly form 1).
 *
 * Honest limit: mtime proves the artifact POSTDATES its inputs, not that it was BUILT from them (a
 * hand-`touch`ed .ipa still fools it). That is the trust `--resume` explicitly asks for, and it is
 * strictly stronger than the unconditional skip it replaces. `--force` overrides everything.
 *
 * `adoptCache` → record the fingerprint for a form-2 skip, so every LATER run is gated by form 1. */
export function decideIosBuildSkip(o: {
  force: boolean;
  resume: boolean;
  fp: string;
  ipaPath?: string;
  ipaMtime: number;
  cache: BuildCache | null;
  newestInputMtime: () => number;
}): { skip: boolean; reason: string; adoptCache: boolean } {
  if (o.force) return { skip: false, reason: '', adoptCache: false };
  if (!o.ipaPath) return { skip: false, reason: '', adoptCache: false };
  if (o.cache) {
    return o.cache.fingerprint === o.fp && o.cache.artifactPath === o.ipaPath
      ? { skip: true, reason: 'inputs unchanged since last build', adoptCache: false }
      : { skip: false, reason: '', adoptCache: false };
  }
  if (!o.resume) return { skip: false, reason: '', adoptCache: false };
  return o.ipaMtime >= o.newestInputMtime()
    ? { skip: true, reason: '--resume (no cache; .ipa is newer than every build input)', adoptCache: true }
    : { skip: false, adoptCache: false, reason: '--resume ignored — the existing .ipa is older than a build input (it cannot contain your latest change); rebuilding.' };
}

// Per-platform build cache (iOS .ipa / Android .apk) — separate files so the two don't clobber each
// other's fingerprint (that's what enables the build-skip on BOTH platforms).
const buildCacheFile = (platform: string) => `.appwrap-build-cache-${platform}.json`;
export interface BuildCache { fingerprint: string; artifactPath: string; builtAt: string }

function readBuildCache(outDir: string, platform: string): BuildCache | null {
  try { return JSON.parse(readFileSync(join(outDir, buildCacheFile(platform)), 'utf8')); } catch { return null; }
}
function writeBuildCache(outDir: string, platform: string, cache: BuildCache): void {
  try { writeFileSync(join(outDir, buildCacheFile(platform)), JSON.stringify(cache, null, 2)); } catch { /* non-fatal */ }
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

// ─── Shared device resolver ───────────────────────────────────────────────────────────────────────
// One helper used by deploy/run/debug/logs/publish so every command shares the SAME device-selection
// UX + last-device memory. Resolution order:
//   --device <id|name> → exact match (error if not connected)
//   -d                 → always show the interactive list + number prompt
//   else               → the LAST chosen device (persisted) if still connected; else the only one;
//                        else the interactive list; none → clear error. The choice is persisted on
//                        success so the next command (e.g. `run`→`logs`) reuses it without re-asking.
// Persist the last device under the wrapper outDir (already gitignored by consumers, like the build
// cache) — not the consumer root, so it never shows up as a stray untracked file.
const lastDeviceFile = (outDir: string, platform: string) => join(outDir, `.appwrap-last-device-${platform}`);
function readLastDevice(outDir: string, platform: string): string | null {
  try { return readFileSync(lastDeviceFile(outDir, platform), 'utf8').trim() || null; } catch { return null; }
}
function writeLastDevice(outDir: string, platform: string, id: string): void {
  try { writeFileSync(lastDeviceFile(outDir, platform), id); } catch { /* non-fatal */ }
}

/** Enumerate connected devices for a platform as a uniform DeviceInfo[] (iOS via devicectl, Android
 * via adb — adb serials enriched with the product model for a readable picker). */
function listDevices(platform: 'ios' | 'android'): DeviceInfo[] {
  if (platform === 'ios') return listIosDevices();
  const adb = androidAdb();
  return listAndroidDevices(adb).map((serial) => {
    let model = '';
    try { model = execFileSync(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model'], { encoding: 'utf8' }).trim(); } catch { /* offline */ }
    // A network adb serial is `host:port` (USB serials never contain ':') → label it wifi.
    return { id: serial, name: model || serial, model, transport: serial.includes(':') ? 'wifi' : 'usb' };
  });
}

/** Interactive number-prompt picker over a device list. */
function pickInteractively(devices: DeviceInfo[]): DeviceInfo {
  // No TTY (CI / piped) → Bun's prompt() returns null → "Invalid selection". Give a clear directive instead.
  if (!process.stdout.isTTY) {
    console.error(`✖ ${devices.length} devices connected and no TTY to prompt — pass --device <id>. Connected: ${devices.map((d) => d.id).join(', ')}`);
    process.exit(1);
  }
  console.log('Connected devices:');
  devices.forEach((d, i) => console.log(`  ${i + 1}) ${d.name}${d.model && d.model !== d.name ? ` — ${d.model}` : ''}${d.transport ? ` [${d.transport}]` : ''}  (${d.id})`));
  const ans = (globalThis as { prompt(msg?: string): string | null }).prompt(`Select device [1-${devices.length}]: `);
  const idx = Number(ans) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= devices.length) { console.error('✖ Invalid selection.'); process.exit(1); }
  return devices[idx];
}

/** Resolve the target device for a platform command (the reusable core). Persists the choice under
 * `outDir` so the next command (e.g. `run`→`logs`) reuses it. */
function resolveDevice(outDir: string, platform: 'ios' | 'android', flags: Record<string, string>): DeviceInfo {
  const adb = platform === 'android' ? androidAdb() : '';

  // --wifi (android): flip a USB device to wireless adb (or reconnect a remembered one), then target it.
  if (platform === 'android' && 'wifi' in flags) enableWifiAdb(adb, outDir, flags);

  // --device <ip[:port]> (android): if it's a network target that isn't attached yet, `adb connect` it.
  if (platform === 'android' && flags.device && looksLikeAdbHost(flags.device)) {
    const target = withAdbPort(flags.device);
    if (!listAndroidDevices(adb).includes(target)) { adbConnect(adb, target); flags.device = target; }
  }

  let devices = listDevices(platform);
  const noneMsg = platform === 'ios'
    ? '✖ No connected iOS device found. Plug in via USB (unlocked, "Trust") or pair over Wi-Fi.'
    : '✖ No authorized Android device.\n  USB: plug in + accept "Allow USB debugging".\n  Wireless: `appwrap dev android --wifi` (flip a USB device to wireless), enable the phone\'s "Wireless debugging" (auto-discovered via mDNS), or `--device <ip[:port]>` (an already-paired device).\n  (check with `adb devices`)';

  // --device <id|name> — exact (or unambiguous prefix) match against connected devices.
  if (flags.device) {
    const m = devices.find((d) => d.id === flags.device || d.name === flags.device) ?? devices.find((d) => d.id.startsWith(flags.device));
    if (!m) { console.error(`✖ --device "${flags.device}" not connected/authorized. Connected: ${devices.map((d) => d.id).join(', ') || '(none)'}`); process.exit(1); }
    writeLastDevice(outDir, platform, m.id);
    return m;
  }

  // Android: nothing attached but a wireless device was remembered → auto-reconnect it (survives sleep /
  // USB-unplug, so plain `appwrap dev android` keeps working cordless after the first `--wifi`).
  if (platform === 'android' && !('d' in flags)) {
    const last = readLastDevice(outDir, 'android');
    if (last && last.includes(':') && !devices.find((d) => d.id === last) && adbConnect(adb, last)) devices = listDevices(platform);
  }

  // Android passive discovery (iOS parity): still nothing → pick up any mDNS-advertised wireless device
  // (tcpip / "Wireless debugging" on) and adb-connect it, so plain `dev android` finds it with no flag —
  // the same zero-config a network-paired iPhone gets from devicectl.
  if (platform === 'android' && devices.length === 0 && !flags.device) {
    const found = androidMdnsTargets(adb).filter((t) => !listAndroidDevices(adb).includes(t) && adbConnect(adb, t));
    if (found.length) devices = listDevices(platform);
  }

  if (devices.length === 0) { console.error(noneMsg); process.exit(1); }

  // -d → always prompt. Otherwise prefer the remembered device, then the sole device.
  if (!('d' in flags)) {
    const last = readLastDevice(outDir, platform);
    const remembered = last ? devices.find((d) => d.id === last) : undefined;
    if (remembered) { console.log(`📱 Using ${remembered.name} (${remembered.id}) — last used.`); return remembered; }
    if (devices.length === 1) { console.log(`📱 Using ${devices[0].name} (${devices[0].id}) — only device connected.`); writeLastDevice(outDir, platform, devices[0].id); return devices[0]; }
  }
  const picked = pickInteractively(devices);
  writeLastDevice(outDir, platform, picked.id);
  return picked;
}

/** `appwrap deploy <ios|android> [--device <id|name>] [--no-launch]` — build for a device, auto-pick
 * the connected phone (USB or network; prompts if several), install + launch. Debug build (no
 * distribution signing) — for testing on your own device. Run the PWA build first (or via the script).
 * iOS has a bespoke Debug-IPA path (below); Android uses the adb toolchain (build → install → launch).
 * `dev` calls THIS shared path for its clean device deploy — deploy is the one-shot ship primitive. */
/** The project's web-build command: explicit `webBuild` in config, else `bun run build` if the
 * project's package.json has a "build" script. null when there's nothing to run. */
function detectWebBuildCmd(cwd: string, cfg: AppwrapConfig): string[] | null {
  const explicit = (cfg as { webBuild?: string }).webBuild;
  if (explicit) return explicit.trim().split(/\s+/);
  try {
    const pj = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (pj.scripts?.build) return ['bun', 'run', 'build'];
  } catch { /* no package.json */ }
  return null;
}

/** Build the web bundle before a device deploy, but ONLY for a bundled loader — a `loader:'server'`
 * app loads the live serverUrl, so its dist is unused (building it would be wasteful + misleading).
 * Prints exactly what it's doing either way. `--no-web-build` skips it (ship the current dist as-is,
 * e.g. to hit the native build-skip fast-path when only the wrapper changed). */
export function buildWebIfBundled(cwd: string, cfg: AppwrapConfig, flags: Record<string, string>): void {
  if ((cfg.loader ?? 'app') === 'server') {
    console.log('ℹ loader:server — NOT building the web (the app loads serverUrl live; the bundle is unused).');
    return;
  }
  if ('no-web-build' in flags) {
    console.log('ℹ --no-web-build — shipping the CURRENT dist/ as-is (web NOT rebuilt).');
    return;
  }
  const cmd = detectWebBuildCmd(cwd, cfg);
  if (!cmd) {
    console.warn('⚠ Bundled loader but no web-build command (no package.json "build" script / `webBuild` config). Shipping the CURRENT dist/ — it may be STALE.');
    return;
  }
  console.log(`▶ ${cmd.join(' ')}  (bundled loader → fresh web bundle so dist isn't stale)`);
  execFileSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit' });
}

/** Resolve adb: $ANDROID_HOME/$ANDROID_SDK_ROOT platform-tools, else `adb` on PATH. */
function androidAdb(): string {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (home) {
    const p = join(home, 'platform-tools', 'adb');
    if (existsSync(p)) return p;
  }
  return 'adb';
}

/** Synchronous sleep — the device-resolution path is all sync execFileSync, so we can't await. */
function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** A `--device` value that looks like a network target (ip / hostname[:port]) vs a USB serial — USB
 * adb serials are bare alphanumerics, never containing a '.' (ip/host) or ':' (host:port). */
function looksLikeAdbHost(s: string): boolean { return s.includes('.') || s.includes(':'); }
/** Normalize a wireless target to host:port (adb's default tcpip port is 5555). */
function withAdbPort(host: string): string { return /:\d+$/.test(host) ? host : `${host}:5555`; }

/** `adb connect <target>` — true if connected (or already was). Prints the outcome. */
function adbConnect(adb: string, target: string): boolean {
  try {
    const out = execFileSync(adb, ['connect', target], { encoding: 'utf8' }).trim();
    const ok = /connected to|already connected/i.test(out);
    console.log(ok ? `🔗 ${out}` : `⚠ adb connect ${target}: ${out}`);
    return ok;
  } catch (e) {
    console.error(`⚠ adb connect ${target} failed: ${execErrText(e).trim()}`);
    return false;
  }
}

/** mDNS-discovered wireless adb targets (`ip:port`) — the passive path that matches iOS devicectl's
 * network listing. The device advertises once tcpip is on (`--wifi`) or Android-11+ "Wireless debugging"
 * is enabled, so `appwrap dev android` finds it with NO flag (parity with `dev ios` over the network). */
function androidMdnsTargets(adb: string): string[] {
  try {
    return execFileSync(adb, ['mdns', 'services'], { encoding: 'utf8', timeout: 8000 })
      .split('\n')
      .map((l) => l.match(/(\d+\.\d+\.\d+\.\d+:\d+)\s*$/)?.[1])
      .filter((x): x is string => !!x);
  } catch { return []; }
}

/** Read a USB-connected device's Wi-Fi (wlan0) IPv4, or null if it isn't on Wi-Fi. */
function androidWifiIp(adb: string, serial: string): string | null {
  for (const args of [
    ['-s', serial, 'shell', 'ip', '-o', 'route', 'get', '1.1.1.1'],   // "... src 192.168.1.50"
    ['-s', serial, 'shell', 'ip', '-o', '-f', 'inet', 'addr', 'show', 'wlan0'], // "inet 192.168.1.50/24"
  ]) {
    try {
      const m = execFileSync(adb, args, { encoding: 'utf8' }).match(/(?:src|inet)\s+(\d+\.\d+\.\d+\.\d+)/);
      if (m && !m[1].startsWith('127.')) return m[1];
    } catch { /* try next */ }
  }
  return null;
}

/** `--wifi`: flip a USB-connected device into TCP/IP mode and `adb connect` it over the LAN, so the user
 * can unplug and keep iterating cordless. If nothing's on USB but a wireless device was remembered, just
 * reconnect that. Sets `flags.device` to the wireless target (and clears `wifi`) so the rest of the
 * resolve/deploy path — and any later resolveDevice call — targets it without re-flipping. */
function enableWifiAdb(adb: string, outDir: string, flags: Record<string, string>): void {
  const usb = listAndroidDevices(adb).filter((s) => !s.includes(':')); // USB-attached serials only
  if (usb.length === 0) {
    const last = readLastDevice(outDir, 'android');
    if (last && last.includes(':') && adbConnect(adb, last)) { flags.device = last; delete flags.wifi; return; }
    console.error('✖ --wifi needs a USB-connected device to flip to wireless (none found). Plug in once + accept "Allow USB debugging", or pass --device <ip[:port]> for an already-paired device.');
    process.exit(1);
  }
  const serial = flags.device && usb.includes(flags.device) ? flags.device : usb[0];
  if (usb.length > 1 && serial === usb[0] && !(flags.device && usb.includes(flags.device))) {
    console.log(`  (multiple USB devices; flipping ${serial} — pass --device <serial> to choose another)`);
  }
  const ip = androidWifiIp(adb, serial);
  if (!ip) { console.error(`✖ Couldn't read ${serial}'s Wi-Fi IP — is it on Wi-Fi? (try: adb -s ${serial} shell ip route)`); process.exit(1); }
  console.log(`📶 ${serial}: enabling wireless adb on :5555…`);
  try { execFileSync(adb, ['-s', serial, 'tcpip', '5555'], { stdio: 'pipe' }); }
  catch (e) { console.error(`✖ adb tcpip failed: ${execErrText(e).trim()}`); process.exit(1); }
  const target = `${ip}:5555`;
  // tcpip restarts adbd on the device — connect with a few retries while it comes back up.
  let connected = false;
  for (let i = 0; i < 6 && !connected; i++) { sleepSync(700); connected = adbConnect(adb, target); }
  if (!connected) { console.error(`✖ Couldn't connect to ${target} after tcpip — same Wi-Fi network? firewall blocking :5555?`); process.exit(1); }
  writeLastDevice(outDir, 'android', target);
  console.log(`✓ Wireless adb ready → ${target}. You can unplug USB now.`);
  flags.device = target;
  delete flags.wifi;
}

/** Authorized (`device` state) adb serials. Skips `unauthorized`/`offline`. */
function listAndroidDevices(adb: string): string[] {
  try {
    return execFileSync(adb, ['devices'], { encoding: 'utf8' })
      .split('\n').slice(1)
      .filter((l) => /\tdevice\b/.test(l))
      .map((l) => l.split('\t')[0].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** `appwrap deploy android` — ONE-SHOT device deploy, the Android twin of `deploy ios`: sync + debug
 * config → `ns build android` (debug APK) → `adb install -r` to the device → launch (unless --no-launch)
 * → exit. Unlike `run android` (ns watch-mode), it doesn't stay attached. NOTE: like `deploy ios`, it
 * ships the CURRENT `dist/` — build the web first (`bun run build`, or use the `bun run android` script). */
async function deployAndroid(cwd: string, flags: Record<string, string>, cfgOverride?: AppwrapConfig): Promise<void> {
  const cfg = cfgOverride ?? await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }
  const adb = androidAdb();
  const device = resolveDevice(outDir, 'android', flags).id; // shared resolver (fail fast before the build)

  buildWebIfBundled(cwd, cfg, flags);                  // bundled → fresh web bundle; server → skip (both printed)
  await sync(cwd, flags, cfgOverride);                 // re-stamp config + copy latest PWA dist
  stampDeployShellConfig(outDir, cfg);                 // forces debug:true — see the helper's doc for why + the trap

  const apk = join(outDir, 'platforms/android/app/build/outputs/apk/debug/app-debug.apk');
  // Fingerprint build-skip (parity with deploy ios): skip the gradle build when dist + config + the
  // appwrap runtime/ are unchanged since the last build. --force/-f always rebuilds. (Rebuilding the web above usually
  // bumps the fingerprint; pair with --no-web-build to actually hit this fast-path.)
  const force = 'force' in flags || 'f' in flags;
  const fp = buildFingerprint(cwd, cfg, flags);
  const cache = readBuildCache(outDir, 'android');
  if (!force && existsSync(apk) && cache?.fingerprint === fp && cache?.artifactPath === apk) {
    console.log(`⚡ Skipping build — inputs unchanged since last build (${apk.split('/').pop()})`);
  } else {
    console.log(`▶ ns build android (debug)${force ? '  [--force]' : ''}`);
    runNs(outDir, ['build', 'android']);               // bun-installs deps if needed, then gradle build
    if (!existsSync(apk)) { console.error(`✖ No APK produced at ${apk}`); process.exit(1); }
    writeBuildCache(outDir, 'android', { fingerprint: fp, artifactPath: apk, builtAt: new Date().toISOString() });
  }

  console.log(`▶ installing → ${device}`);
  try {
    // `--user 0` (primary user) is the robust install target: on MIUI/Xiaomi a BARE `adb install` is
    // silently auto-denied ("user is restricted from installing apps" — no popup), but scoping it to
    // user 0 succeeds. On normal single-user devices it's a no-op (install already targets user 0).
    // Capture (not inherit) so we can still surface guidance if it fails for another reason.
    const out = execFileSync(adb, ['-s', device, 'install', '-r', '--user', '0', apk], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    process.stdout.write(out);
  } catch (e: unknown) {
    const log = execErrText(e);
    process.stderr.write(log);
    if (/INSTALL_FAILED_USER_RESTRICTED|user is restricted|canceled by user/i.test(log)) {
      console.error(
        '\n✖ Install blocked/canceled by the device (MIUI/Xiaomi restriction — NOT a build problem).\n' +
        '  → Unlock the phone and watch for the "Install via USB?" prompt → tap OK/Install.\n' +
        '  → Developer options: enable "Install via USB" AND "USB debugging (Security settings)".\n' +
        '    (Toggling these pings Xiaomi servers — needs mobile data + a SIM, no VPN.)\n' +
        `  The built APK is ready: ${apk}`
      );
    }
    process.exit(1);
  }

  if (!('no-launch' in flags)) {
    console.log(`▶ launching ${cfg.id}`);
    try {
      execFileSync(adb, ['-s', device, 'shell', 'monkey', '-p', cfg.id, '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
    } catch {
      console.error('⚠ Launch failed — the app is installed; tap its icon.');
    }
  }
  console.log(`✓ Deployed to ${device}.`);
}

async function deploy(cwd: string, flags: Record<string, string>, positionals: string[], cfgOverride?: AppwrapConfig): Promise<void> {
  const platform = positionals[0];
  if (platform === 'android') {
    // Parity with `deploy ios`: a clean ONE-SHOT build → install-to-device → launch → exit (NOT `ns run`,
    // which is watch-mode + hangs on some devices). Mirrors the iOS path with the adb toolchain.
    return deployAndroid(cwd, flags, cfgOverride);
  }
  if (platform !== 'ios') {
    console.error('Usage: appwrap deploy <ios|android> [--device <id|name>] [--no-launch]');
    process.exit(1);
  }
  const cfg = cfgOverride ?? await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native');
  if (!existsSync(outDir)) {
    console.error(`✖ Wrapper not found at ${outDir} — run \`appwrap init\` first`);
    process.exit(1);
  }
  // Pick the device up front so we fail fast before a long build if nothing's connected.
  const device = resolveDevice(outDir, 'ios', flags);

  buildWebIfBundled(cwd, cfg, flags); // bundled → fresh web bundle (no stale dist); server → skip (printed)
  await sync(cwd, flags, cfgOverride); // re-stamp config + copy latest PWA dist (+ vendor backend assets)
  // Dev deploy → debug mode forced: keep-awake + WebView inspector. See the helper's doc for the trap.
  stampDeployShellConfig(outDir, cfg);
  // Self-heal: drop platforms/ios if a prior `release`/`publish` left App-Store/manual signing there
  // (NS preserves it across prepares + it overrides build.xcconfig) → clean automatic dev signing.
  resetStaleSigningForAutoLane(outDir, cfg);

  const ipaDir = join(outDir, 'platforms/ios/build/Debug-iphoneos');

  // Smart resume: skip ns build (pod install + xcodebuild) when inputs haven't changed.
  // --resume (-r): additionally allow a skip when there is NO build cache yet (e.g. the .ipa came from a
  //   manual Xcode build, or this is the first run) — gated on the .ipa being newer than every build
  //   input. It relaxes WHICH evidence is required, never whether evidence is required.
  // Auto: always checks fingerprint; never skips if sources/deps changed.
  const resume = 'resume' in flags || 'r' in flags;
  const force = 'force' in flags || 'f' in flags;
  const fp = buildFingerprint(cwd, cfg, flags);
  const cache = readBuildCache(outDir, 'ios');
  const existingIpa = newestIpa(ipaDir);
  const decision = decideIosBuildSkip({
    force, resume, fp,
    ipaPath: existingIpa ? join(ipaDir, existingIpa) : undefined,
    ipaMtime: existingIpa ? statSync(join(ipaDir, existingIpa)).mtimeMs : 0,
    cache,
    newestInputMtime: () => newestBuildInputMtime(cwd, cfg, flags),
  });
  const { skip: canSkipBuild, adoptCache } = decision;

  if (canSkipBuild) {
    console.log(`⚡ Skipping build — ${decision.reason} (${existingIpa})`);
  } else {
    // Asked to resume but the .ipa predates a build input → say so instead of quietly rebuilding.
    if (decision.reason) console.log(`↻ ${decision.reason}`);
    // Manual signing (signing:'manual') → pass the main-app profile as --provision so NS emits a
    // manual exportOptions.plist covering the app + its extensions (see stampManualSigning sidecar).
    const nsArgs = ['build', 'ios', '--for-device'];
    try {
      const sc = JSON.parse(readFileSync(join(outDir, '.appwrap-signing.json'), 'utf8')) as { provision?: string };
      if (sc.provision) nsArgs.push('--provision', sc.provision);
    } catch { /* no sidecar → automatic signing */ }
    console.log(`▶ ns ${nsArgs.join(' ')}  (debug: keep-awake + inspector on)${force ? '  [--force: skipping cache]' : ''}`);
    const buildStart = Date.now();
    try {
      execFileSync('ns', nsArgs, { cwd: outDir, stdio: 'inherit' });
    } catch (e) {
      // exportArchive is the ACCOUNT-GATED step: with special entitlements (e.g. Associated Domains)
      // automatic-signing export must (re)provision via App Store Connect, which needs a live Xcode
      // account session — one Xcode 26 keeps silently dropping. The ARCHIVE itself signs fine from
      // locally cached profiles. So when a fresh signed .app exists in the xcarchive, resign it with
      // a local Xcode-managed dev profile + pack the ipa ourselves — no account, no network.
      const archiveApp = join(ipaDir, 'native.xcarchive/Products/Applications/native.app');
      let resigned = false;
      if (existsSync(archiveApp) && statSync(archiveApp).mtimeMs >= buildStart) {
        console.error('\n⚠ Export failed but the archive is built + signed — resigning from the archive with a local dev profile (no Apple account session needed)…');
        try {
          resigned = resignArchiveIpa(archiveApp, join(ipaDir, 'native.ipa'), cfg, device.id);
        } catch (fe) {
          console.error(`  resign fallback failed: ${fe instanceof Error ? fe.message : fe}`);
        }
      }
      if (!resigned) {
        // The xcodebuild dump above is cryptic; surface the signing failures we actually hit most.
        console.error(
          '\n✖ Device build failed — if the errors above mention signing:\n' +
            `  • "Failed Registering Bundle Identifier … not available" → the App ID "${cfg.id}" is already\n` +
            '    registered to another team (e.g. a prior free-team build). Change `id` in appwrap.config to a\n' +
            '    unique string and re-deploy.\n' +
            '  • "profile doesn\'t include the … entitlement" (e.g. HealthKit) → that capability needs a PAID\n' +
            '    team (Individual). A free Personal Team can\'t hold it — switch teamId or drop the module.\n' +
            '  • "No Account for Team" → sign that Apple ID into Xcode → Settings → Accounts first.\n' +
            '  • "requires a provisioning profile with the … feature" → the resign fallback above needs a\n' +
            '    LOCAL dev profile carrying that capability: build the app once from Xcode on this Mac\n' +
            '    (auto-signing mints + caches the profile for ~1 year), then re-run `appwrap deploy ios`.'
        );
        process.exit(1);
      }
    }
  }

  const builtIpa = newestIpa(ipaDir);
  const ipa = builtIpa;
  if (!ipa) { console.error(`✖ No .ipa produced in ${ipaDir}`); process.exit(1); }
  const ipaPath = join(ipaDir, ipa);
  // Write the cache after a real build, AND after a --resume skip: adopting the fingerprint converts
  // that one-time mtime-based trust into a recorded baseline, so EVERY later run is strictly
  // fingerprint-gated. Without this, --resume stayed in the no-cache branch forever — permanently
  // ungated. (A fingerprintMatch skip already has an identical cache; nothing to write.)
  if (!canSkipBuild || adoptCache) writeBuildCache(outDir, 'ios', { fingerprint: fp, artifactPath: ipaPath, builtAt: new Date().toISOString() });

  console.log(`▶ installing ${ipa} → ${device.name} [${device.transport}]`);
  let installedViaUsbmux = false;
  let installed = false;
  // A wireless (localNetwork) install of a multi-MB .ipa legitimately takes longer than a wired one —
  // 25s is a wired number; too tight for Wi-Fi, tripping the fallback on a healthy-but-slow install.
  const wireless = /localNetwork|wifi/i.test(device.transport);
  const installTimeout = wireless ? '120' : '25';
  // Capture (not inherit) so we can recognize specific failures; echo it for visibility. Wrapped so a
  // LOCKED device waits-and-retries. --timeout lets one attempt tolerate a brief locked/unavailable window.
  // BELT + SUSPENDERS on hangs: devicectl's own `--timeout` only covers device-side waits. A wedged
  // CoreDeviceService makes devicectl hang BEFORE that — silently, with zero output — so without a
  // process-level `timeout:` the exec blocks forever and the self-heal below never fires.
  const hardTimeoutMs = (Number(installTimeout) + 35) * 1000;
  const runDevicectlInstall = (): string => withUnlockRetry('Install', () =>
    execFileSync('xcrun', ['devicectl', 'device', 'install', 'app', '--timeout', installTimeout, '--device', device.id, ipaPath], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: hardTimeoutMs })
  );
  try {
    process.stdout.write(runDevicectlInstall());
    installed = true;
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
    } else if (isTimeoutKill(e) || /Command timeout|got stuck|could not be reached|Unable to connect to device/.test(log)) {
      // devicectl/CoreDevice is stuck — either it SAID so, or our process-level timeout had to kill a
      // silent zero-output hang (the wedged-CoreDeviceService signature). Usual cause: a pegged
      // CoreDeviceService daemon. SELF-HEAL: kill it (auto-respawns clean) and retry devicectl once —
      // this is the fix a human otherwise applies by hand, and it's the ONLY path that works for a
      // wireless-only device (usbmux is USB-only).
      if (killStuckCoreDeviceService()) {
        console.error('\n↻ CoreDevice tunnel was stuck (likely a pegged CoreDeviceService) — restarted it, retrying install…');
        try { process.stdout.write(runDevicectlInstall()); installed = true; }
        catch (e2) { process.stderr.write(execErrText(e2)); }
      }
      // Still stuck → usbmux (ideviceinstaller), which only helps a USB-reachable device.
      if (!installed) {
        console.error('\n⚠ devicectl still stuck — trying ideviceinstaller (usbmux, USB only)…');
        if (usbmuxInstall(ipaPath)) {
          installedViaUsbmux = true; installed = true;
        } else {
          console.error(
            '✖ Install failed: the CoreDevice tunnel stayed stuck and there is no usbmux (USB) path.\n' +
              (wireless
                ? '  This device is on Wi-Fi only — CoreDeviceService was just restarted, so simply RE-RUN\n' +
                  '    `appwrap deploy ios` (the .ipa is cached; it will only re-install). For the most reliable\n' +
                  '    path, plug in the USB cable.\n'
                : '  → Re-plug the USB cable (re-establishes the CoreDevice tunnel) and re-run, OR\n' +
                  '    `brew install ideviceinstaller` for a usbmux install path.\n') +
              `  The built .ipa is ready: ${ipaPath}`
          );
          process.exit(1);
        }
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
    console.log(`▶ launching ${cfg.id} (terminating any running instance first)`);
    try {
      // --terminate-existing: kill a suspended/running copy before launching, so the FRESHLY installed
      // binary actually runs. Without it, iOS resumes the old process and you see stale config (e.g. an
      // old serverUrl) despite a correct new build — masquerading as a build/cache bug. (A reinstall
      // over the top does NOT replace a running process; this avoids the manual uninstall dance.)
      withUnlockRetry('Launch', () =>
        execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--terminate-existing', '--timeout', installTimeout, '--device', device.id, cfg.id], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: hardTimeoutMs })
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
    const out = execFileSync('ideviceinstaller', ['install', ipaPath], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 300_000 });
    process.stdout.write(out);
    return /Complete|Installed/i.test(out);
  } catch (e: unknown) {
    process.stderr.write(execErrText(e));
    return false;
  }
}

/** Newest .ipa in a build dir by mtime — NOT the first directory entry: an export names its ipa after
 * the app (e.g. Blank.ipa) while the resign fallback writes native.ipa, and a stale one from a prior
 * run can coexist with (and alphabetically precede) the fresh artifact. */
function newestIpa(ipaDir: string): string | undefined {
  if (!existsSync(ipaDir)) return undefined;
  return readdirSync(ipaDir)
    .filter((f) => f.endsWith('.ipa'))
    .map((f) => ({ f, mtime: statSync(join(ipaDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.f;
}

/** Resign the archive's .app with a LOCAL Xcode-managed development profile and pack it into an ipa —
 * the no-account fallback for when `xcodebuild -exportArchive` fails (its automatic signing needs a
 * live Xcode account session; manual export refuses Xcode-managed profiles, so exportArchive is a
 * dead end both ways without one). Profile requirements: matches team+bundle id, development
 * (get-task-allow), unexpired, carries every configured entitlement key, includes the target device,
 * and lists a signing cert that is actually in the login keychain. Gotcha encoded here: the ipa MUST
 * be packed with `zip` — `ditto -c -k` stores macOS xattrs as `._*` AppleDouble entries, which
 * on-device installd rejects as "a signed resource has been added" (0xe8008017).
 * Returns true on success (ipa written to `ipaOut`); false → caller prints the manual remedies. */
function resignArchiveIpa(archiveApp: string, ipaOut: string, cfg: AppwrapConfig, coreDeviceId: string): boolean {
  if (existsSync(join(archiveApp, 'PlugIns'))) {
    console.error('  ✖ app has extensions (PlugIns/) — per-extension resigning is not supported; use the TestFlight lane.');
    return false;
  }
  const requiredEnts = Object.keys(cfg.iosEntitlements ?? {});
  const hwUdid = libimobiledeviceUdid()?.udid ?? null; // hardware UDID (≠ devicectl id); null → skip device check
  if (!hwUdid) console.error(`  ⚠ can't read the device hardware UDID (idevice_id) — picking a profile without verifying it covers device ${coreDeviceId}.`);

  // Signing certs actually present in the keychain, by SHA-1 (uppercase hex).
  const keychainCerts = new Set(
    [...execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
      .matchAll(/\b([0-9A-F]{40})\b/g)].map((m) => m[1])
  );

  const profileDirs = [
    join(process.env.HOME ?? '', 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
    join(process.env.HOME ?? '', 'Library/MobileDevice/Provisioning Profiles'),
  ];
  let best: { path: string; raw: string; team: string; certSha1: string; expires: number; name: string } | null = null;
  for (const dir of profileDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.mobileprovision'))) {
      const path = join(dir, f);
      let raw: string;
      try { raw = execFileSync('security', ['cms', '-D', '-i', path], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { continue; }
      const appId = raw.match(/<key>application-identifier<\/key>\s*<string>([A-Z0-9]+)\.([^<]+)<\/string>/);
      if (!appId || appId[2] !== cfg.id) continue;
      if (cfg.teamId && appId[1] !== cfg.teamId) continue;
      if (!/<key>get-task-allow<\/key>\s*<true\/>/.test(raw)) continue; // development profile only
      const exp = raw.match(/<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/);
      const expires = exp ? Date.parse(exp[1]) : 0;
      if (expires < Date.now()) continue;
      if (!requiredEnts.every((k) => raw.includes(`<key>${k}</key>`))) continue;
      if (hwUdid && !raw.includes(`<string>${hwUdid}</string>`)) continue;
      // First profile cert that is also in the keychain (profiles list several historical certs).
      const certsBlock = raw.split('<key>DeveloperCertificates</key>')[1]?.split('</array>')[0] ?? '';
      const certSha1 = [...certsBlock.matchAll(/<data>([\s\S]*?)<\/data>/g)]
        .map((m) => createHash('sha1').update(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')).digest('hex').toUpperCase())
        .find((h) => keychainCerts.has(h));
      if (!certSha1) continue;
      const name = raw.match(/<key>Name<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? f;
      if (!best || expires > best.expires) best = { path, raw, team: appId[1], certSha1, expires, name };
    }
  }
  if (!best) {
    console.error(`  ✖ no local development profile matches ${cfg.id}${requiredEnts.length ? ` with [${requiredEnts.join(', ')}]` : ''} for this device.`);
    return false;
  }
  console.error(`  ↻ using profile "${best.name}" (expires ${new Date(best.expires).toISOString().slice(0, 10)}) + keychain cert ${best.certSha1.slice(0, 8)}…`);

  // Stage Payload/, swap in the profile, sign with entitlements derived from config + profile.
  const staging = join(tmpdir(), `appwrap-resign-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  const stagedApp = join(staging, 'Payload/native.app');
  mkdirSync(join(staging, 'Payload'), { recursive: true });
  cpSync(archiveApp, stagedApp, { recursive: true });
  cpSync(best.path, join(stagedApp, 'embedded.mobileprovision'));
  const plistValue = (v: unknown): string => Array.isArray(v)
    ? `<array>${v.map((x) => `<string>${x}</string>`).join('')}</array>`
    : typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : `<string>${String(v)}</string>`;
  const entPlist = join(staging, 'entitlements.plist');
  writeFileSync(entPlist,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    `\t<key>application-identifier</key><string>${best.team}.${cfg.id}</string>\n` +
    `\t<key>com.apple.developer.team-identifier</key><string>${best.team}</string>\n` +
    '\t<key>get-task-allow</key><true/>\n' +
    `\t<key>keychain-access-groups</key><array><string>${best.team}.*</string></array>\n` +
    Object.entries(cfg.iosEntitlements ?? {}).map(([k, v]) => `\t<key>${k}</key>${plistValue(v)}\n`).join('') +
    '</dict>\n</plist>\n');
  // Nested code first (sealed into the app signature), then the app itself with the entitlements.
  const frameworksDir = join(stagedApp, 'Frameworks');
  const nested = existsSync(frameworksDir) ? readdirSync(frameworksDir).filter((f) => /\.(framework|dylib)$/.test(f)) : [];
  for (const f of nested) execFileSync('codesign', ['-f', '-s', best.certSha1, '--timestamp=none', join(frameworksDir, f)], { stdio: 'pipe' });
  execFileSync('codesign', ['-f', '-s', best.certSha1, '--timestamp=none', '--entitlements', entPlist, stagedApp], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', stagedApp], { stdio: 'pipe' });
  rmSync(ipaOut, { force: true });
  execFileSync('zip', ['-qry', ipaOut, 'Payload'], { cwd: staging, stdio: 'pipe' }); // zip, NOT ditto — see docblock
  rmSync(staging, { recursive: true, force: true });
  console.error(`  ✓ resigned ipa ready: ${ipaOut}`);
  return true;
}

/** Apple's `CoreDeviceService` daemon intermittently pegs a CPU core at 100% and wedges the device
 * tunnel — `devicectl` then hangs until its timeout (worse on a wireless/localNetwork target). Killing
 * it is the documented remedy: launchd auto-respawns it clean. `remotepairingd` (also user-owned)
 * holds the pairing side of the same tunnel and wedges WITH it — kill both; restarting only one is
 * not enough to recover a wedged stack. Returns true if either kill matched a process. */
function killStuckCoreDeviceService(): boolean {
  let matched = false;
  for (const pattern of ['CoreDeviceService.xpc', 'remotepairingd']) {
    try { execFileSync('pkill', ['-9', '-f', pattern], { stdio: 'ignore' }); matched = true; }
    catch { /* pkill exits non-zero when nothing matched */ }
  }
  if (matched) sleepSync(4000); // let launchd respawn them + re-establish the tunnel before we retry
  return matched;
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
      // devicectl/CoreDevice tunnel STUCK (it switches to a [wired] path and hangs, or hangs silently
      // until our process-level timeout kills it) is NOT a lock — retrying as "waiting for unlock" is
      // pointless + misleading. Re-throw so the caller can self-heal / fall back.
      if (isTimeoutKill(e) || /Command timeout|got stuck|could not be reached|Unable to connect to device/.test(log)) throw e;
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
  if (platform !== 'ios' && platform !== 'android') {
    console.error('Usage: appwrap logs <ios|android> [--once] [--native] [--device <id|name>]');
    process.exit(1);
  }
  const cfg = await loadConfig(cwd, flags);
  const outDir = resolve(cwd, flags.out ?? 'native'); // for last-device memory (shared resolver)

  // ── Android: adb logcat — WebView console (chromium tag) by default; --native = full app logcat ──
  if (platform === 'android') {
    const adb = androidAdb();
    const device = resolveDevice(outDir, 'android', flags).id;
    const once = 'once' in flags;
    if ('native' in flags) {
      const pid = (() => { try { return execFileSync(adb, ['-s', device, 'shell', 'pidof', cfg.id], { encoding: 'utf8' }).trim().split(/\s+/)[0]; } catch { return ''; } })();
      console.log(`▶ logcat for ${cfg.id}${pid ? ` (pid ${pid})` : ' (not running — full stream)'}${once ? ' [once]' : ''} — Ctrl-C to stop.`);
      try { execFileSync(adb, ['-s', device, 'logcat', ...(once ? ['-d'] : []), ...(pid ? ['--pid', pid] : [])], { stdio: 'inherit' }); } catch { process.exit(1); }
      return;
    }
    console.log(`▶ WebView console (chromium) for ${cfg.id}${once ? ' [once]' : ''} — Ctrl-C to stop.  (--native for full app logcat)`);
    try { execFileSync(adb, ['-s', device, 'logcat', ...(once ? ['-d'] : []), '-s', 'chromium:I'], { stdio: 'inherit' }); } catch { process.exit(1); }
    return;
  }

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

  const device = resolveDevice(outDir, 'ios', flags);
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
  // Self-terminate when orphaned: if our controlling session dies, macOS reparents us to launchd and
  // this loop would otherwise poll `devicectl` FOREVER — every stale session stacking load until
  // CoreDeviceService pins a core at 100%. NOTE: `process.ppid` is cached at startup and does NOT
  // update on reparent, so probe the ORIGINAL parent's liveness with signal 0 (throws once it's gone);
  // also stop on a broken stdout pipe (consumer gone).
  const parentPid = process.ppid;
  const orphaned = (): boolean => { try { process.kill(parentPid, 0); return false; } catch { return true; } };
  for (;;) {
    if (orphaned()) break; // original parent gone → we've been reparented → stop
    const all = pull();
    if (all.length < shown) shown = 0; // app relaunched → file reset; reprint
    if (all.length > shown) {
      try { process.stdout.write(all.slice(shown)); } catch { break; } // pipe closed → consumer gone
      shown = all.length;
    }
    try { execFileSync('sleep', ['3']); } catch { break; }
  }
}

/** `appwrap publish <ios|android> [prod]` — distribution. DEFAULT = BETA (iOS TestFlight via the
 * proven `release` lane; Android → Play internal track via the mcp-appstores `android-upload` CLI).
 * `prod` → store (iOS App Store via `submit`; Android Play production track). Consolidates the existing
 * `release`/`submit` (kept as aliases). Android upload reuses the same contract as the CI release
 * workflow: a signed AAB from `build android --release --aab` + `APPSTORES_REGISTRY` env for the Play
 * service-account/package mapping (see the emitted appwrap-release-android.yml). */
async function publish(cwd: string, flags: Record<string, string>, positionals: string[]): Promise<void> {
  const platform = positionals[0];
  const prod = positionals[1] === 'prod';
  if (platform !== 'ios' && platform !== 'android') {
    console.error('Usage: appwrap publish <ios|android> [prod]   (default: beta — TestFlight / Play internal)');
    process.exit(1);
  }
  if (platform === 'ios') {
    // iOS rides the proven fastlane path unchanged: beta → TestFlight, prod → App Store promote.
    return release(cwd, flags, ['ios'], prod ? 'release' : 'beta');
  }

  // ── Android: build a signed AAB, then upload via the mcp-appstores CLI (Play Developer API). ──
  const track = flags.track || (prod ? 'production' : 'internal');
  console.log(`▶ appwrap build android --release --aab  (for Play ${track} track)`);
  await build(cwd, { ...flags, release: '', aab: '' }, ['android']);
  const aab = join(resolve(cwd, flags.out ?? 'native'), 'platforms/android/app/build/outputs/bundle/release/app-release.aab');
  if (!existsSync(aab)) { console.error(`✖ No AAB produced at ${aab}`); process.exit(1); }

  if (!process.env.APPSTORES_REGISTRY) {
    console.error(
      '\n✖ Android publish needs the Play upload contract (same as the CI release workflow):\n' +
      '  • APPSTORES_REGISTRY env — JSON mapping org→serviceAccountPath + app→packageName.\n' +
      '  • A Play service-account JSON + the app already created in the Play Console (one prior manual release).\n' +
      `  The signed AAB is ready: ${aab}\n` +
      '  Then: APPSTORES_ALLOW_WRITES=true bunx @livx.cc/mcp-appstores android-upload \\\n' +
      `      --org <org> --app <app> --file "${aab}" --track ${track} --status completed`
    );
    process.exit(1);
  }
  const org = flags.org || (await loadConfig(cwd, flags)).id;
  const app = flags.app || 'app';
  console.log(`▶ bunx @livx.cc/mcp-appstores android-upload --org ${org} --app ${app} --track ${track}`);
  try {
    execFileSync('bunx', ['@livx.cc/mcp-appstores', 'android-upload', '--org', org, '--app', app, '--file', aab, '--track', track, '--status', 'completed'],
      { cwd, stdio: 'inherit', env: { ...process.env, APPSTORES_ALLOW_WRITES: process.env.APPSTORES_ALLOW_WRITES ?? 'true' } });
  } catch {
    console.error(`\n✖ Play upload failed. Check APPSTORES_REGISTRY (org "${org}", app "${app}") + the service-account permissions. The AAB is ready: ${aab}`);
    process.exit(1);
  }
  console.log(`✓ Uploaded to Play ${track} track.`);
}

/** Scaffold a new module pack from the built-in template — the community entry point for authoring an
 * extension. `appwrap create-module <name> [--dir <parent>]` writes <parent>/<name>/ with a manifest +
 * handler + native-src stub, substituting the module name (and its PascalCase form) into the tokens,
 * then validates the result so a fresh scaffold is guaranteed pack-conformant. */
async function createModule(cwd: string, flags: Record<string, string>, positionals: string[]): Promise<void> {
  const name = positionals[0];
  if (!name || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) {
    console.error('Usage: appwrap create-module <name> [--dir <parent>]\n  <name> must be a camelCase capability id (letters/digits, leading letter), e.g. `confetti`.');
    process.exit(1);
  }
  if (!existsSync(MODULE_PACK_TEMPLATE_DIR)) {
    console.error(`✖ module-pack template not found at ${MODULE_PACK_TEMPLATE_DIR}`);
    process.exit(1);
  }
  const pascal = name.replace(/(^|[-_])(\w)/g, (_m, _s, c: string) => c.toUpperCase());
  const dest = resolve(cwd, flags.dir ?? '.', name);
  if (existsSync(dest)) {
    console.error(`✖ ${dest} already exists — choose a different name or --dir.`);
    process.exit(1);
  }
  // Copy the scaffold, then substitute the name tokens in every text file + rename the token'd native-src dir.
  cpSync(MODULE_PACK_TEMPLATE_DIR, dest, { recursive: true });
  const rename = (from: string, to: string) => { if (existsSync(from)) renameSync(from, to); };
  rename(join(dest, 'native-src/__MODULE_NAME__'), join(dest, 'native-src', name));
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|md|json|swift|kt|xml)$/.test(e.name)) {
        writeFileSync(p, readFileSync(p, 'utf8').replaceAll('__MODULE_NAME__', name).replaceAll('__MODULE_PASCAL__', pascal));
      }
    }
  };
  walk(dest);
  const { validatePack } = await import('./testing');
  const res = await validatePack(dest);
  if (!res.ok) {
    console.error(`✖ scaffolded pack failed validation (this is a bug in the template):\n  ${res.errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`✓ Created module pack '${name}' → ${dest}`);
  console.log(`  Reference it from your appwrap.config.ts:`);
  console.log(`    modulePacks: ['${flags.dir ? join(flags.dir, name) : `./${name}`}'],`);
  console.log(`    modules: ['${name}', ...],`);
}

/**
 * The CLI entry point — the bare `appwrap` bin calls `runCli()` with no options (identical to the
 * historical `main`). A host calls `runCli({ commands, platforms, modulePacks,
 * templateRoots, desktopTemplateDir })` to compose extra capability on top without forking it.
 */
export async function runCli(options: CliOptions = {}): Promise<void> {
  cliOptions = { ...options };
  if (options.desktopTemplateDir) DESKTOP_TEMPLATE_DIR = options.desktopTemplateDir;
  // Host template overlays land AFTER the built-in runtime template → they win (file-level last-wins).
  if (options.templateRoots?.length) TEMPLATE_ROOTS = [...TEMPLATE_ROOTS, ...options.templateRoots];

  const { command, flags, positionals } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  // Host-provided commands are consulted first — they can add a new command or override a built-in.
  if (command && cliOptions.commands?.[command]) { await cliOptions.commands[command](cwd, flags, positionals); return; }

  switch (command) {
    case 'init':
      await init(cwd, flags);
      break;
    case 'sync':
      await sync(cwd, flags);
      break;
    case 'create-module':
      await createModule(cwd, flags, positionals);
      break;
    case 'clean':
      await clean(cwd, flags);
      break;
    case 'dev':
      await dev(cwd, flags, positionals);
      break;
    case 'run': // hidden back-compat alias → dev
      await dev(cwd, flags, positionals);
      break;
    case 'build':
      await build(cwd, flags, positionals);
      break;
    case 'deploy':
      await deploy(cwd, flags, positionals);
      break;
    case 'publish':
      await publish(cwd, flags, positionals);
      break;
    case 'release': // alias: publish <ios|android> (beta)
      await release(cwd, flags, positionals, 'beta');
      break;
    case 'submit': // alias: publish <ios> prod
      await release(cwd, flags, positionals, 'release');
      break;
    case 'logs':
      await logs(cwd, flags, positionals);
      break;
    case 'debug': // hidden back-compat alias → dev --debug
      await dev(cwd, { ...flags, debug: '' }, positionals);
      break;
    default:
      console.log('Usage: appwrap <init|sync|dev|build|deploy|publish|logs> [--config <path>] [--out native]\n' +
        '  config: appwrap.config.ts (preferred) → .js → appwrap.json\n' +
        '  Device selection (dev/deploy/logs/publish): --device <id|name|ip[:port]> | -d (pick from a list) | else last-used / sole device.\n' +
        '  Android wireless: --wifi flips a USB device to wireless adb (unplug + keep going); thereafter the\n' +
        '       device is auto-discovered via mDNS — plain `dev android` finds it with NO flag (iOS parity).\n' +
        '       --device <ip[:port]> `adb connect`s an already-paired one.\n\n' +
        '  dev <ios|android> [--sim] [--detached] [--debug] [--wifi] [--url <devserver>|--port <p>]\n' +
        '       live-dev: ANDROID device → ns run livesync (true on-device HMR) + re-stage on save;\n' +
        '       iOS device → deploy + rebuild/reinstall on save. --sim = ns run/HMR on emulator;\n' +
        '       --url/--port = web HMR from a dev server inside the WebView; --detached = install & exit.\n' +
        '  deploy <ios|android> [--no-launch] [--no-web-build] [-f]   (clean ship-once: build → install → launch → exit)\n' +
        '  publish <ios|android> [prod]              (beta: TestFlight / Play internal. prod: App Store / Play production)\n' +
        '  build <ios|android> [--release] [--aab]   (store artifact only — no install/upload)\n' +
        '  logs <ios|android> [--once] [--native]    (stream WebView console; --native = full OS log)\n' +
        '  clean                                     (ns clean: wipe generated platforms/hooks/node_modules, restore deps — fixes stale/corrupt Podfile after a repo move)\n' +
        '  create-module <name> [--dir <parent>]     (scaffold a new module pack — a swappable/extensible capability; see modulePacks)\n' +
        '  aliases: `release ios` = `publish ios`; `submit ios` = `publish ios prod`.');
      process.exit(command ? 1 : 0);
  }
}

if (import.meta.main) {
  runCli();
}
