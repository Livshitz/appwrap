/**
 * Module-pack resolver — the single public extension seam of appwrap.
 *
 * A "pack" is a directory (local, or an npm package) that contributes capabilities to a wrapper build
 * exactly like the built-in modules do: it exports `ModuleManifest[]` (the same contribution bags the
 * built-ins use — permissions/entitlements/gradleDeps/nativeSrc/handler), plus the handler source and
 * optional native source those manifests reference. The built-in modules are treated as *pack 0*; the
 * config's `modulePacks` apply on top, in order.
 *
 * Merge policy (name-keyed):
 *  - a pack module whose `name` is NEW → added;
 *  - a pack module whose `name` already exists (from a different pack) → LAST-WINS, wholesale-shadowing
 *    the earlier module (its whole manifest + handler + native source), with a provenance log line;
 *  - a duplicate name WITHIN one pack → idempotent (later entry wins silently — a pack re-exporting its
 *    own module is not an error).
 *
 * This one mechanism serves three audiences identically: a host layers its private packs, a consumer
 * app vendors its own copy of a module, and the community ships plugins — none of them patch the core.
 *
 * PURE of CLI I/O: filesystem/npm resolution and pack import are injected ports (`resolvePack`/
 * `importPack`), so the merge logic unit-tests against in-memory fakes. The CLI wires the real ports.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModuleManifest } from '../../../runtime/app/shell/capabilities.manifest';

/** Build-time context a pack's manifest may depend on (platform/env/CI). Manifest entries may be
 * `(ctx) => ModuleManifest` so a pack can contribute different bags per platform/env without the
 * downstream derivation (nativeReqs) knowing packs exist — thunks are resolved to plain values here. */
export interface SyncContext {
  /** The lane being generated. 'both' when a single sync stamps a cross-platform wrapper. */
  platform: 'ios' | 'android' | 'both';
  /** Resolved environment name (e.g. 'prod', 'lab', 'default'). */
  env: string;
  /** True in CI. */
  ci: boolean;
}

/** A manifest entry as authored in a pack: a plain manifest, or a fn of the sync context. */
export type ModuleEntry = ModuleManifest | ((ctx: SyncContext) => ModuleManifest);

/** The shape a pack's manifest module must export (as `default` or named `pack`). `modules` may be a
 * plain array, or a fn of the context (for a pack whose whole set is context-dependent). */
export interface PackModule {
  /** The manifest schema version this pack targets — checked against MANIFEST_SCHEMA_VERSION. */
  manifestSchemaVersion: number;
  /** The capabilities this pack contributes. */
  modules: ModuleEntry[] | ((ctx: SyncContext) => ModuleEntry[]);
}

/** A merged module + where it came from (for provenance + to locate its handler/native source). */
export interface ResolvedModule {
  /** The module's contribution bags, with any context thunks resolved to plain values. */
  manifest: ModuleManifest;
  /** Provenance label: BUILTIN_SOURCE for a built-in, else the pack ref as written in `modulePacks`. */
  source: string;
  /** Absolute pack directory — the base for resolving this module's `handler.file` / `nativeSrc` /
   * kit client. `null` for a built-in (those live under the runtime template, wired by the CLI). */
  packDir: string | null;
}

/** Provenance label used for the built-in modules (pack 0). */
export const BUILTIN_SOURCE = '(built-in)';

export interface ResolvePacksOptions {
  /** The built-in modules — pack 0. */
  builtins: ModuleManifest[];
  /** The manifest schema version the built-ins (and this CLI) speak. */
  builtinSchemaVersion: number;
  /** The config's `modulePacks` (local dirs or npm names), applied in order after the built-ins. */
  packRefs: string[];
  /** Build-time context passed to any manifest thunks. */
  ctx: SyncContext;
  /** Directory `modulePacks` refs resolve relative to (the app root). */
  cwd: string;
  /** Resolve a pack ref → absolute directory. Injected for tests; defaults to dir-or-npm resolution. */
  resolvePack?: (ref: string, cwd: string) => string;
  /** Import a pack's manifest module from its directory. Injected for tests; defaults to importing
   * `<dir>/manifest.ts` and reading its `default` or named `pack` export. */
  importPack?: (dir: string) => Promise<PackModule>;
  /** Provenance sink. Defaults to console.log. */
  log?: (msg: string) => void;
}

/** Default pack-ref resolution: an existing directory (relative to the app root) wins; otherwise the
 * ref is treated as an npm package name and resolved via Bun's resolver (same path the plugin loader
 * uses). Throws a clear error when a ref is neither. */
export function defaultResolvePack(ref: string, cwd: string): string {
  const asDir = resolve(cwd, ref);
  if (existsSync(asDir)) return asDir;
  try {
    // Resolve the package's own manifest, then take its directory — the pack root.
    const pkgJson = (Bun as unknown as { resolveSync(id: string, parent: string): string }).resolveSync(
      `${ref}/package.json`,
      cwd
    );
    return pkgJson.slice(0, pkgJson.length - '/package.json'.length);
  } catch {
    throw new Error(
      `module pack "${ref}" not found — no such directory (relative to ${cwd}) and not resolvable as an npm package.`
    );
  }
}

/** Default pack import: load `<dir>/manifest.ts` and read its `default` or named `pack` export. */
export async function defaultImportPack(dir: string): Promise<PackModule> {
  const manifestPath = resolve(dir, 'manifest.ts');
  if (!existsSync(manifestPath)) {
    throw new Error(`module pack at "${dir}" is missing manifest.ts (must export the pack manifest).`);
  }
  const mod = (await import(manifestPath)) as { default?: PackModule; pack?: PackModule };
  const pack = mod.default ?? mod.pack;
  if (!pack || typeof pack.manifestSchemaVersion !== 'number' || !pack.modules) {
    throw new Error(
      `module pack at "${dir}" must export (default or \`pack\`) an object with { manifestSchemaVersion, modules }.`
    );
  }
  return pack;
}

/** Resolve a manifest entry (plain or thunk) against the context to a plain manifest. */
function resolveEntry(entry: ModuleEntry, ctx: SyncContext): ModuleManifest {
  return typeof entry === 'function' ? entry(ctx) : entry;
}

/**
 * Compose the built-in modules with the config's module packs into an ordered, name-keyed map. The
 * insertion order is: built-ins first, then packs in `packRefs` order — and a shadow REPLACES in place
 * (Map preserves the original key position), so a shadowing pack module keeps the built-in's slot. The
 * returned map is what the generator derives the native requirements + handler barrel from.
 */
export async function resolveModulePacks(opts: ResolvePacksOptions): Promise<Map<string, ResolvedModule>> {
  const {
    builtins,
    builtinSchemaVersion,
    packRefs,
    ctx,
    cwd,
    resolvePack = defaultResolvePack,
    importPack = defaultImportPack,
    log = console.log,
  } = opts;

  const map = new Map<string, ResolvedModule>();
  for (const m of builtins) map.set(m.name, { manifest: m, source: BUILTIN_SOURCE, packDir: null });

  for (const ref of packRefs) {
    const dir = resolvePack(ref, cwd);
    const pack = await importPack(dir);
    if (pack.manifestSchemaVersion !== builtinSchemaVersion) {
      throw new Error(
        `module pack "${ref}" targets manifest schema v${pack.manifestSchemaVersion} but this appwrap ` +
          `speaks v${builtinSchemaVersion}. Upgrade the pack or appwrap so the versions match.`
      );
    }
    const entries = typeof pack.modules === 'function' ? pack.modules(ctx) : pack.modules;
    const seenInThisPack = new Set<string>();
    for (const entry of entries) {
      const manifest = resolveEntry(entry, ctx);
      const name = manifest.name;
      const prior = map.get(name);
      // A dup WITHIN this same pack is idempotent (later wins silently) — not a shadow event.
      if (prior && prior.source !== ref && !seenInThisPack.has(name)) {
        log(`  mod ← ${ref}  (${name} shadows ${prior.source})`);
      } else if (!prior) {
        log(`  mod ← ${ref}  (${name})`);
      }
      seenInThisPack.add(name);
      map.set(name, { manifest, source: ref, packDir: dir });
    }
  }

  return map;
}
