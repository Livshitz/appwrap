// Walking-skeleton DEMO of a MOBILE appwrap plugin. Authored with the SAME shared `definePlugin`
// surface as a desktop plugin (`@livx.cc/appwrap/plugin`) — but on mobile only `handlers` are consumed:
// the CLI bun-builds this file into the NS shell and `registerPlugins()` registers each handler on the
// bridge at boot, so the PWA reaches it via `kit.invoke('greeter.hello', { name })`.
//
// `attachTo`/`onWindow` (the desktop WindowCtx path) have no mobile analog yet; declaring them is
// harmless (ignored on mobile), which is what lets one plugin target both lanes.
import { definePlugin } from '@livx.cc/appwrap/plugin';

export default definePlugin({
  name: 'greeter',
  handlers: {
    // Bare method key — the host namespaces it under `name` → reachable as `kit.invoke('greeter.hello')`.
    // kit.invoke('greeter.hello', { name: 'Ada' }) → { greeting: 'Hello, Ada! (from mobile plugin)', ... }
    hello: (p: { name?: string } = {}) => ({
      greeting: `Hello, ${p?.name ?? 'world'}! (from mobile plugin)`,
      plugin: 'greeter',
      ts: Date.now(),
    }),
  },
});
