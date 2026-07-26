/**
 * `defineHandlers` — author custom native handlers for the appwrap DESKTOP shell, run as a Bun sidecar.
 *
 * The desktop shell spawns `bun <yourFile>` when `desktop.handlers` is set, and routes
 * any method your map advertises to this process over NDJSON on stdin/stdout (appwrap sidecar protocol v1).
 * The PWA calls them through the kit with a raw invoke: `kit.invoke('myapp.foo', { … })`.
 *
 *   // handlers.ts (referenced by desktop.handlers in appwrap.config.ts)
 *   import { defineHandlers } from '@livx.cc/appwrap/handlers';
 *   defineHandlers({
 *     'myapp.echo':   (p) => ({ echoed: p }),
 *     'myapp.addOne': (p) => ({ n: (p.n ?? 0) + 1 }),
 *   });
 *
 * Wire protocol (one JSON object per line):
 *   sidecar → shell (on spawn):  { "kind":"ready", "methods":["myapp.echo", …] }
 *   shell   → sidecar:           { "kind":"request",  "id":"…", "method":"…", "params":{…} }
 *   sidecar → shell (per req):   { "kind":"response", "id":"…", "ok":true,  "data":{…} }
 *                          or:   { "kind":"response", "id":"…", "ok":false, "error":{ "code":"…", "message":"…" } }
 * A handler that throws is caught and returned as ok:false / NATIVE_ERROR — the shell maps that to the
 * kit error envelope, so a bug in one handler never takes the sidecar down.
 */
import type { Readable, Writable } from 'node:stream';

export type HandlerFn = (params: any) => any | Promise<any>;
export type HandlerMap = Record<string, HandlerFn>;

/** Start the sidecar loop against process stdin/stdout. Call once, top-level, in the handlers file. */
export function defineHandlers(map: HandlerMap): void {
  runHandlers(map, process.stdin, process.stdout);
  // If the shell goes away (stdin closes) without killing us, don't linger as an orphan.
  process.stdin.on('end', () => process.exit(0));
}

/** The dispatch loop, decoupled from process streams so it's unit-testable with in-memory streams. */
export function runHandlers(map: HandlerMap, input: Readable, output: Writable): void {
  const write = (obj: unknown): void => { output.write(JSON.stringify(obj) + '\n'); };
  // Announce the surface first — the shell blocks on this line (with a timeout) before going live.
  write({ kind: 'ready', methods: Object.keys(map) });

  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) void handleLine(line);
    }
  });

  async function handleLine(line: string): Promise<void> {
    let req: any;
    try { req = JSON.parse(line); } catch { return; } // ignore malformed lines
    if (!req || req.kind !== 'request') return;
    const id = req.id;
    const fn = map[req.method];
    if (!fn) {
      // The shell only forwards advertised methods, so this is defensive.
      write({ kind: 'response', id, ok: false, error: { code: 'UNSUPPORTED', message: `${req.method} not implemented` } });
      return;
    }
    try {
      const data = await fn(req.params);
      write({ kind: 'response', id, ok: true, data: data ?? null });
    } catch (e) {
      write({ kind: 'response', id, ok: false, error: { code: 'NATIVE_ERROR', message: e instanceof Error ? e.message : String(e) } });
    }
  }
}
