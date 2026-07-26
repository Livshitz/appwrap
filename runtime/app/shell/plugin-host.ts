/**
 * Mobile plugin host — the in-process analog of an out-of-process desktop plugin host.
 *
 * On desktop a plugin's `WindowCtx` ops marshal to the native shell over IPC; that host does
 * NOT apply on mobile — there is one WKWebView/WebView and the NS runtime IS the trusted host. So the
 * mobile "host" is trivial: at boot it takes each configured plugin's def and registers its `handlers`
 * directly onto the same {@link bridge} the built-in `handlers*.ts` groups use. A PWA then reaches a
 * plugin handler exactly like any native method — `kit.invoke('<plugin>.<method>')`.
 *
 * This walking skeleton consumes ONLY `handlers` (the desktop types call a handlers-only plugin the
 * base case). `attachTo`/`onWindow`/`WindowCtx` are desktop-only concepts (multi-window, out-of-webview
 * control) with no mobile analog yet — a plugin that also declares them still works here; those fields
 * are ignored. Deeper hooks (devmenu action, boot/deeplink) are a documented follow-up.
 */
import { bridge } from './bridge';

/**
 * The structural subset of the shared `PluginDef` (`@livx.cc/appwrap/plugin`) that the mobile host
 * consumes. Kept as a local type so the NS runtime never imports the desktop socket/WindowCtx types.
 * A plugin authored with `definePlugin({ name, handlers })` satisfies this by construction.
 *
 * Handler keys are BARE method names (`hello`, not `greeter.hello`); the host registers each on the
 * bridge NAMESPACED under `plugin.name` → the PWA reaches it as `kit.invoke('<name>.<method>')`.
 */
export interface MobilePluginDef {
  name: string;
  handlers?: Record<string, (params: any) => unknown | Promise<unknown>>;
}

/** Register one plugin's bridge handlers, each NAMESPACED under `plugin.name` as `<name>.<method>`.
 * This (a) matches the spec's `kit.invoke('<plugin>.<method>')` call shape and (b) confines a plugin
 * to its own namespace so it cannot shadow a core handler (e.g. `app.reload`). As a belt-and-braces
 * guard for the residual case where `name` itself collides with a core prefix, a namespaced key that
 * is ALREADY registered (core handlers register first, at boot) is refused with a warning rather than
 * clobbering the incumbent. */
export function registerPluginHandlers(plugin: MobilePluginDef): void {
  const name = plugin?.name;
  const handlers = plugin?.handlers ?? {};
  if (!name) {
    console.warn('⚠ mobile plugin has no `name` — cannot namespace its handlers; skipping.');
    return;
  }
  for (const method of Object.keys(handlers)) {
    const key = `${name}.${method}`;
    if (bridge.has(key)) {
      console.warn(`⚠ mobile plugin "${name}" handler "${key}" collides with an already-registered method — refusing to override; skipping.`);
      continue;
    }
    bridge.register(key, handlers[method]);
  }
}
