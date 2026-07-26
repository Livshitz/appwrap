/**
 * Pack conformance validator — the public `@livx.cc/appwrap/testing` entry.
 *
 * A module pack (see packs.ts) is authored out-of-tree and staged into the shell at sync. Because a
 * malformed pack fails LATE (mid-generate, on a device build), this gives pack authors a FAST, offline
 * conformance check they can run in their own `bun test` — the same contract the CLI enforces, minus
 * any NativeScript/CLI side effects, so it's import-safe as a library entry.
 *
 * It checks a pack DIRECTORY:
 *   - manifest.ts exists and (default or named `pack`) exports { manifestSchemaVersion, modules }
 *     (REUSES `defaultImportPack` from packs.ts — same loader the CLI uses);
 *   - manifestSchemaVersion === MANIFEST_SCHEMA_VERSION (the version this appwrap speaks);
 *   - every resolved module has a non-empty `name`, `group`, and a `capabilities` object;
 *   - each module `handler.file` resolves to an existing file under the pack dir + `handler.fn` is set;
 *   - each handler file imports ONLY sanctioned specifiers (no `../` escaping the pack, no bare deep
 *     import into appwrap internals other than `@livx.cc/appwrap/runtime/app/shell/*`).
 *
 * ALL problems are collected (not fail-fast) so `errors[]` is a full report.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { defaultImportPack, type ModuleEntry, type SyncContext } from './packs';
import { MANIFEST_SCHEMA_VERSION } from '../../../runtime/app/shell/capabilities.manifest';

export interface ValidatePackResult {
  ok: boolean;
  errors: string[];
}

/** Node.js core module names (bare + `node:` forms). Allowed in a handler (they're externalized). */
const NODE_BUILTIN_SET = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** The sanctioned shell-API specifier prefix a pack handler may deep-import (rewritten to relative on
 * staging). Any OTHER `@livx.cc/appwrap/...` deep import reaches into internals → rejected. */
const SANCTIONED_SHELL_PREFIX = '@livx.cc/appwrap/runtime/app/shell/';

/** Map a handler file extension to the Bun.Transpiler loader for its dialect (mirrors cli.ts). */
function loaderFor(file: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  const ext = extname(file).toLowerCase();
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  return 'ts';
}

/** True if a bare specifier is an allowed non-relative import (shell API, @nativescript/core, node
 * builtin). Anything else bare is treated as a normal npm dep the pack declares — NOT our concern here,
 * so we only FLAG the one illegitimate class: a deep import into appwrap internals off the sanctioned
 * path. */
function bareImportError(spec: string): string | null {
  // Sanctioned shell API — always fine.
  if (spec === SANCTIONED_SHELL_PREFIX.slice(0, -1) || spec.startsWith(SANCTIONED_SHELL_PREFIX)) return null;
  // Any OTHER appwrap deep import escapes the sanctioned seam into internals.
  if (spec === '@livx.cc/appwrap' || spec.startsWith('@livx.cc/appwrap/')) {
    return `imports appwrap internals via "${spec}" — a pack may only deep-import the sanctioned ` +
      `"${SANCTIONED_SHELL_PREFIX}*" shell APIs.`;
  }
  // @nativescript/core (+ subpaths), node builtins, and any other npm dep are all acceptable.
  return null;
}

/** Scan a handler file's imports; return an error string per illegal specifier (empty when clean).
 * Uses Bun.Transpiler.scanImports (real import/require STATEMENTS only — never a string-literal match),
 * the same primitive the CLI uses. */
function scanHandlerImports(packDir: string, handlerFile: string): string[] {
  const errors: string[] = [];
  const src = readFileSync(handlerFile, 'utf8');
  const rel = relative(packDir, handlerFile);
  for (const { path: spec } of new Bun.Transpiler({ loader: loaderFor(handlerFile) }).scanImports(src)) {
    if (spec.startsWith('.')) {
      // Relative import — must resolve to somewhere INSIDE the pack dir.
      const target = resolve(handlerFile, '..', spec);
      const back = relative(packDir, target);
      if (back.startsWith('..') || resolve(packDir, back) !== target) {
        errors.push(`handler ${rel} imports "${spec}" which escapes the pack directory (${target}).`);
      }
      continue;
    }
    if (NODE_BUILTIN_SET.has(spec) || NODE_BUILTIN_SET.has(spec.replace(/^node:/, '').split('/')[0])) continue;
    const bareErr = bareImportError(spec);
    if (bareErr) errors.push(`handler ${rel} ${bareErr}`);
  }
  return errors;
}

/** A representative sync context for resolving context-dependent manifest thunks during validation. */
const REPRESENTATIVE_CTX: SyncContext = { platform: 'both', env: 'default', ci: false };

/**
 * Validate that `dir` is a conformant module pack. Collects ALL errors; `ok` is `errors.length === 0`.
 * Import-safe: no NativeScript globals, no CLI dispatch.
 */
export async function validatePack(dir: string): Promise<ValidatePackResult> {
  const errors: string[] = [];
  const packDir = resolve(dir);

  // 1. Load the manifest via the SAME loader the CLI uses (throws a clear message if absent/malformed).
  let pack: Awaited<ReturnType<typeof defaultImportPack>>;
  try {
    pack = await defaultImportPack(packDir);
  } catch (e) {
    errors.push((e as Error).message);
    return { ok: false, errors };
  }

  // 2. Schema-version match.
  if (pack.manifestSchemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(
      `manifestSchemaVersion ${pack.manifestSchemaVersion} does not match this appwrap's ` +
        `MANIFEST_SCHEMA_VERSION ${MANIFEST_SCHEMA_VERSION}.`
    );
  }

  // 3. Resolve modules (may be a fn of the context) → plain manifests.
  let entries: ModuleEntry[];
  try {
    entries = typeof pack.modules === 'function' ? pack.modules(REPRESENTATIVE_CTX) : pack.modules;
  } catch (e) {
    errors.push(`resolving \`modules\` threw: ${(e as Error).message}`);
    return { ok: false, errors };
  }
  if (!Array.isArray(entries)) {
    errors.push('`modules` must resolve to an array of module entries.');
    return { ok: false, errors };
  }

  for (const [i, entry] of entries.entries()) {
    let m;
    try {
      m = typeof entry === 'function' ? entry(REPRESENTATIVE_CTX) : entry;
    } catch (e) {
      errors.push(`module[${i}] entry thunk threw: ${(e as Error).message}`);
      continue;
    }
    const label = m && m.name ? `module "${m.name}"` : `module[${i}]`;
    if (!m || typeof m !== 'object') {
      errors.push(`module[${i}] is not an object.`);
      continue;
    }
    if (!m.name || typeof m.name !== 'string') errors.push(`${label} is missing a non-empty \`name\`.`);
    if (!m.group || typeof m.group !== 'string') errors.push(`${label} is missing a non-empty \`group\`.`);
    if (!m.capabilities || typeof m.capabilities !== 'object') {
      errors.push(`${label} is missing a \`capabilities\` object.`);
    }

    // 4. Handler wiring (optional field, but if present must be complete + resolvable).
    if (m.handler) {
      if (!m.handler.fn || typeof m.handler.fn !== 'string') {
        errors.push(`${label} handler is missing a non-empty \`fn\`.`);
      }
      if (!m.handler.file || typeof m.handler.file !== 'string') {
        errors.push(`${label} handler is missing a \`file\`.`);
      } else {
        const handlerFile = resolve(packDir, m.handler.file);
        if (!existsSync(handlerFile)) {
          errors.push(`${label} handler.file "${m.handler.file}" does not exist (looked at ${handlerFile}).`);
        } else {
          // 5. Import legality scan.
          errors.push(...scanHandlerImports(packDir, handlerFile));
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Convenience: throw with the joined errors if the pack is not conformant. */
export async function assertValidPack(dir: string): Promise<void> {
  const { ok, errors } = await validatePack(dir);
  if (!ok) throw new Error(`invalid module pack at "${dir}":\n  - ${errors.join('\n  - ')}`);
}
