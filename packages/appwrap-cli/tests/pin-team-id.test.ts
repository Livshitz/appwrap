import { describe, expect, test } from 'bun:test';
import { pinTeamIdInConfigSource } from '../src/cli';

const TEAM = 'ABCDE12345';

describe('pinTeamIdInConfigSource — appwrap.config.ts', () => {
  test('replaces the YOUR_APPLE_TEAM_ID placeholder, preserving single quotes', () => {
    const src = `export default defineConfig({\n  id: 'cc.livx.app',\n  teamId: 'YOUR_APPLE_TEAM_ID',\n});\n`;
    const out = pinTeamIdInConfigSource(src, TEAM, false)!;
    expect(out).toContain(`teamId: '${TEAM}'`);
    expect(out).not.toContain('YOUR_APPLE_TEAM_ID');
  });

  test('replaces an existing real value, preserving double quotes', () => {
    const src = `export default {\n  id: "x",\n  teamId: "OLD0000000",\n};\n`;
    const out = pinTeamIdInConfigSource(src, TEAM, false)!;
    expect(out).toContain(`teamId: "${TEAM}"`);
    expect(out).not.toContain('OLD0000000');
  });

  test('inserts teamId after id: when absent, matching indentation + quote style', () => {
    const src = `export default defineConfig({\n  id: 'cc.livx.app',\n  name: 'App',\n});\n`;
    const out = pinTeamIdInConfigSource(src, TEAM, false)!;
    expect(out).toContain(`  id: 'cc.livx.app',\n  teamId: '${TEAM}',`);
    // single insertion only
    expect(out.match(/teamId:/g)!.length).toBe(1);
  });

  test('returns null on an unfamiliar shape (no id: field, no teamId:)', () => {
    expect(pinTeamIdInConfigSource(`export const x = 1;\n`, TEAM, false)).toBeNull();
  });
});

describe('pinTeamIdInConfigSource — appwrap.json', () => {
  test('replaces an existing teamId property', () => {
    const src = JSON.stringify({ id: 'x', teamId: 'OLD', name: 'A' }, null, 2);
    const out = pinTeamIdInConfigSource(src, TEAM, true)!;
    expect(JSON.parse(out).teamId).toBe(TEAM);
    expect(JSON.parse(out).name).toBe('A'); // siblings preserved
  });

  test('inserts teamId when absent', () => {
    const src = JSON.stringify({ id: 'x', name: 'A' }, null, 2);
    const out = pinTeamIdInConfigSource(src, TEAM, true)!;
    expect(JSON.parse(out).teamId).toBe(TEAM);
  });

  test('returns null on invalid JSON', () => {
    expect(pinTeamIdInConfigSource('{ not json', TEAM, true)).toBeNull();
  });
});
