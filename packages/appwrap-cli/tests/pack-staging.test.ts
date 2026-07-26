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
