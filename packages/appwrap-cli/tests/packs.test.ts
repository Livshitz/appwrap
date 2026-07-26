import { describe, expect, test } from 'bun:test';
import {
  resolveModulePacks,
  BUILTIN_SOURCE,
  type PackModule,
  type SyncContext,
  type ResolvePacksOptions,
} from '../src/packs';
import type { ModuleManifest } from '../../../runtime/app/shell/capabilities.manifest';

const ctx: SyncContext = { platform: 'both', env: 'default', ci: false };

const mod = (name: string, extra: Partial<ModuleManifest> = {}): ModuleManifest => ({
  name,
  group: name,
  capabilities: { [name]: 'native' },
  ...extra,
});

const BUILTINS = [mod('haptics', { core: true }), mod('billing'), mod('health')];

/** Build resolve options with in-memory ports — each pack ref maps to a fake PackModule. */
function opts(
  packs: Record<string, PackModule>,
  packRefs = Object.keys(packs),
  log: (m: string) => void = () => {}
): ResolvePacksOptions {
  return {
    builtins: BUILTINS,
    builtinSchemaVersion: 1,
    packRefs,
    ctx,
    cwd: '/app',
    resolvePack: (ref) => `/packs/${ref}`,
    importPack: async (dir) => packs[dir.replace('/packs/', '')],
    log,
  };
}

describe('resolveModulePacks', () => {
  test('zero packs → built-ins verbatim, in order', async () => {
    const map = await resolveModulePacks(opts({}, []));
    expect([...map.keys()]).toEqual(['haptics', 'billing', 'health']);
    expect(map.get('billing')).toMatchObject({ source: BUILTIN_SOURCE, packDir: null });
  });

  test('a new module is appended after the built-ins', async () => {
    const map = await resolveModulePacks(
      opts({ ee: { manifestSchemaVersion: 1, modules: [mod('widget')] } })
    );
    expect([...map.keys()]).toEqual(['haptics', 'billing', 'health', 'widget']);
    expect(map.get('widget')).toMatchObject({ source: 'ee', packDir: '/packs/ee' });
  });

  test('last-wins: a pack shadows a built-in wholesale, keeping its slot', async () => {
    const shadow = mod('billing', { group: 'billing', android: { gradleDeps: ['acme:billing:9'] } });
    const map = await resolveModulePacks(
      opts({ ee: { manifestSchemaVersion: 1, modules: [shadow] } })
    );
    // slot position preserved (billing stays 2nd, not moved to the end)
    expect([...map.keys()]).toEqual(['haptics', 'billing', 'health']);
    const b = map.get('billing')!;
    expect(b.source).toBe('ee');
    expect(b.manifest.android?.gradleDeps).toEqual(['acme:billing:9']);
  });

  test('later pack wins over an earlier pack (order matters)', async () => {
    const map = await resolveModulePacks(
      opts(
        {
          a: { manifestSchemaVersion: 1, modules: [mod('billing', { group: 'a' })] },
          b: { manifestSchemaVersion: 1, modules: [mod('billing', { group: 'b' })] },
        },
        ['a', 'b']
      )
    );
    expect(map.get('billing')!.source).toBe('b');
    expect(map.get('billing')!.manifest.group).toBe('b');
  });

  test('duplicate name within one pack is idempotent (later wins, no shadow log)', async () => {
    const logs: string[] = [];
    const map = await resolveModulePacks(
      opts(
        { ee: { manifestSchemaVersion: 1, modules: [mod('x', { group: 'first' }), mod('x', { group: 'second' })] } },
        ['ee'],
        (m) => logs.push(m)
      )
    );
    expect(map.get('x')!.manifest.group).toBe('second');
    // exactly one "new module" log line, no "shadows" line for the intra-pack dup
    expect(logs.filter((l) => l.includes('shadows'))).toHaveLength(0);
    expect(logs.filter((l) => l.includes('x'))).toHaveLength(1);
  });

  test('shadowing a built-in emits a provenance line', async () => {
    const logs: string[] = [];
    await resolveModulePacks(
      opts({ ee: { manifestSchemaVersion: 1, modules: [mod('billing')] } }, ['ee'], (m) => logs.push(m))
    );
    expect(logs.some((l) => l.includes('billing shadows (built-in)'))).toBe(true);
  });

  test('schema-version mismatch throws (loud, not silently mis-derived)', async () => {
    await expect(
      resolveModulePacks(opts({ ee: { manifestSchemaVersion: 2, modules: [mod('widget')] } }))
    ).rejects.toThrow(/schema v2 but this appwrap speaks v1/);
  });

  test('a context thunk resolves against the SyncContext', async () => {
    const iosCtx: SyncContext = { platform: 'ios', env: 'prod', ci: true };
    const map = await resolveModulePacks({
      ...opts({
        ee: {
          manifestSchemaVersion: 1,
          modules: [(c: SyncContext) => mod('widget', { group: c.platform === 'ios' ? 'ios-grp' : 'other' })],
        },
      }),
      ctx: iosCtx,
    });
    expect(map.get('widget')!.manifest.group).toBe('ios-grp');
  });

  test('modules-as-function receives the context', async () => {
    const map = await resolveModulePacks(
      opts({ ee: { manifestSchemaVersion: 1, modules: (c) => [mod(`m-${c.env}`)] } })
    );
    expect(map.has('m-default')).toBe(true);
  });
});
