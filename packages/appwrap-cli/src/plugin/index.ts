/**
 * `definePlugin` — author an appwrap TS plugin (`@livx.cc/appwrap/plugin`).
 *
 *   // my-plugin.ts (referenced by `plugins` in appwrap.config.ts)
 *   import { definePlugin } from '@livx.cc/appwrap/plugin';
 *   export default definePlugin({
 *     name: 'my-plugin',
 *     attachTo: 'main',
 *     onWindow(win) {
 *       win.onMessage((m) => console.log('page said', m));
 *       win.injectScript(`webkit.messageHandlers.bridgeShim.postMessage('hi')`);
 *     },
 *     handlers: { 'my-plugin.echo': (p) => ({ echoed: p }) }, // back-compat: == defineHandlers
 *   });
 *
 * Types-first: `definePlugin` is an identity helper that validates + returns the def, which the plugin
 * entrypoint `export default`s. The multiplexed host `import()`s the built bundle and reads
 * `.default`. Nothing runs at import time (unlike `defineHandlers`, which starts a loop) — the host
 * drives the lifecycle.
 */
import type { PluginDef } from './types';

export function definePlugin(def: PluginDef): PluginDef {
  if (!def || typeof def.name !== 'string' || !def.name) {
    throw new Error('definePlugin: `name` is required');
  }
  return def;
}

export type {
  PluginDef,
  WindowCtx,
  WindowScope,
  WindowIdentity,
  Dispose,
  Envelope,
  StampedPlugin,
} from './types';
export { WINDOW_CTX_VERSION } from './types';
