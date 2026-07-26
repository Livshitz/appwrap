/**
 * `stampShellConfig` surfaces the app's own `urlScheme` into the generated `app/shell/config.ts`, so
 * the runtime `detectEnv()` can expose it to the page as `window.__APPWRAP__.scheme`. Follows the
 * derive-stamper convention: stamp into a temp dir, assert against the generated fixture string.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stampShellConfig } from '../src/cli';

function stamp(cfg: any): string {
  const out = mkdtempSync(join(tmpdir(), 'appwrap-shellcfg-'));
  try {
    mkdirSync(join(out, 'app/shell'), { recursive: true });
    stampShellConfig(out, cfg);
    return readFileSync(join(out, 'app/shell/config.ts'), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const BASE = { id: 'cc.livx.demo', name: 'Demo', version: '1.0.0' };

describe('stampShellConfig — urlScheme', () => {
  test('stamps the configured urlScheme into config.ts', () => {
    expect(stamp({ ...BASE, urlScheme: 'demoapp' })).toContain('urlScheme: "demoapp",');
  });

  test('defaults to an empty string when no urlScheme is configured', () => {
    expect(stamp(BASE)).toContain('urlScheme: "",');
  });
});
