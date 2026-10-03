/**
 * Android web→native transport over window.prompt(). Chromium truncates a prompt() message at ~10K chars
 * (device-measured: a 10.1K envelope arrives, 10.3K arrives cut → unparseable → the call hangs to its timeout),
 * so an envelope longer than CHUNK goes as numbered parts `__appwrapc__:<id>:<i>:<n>:<part>`, reassembled here.
 */
export const PROMPT_PREFIX = '__appwrap__:';
export const CHUNK_PREFIX = '__appwrapc__:';
const CHUNK = 8000;

/** Injected at document start; the guard makes double-injection a no-op. Never splits a surrogate pair. */
export const TRANSPORT_SHIM = `(function(){
  if (window.appwrapNative) return;
  var seq = 0;
  window.appwrapNative = { postMessage: function(json){
    if (json.length <= ${CHUNK}) return window.prompt('${PROMPT_PREFIX}' + json);
    var parts = [], i = 0;
    while (i < json.length) { var e = Math.min(json.length, i + ${CHUNK}); var c = json.charCodeAt(e - 1); if (e < json.length && c >= 0xD800 && c <= 0xDBFF) e--; parts.push(json.slice(i, e)); i = e; }
    var id = (++seq) + Math.random().toString(36).slice(2);
    for (var k = 0; k < parts.length; k++) window.prompt('${CHUNK_PREFIX}' + id + ':' + k + ':' + parts.length + ':' + parts[k]);
  } };
})();`;

const pending = new Map<string, { url: string; parts: string[]; got: number }>();

/** One chunk in; the whole envelope out once its last part lands (all parts must come from the same page url). */
export function takeChunk(message: string, url: string): string | null {
  const m = /^([^:]+):(\d+):(\d+):/.exec(message);
  if (!m) return null;
  const [head, id, i, n] = [m[0], m[1], +m[2], +m[3]];
  let p = pending.get(id);
  if (!p) { if (pending.size > 32) pending.clear(); p = { url, parts: new Array(n), got: 0 }; pending.set(id, p); }
  if (p.url !== url || i >= p.parts.length || p.parts[i] !== undefined) { pending.delete(id); return null; }
  p.parts[i] = message.slice(head.length);
  if (++p.got < p.parts.length) return null;
  pending.delete(id);
  return p.parts.join('');
}
