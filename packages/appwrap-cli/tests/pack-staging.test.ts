import { describe, expect, test } from 'bun:test';
import { rewritePackShellImports } from '../src/cli';

describe('rewritePackShellImports (pack staging)', () => {
  test('rewrites the sanctioned shell-API specifier to relative', () => {
    const src = `import { bridge } from '@livx.cc/appwrap/runtime/app/shell/bridge';`;
    expect(rewritePackShellImports(src)).toBe(`import { bridge } from './bridge';`);
  });

  test('handles double quotes + multiple imports', () => {
    const src =
      `import { bridge } from "@livx.cc/appwrap/runtime/app/shell/bridge";\n` +
      `import { SHELL_CONFIG } from '@livx.cc/appwrap/runtime/app/shell/config';`;
    const out = rewritePackShellImports(src);
    expect(out).toContain(`from "./bridge"`);
    expect(out).toContain(`from './config'`);
  });

  test('leaves unrelated imports untouched', () => {
    const src = `import { Application } from '@nativescript/core';\nimport x from './local';`;
    expect(rewritePackShellImports(src)).toBe(src);
  });

  test('does NOT rewrite a lookalike specifier outside the shell path', () => {
    const src = `import y from '@livx.cc/appwrap/runtime/app/other/z';`;
    expect(rewritePackShellImports(src)).toBe(src);
  });
});

import { replaceImportSpecifier } from '../src/cli';

describe('replaceImportSpecifier (pack-local import rewrite)', () => {
  test('rewrites an exact quoted specifier (both quote styles)', () => {
    expect(replaceImportSpecifier(`import x from './billing-offer';`, './billing-offer', './pack-ee-billing-offer'))
      .toBe(`import x from './pack-ee-billing-offer';`);
    expect(replaceImportSpecifier(`import x from "./billing-offer";`, './billing-offer', './y'))
      .toBe(`import x from "./y";`);
  });
  test('is anchored — ./x does NOT partial-match ./x-y', () => {
    const src = `import a from './offer';\nimport b from './offer-extra';`;
    const out = replaceImportSpecifier(src, './offer', './staged-offer');
    expect(out).toContain(`from './staged-offer'`);
    expect(out).toContain(`from './offer-extra'`);
  });
});

import { claimStagedName } from '../src/cli';

/**
 * The collision that broke a real TestFlight build.
 *
 * The handler entry is staged as `pack-<label>-<moduleName>.ts`; helpers as
 * `pack-<label>-<basename>.ts`. Blank's `widget` module imported `./kit/widget` — basename `widget`,
 * identical to the module name — so both wanted the same staged file. The helper was written, the
 * handler overwrote it, and the handler's rewritten import resolved to itself: `TS2303: Circular
 * definition of import alias`, raised against a generated file present in no repository, with nothing
 * in the message naming the pack or the clash.
 */
describe('claimStagedName (staged filename collisions)', () => {
  test('an uncontested name is used as-is', () => {
    const claimed = new Map<string, string>();
    expect(claimStagedName('ee', 'billing-offer', '/p/billing-offer.ts', '/p', claimed))
      .toBe('pack-ee-billing-offer.ts');
  });

  test('the same file asking twice keeps its name (idempotent, not renamed)', () => {
    const claimed = new Map<string, string>();
    const a = claimStagedName('ee', 'x', '/p/x.ts', '/p', claimed);
    expect(claimStagedName('ee', 'x', '/p/x.ts', '/p', claimed)).toBe(a);
  });

  test('THE BUG: a helper cannot take the handler entry name', () => {
    const claimed = new Map<string, string>();
    // handler is staged first, under the MODULE name
    const handler = claimStagedName('w', 'widget', '/p/handler.ts', '/p', claimed);
    expect(handler).toBe('pack-w-widget.ts');
    // ./kit/widget.ts wants the same name — it must NOT get it
    const helper = claimStagedName('w', 'widget', '/p/kit/widget.ts', '/p', claimed);
    expect(helper).not.toBe(handler);
    // and it is named from the pack-relative path, so it is stable rather than order-dependent
    expect(helper).toBe('pack-w-kit_widget.ts');
  });

  test('a third file colliding again still gets a distinct name', () => {
    const claimed = new Map<string, string>();
    claimStagedName('w', 'widget', '/p/handler.ts', '/p', claimed);
    const a = claimStagedName('w', 'widget', '/p/kit/widget.ts', '/p', claimed);
    const b = claimStagedName('w', 'widget', '/p/other/widget.ts', '/p', claimed);
    expect(new Set([a, b]).size).toBe(2);
  });

  test('every claimed name maps back to exactly one source file', () => {
    const claimed = new Map<string, string>();
    const files = ['/p/handler.ts', '/p/kit/widget.ts', '/p/a/widget.ts', '/p/b/widget.ts'];
    const names = files.map((f) => claimStagedName('w', 'widget', f, '/p', claimed));
    expect(new Set(names).size).toBe(files.length); // no two sources share a staged file
  });
});
