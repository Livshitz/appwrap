import { describe, expect, test } from 'bun:test';
import { runCli } from '../src/cli';

describe('runCli composition seam', () => {
  test('a host-provided command is dispatched before the built-in switch', async () => {
    const argv = process.argv;
    process.argv = ['bun', 'cli.ts', 'greet', 'world', '--x'];
    let ran: { pos: string[]; flags: Record<string, string> } | null = null;
    try {
      await runCli({ commands: { greet: (_cwd, flags, pos) => { ran = { pos, flags }; } } });
    } finally {
      process.argv = argv;
    }
    expect(ran).not.toBeNull();
    expect(ran!.pos).toEqual(['world']);
    expect('x' in ran!.flags).toBe(true);
  });

  test('a host command can OVERRIDE a built-in command name', async () => {
    const argv = process.argv;
    process.argv = ['bun', 'cli.ts', 'sync'];
    let overrode = false;
    try {
      await runCli({ commands: { sync: () => { overrode = true; } } });
    } finally {
      process.argv = argv;
    }
    expect(overrode).toBe(true); // the built-in sync (which would error without a wrapper) never ran
  });
});
