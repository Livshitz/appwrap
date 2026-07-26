/**
 * The debug-only red DEV dot (web-quirks.ts APPWRAP_GLOBALS_JS) must be SUPPRESSED when an app enables
 * the env-switcher — its bottom env-banner (shown only on a non-default env) is the better,
 * less-intrusive "which env am I on" indicator and supersedes the dot. Apps without envSwitcher keep it.
 * Structural: the mount is gated on a flag stamped from SHELL_CONFIG.envSwitcher?.enabled.
 * Also pins the dot's non-invasive contract (safe-area, no tap-steal, no layout shift).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, '../../../runtime/app/shell/web-quirks.ts'), 'utf8');

describe('DEV dot is suppressed under the env-switcher', () => {
  test('the dot mount is gated by a flag derived from envSwitcher?.enabled', () => {
    // flag is stamped from the config...
    expect(SRC).toContain("SHELL_CONFIG.envSwitcher?.enabled ? 'false' : 'true'");
    // ...and actually gates the mount (not just declared)
    expect(SRC).toMatch(/if\s*\(\s*__appwrapDevDot\s*\)\s*{[\s\S]*mountDevDot\(\)/);
  });

  test('the dot is non-invasive: below the top safe area, no tap-steal, no layout shift', () => {
    expect(SRC).toContain('top:calc(env(safe-area-inset-top,0px) + 6px)');
    expect(SRC).toContain('pointer-events:none');
    expect(SRC).toContain('position:fixed');
  });

  test('the old full-width DEV strip is gone', () => {
    expect(SRC).not.toContain('__appwrap_dev_strip__');
    expect(SRC).not.toContain("'DEV · '");
  });
});
