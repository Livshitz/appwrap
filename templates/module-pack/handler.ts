// Handler for the `__MODULE_NAME__` module. Imports the shell bridge via the sanctioned package
// specifier (resolvable standalone — the npm package ships runtime/); the generator rewrites it to a
// relative `./bridge` when staging this file beside the shell sources.
import { bridge } from '@livx.cc/appwrap/runtime/app/shell/bridge';

export function register__MODULE_PASCAL__Handlers(): void {
  // One demo bridge method — call it from the web side via the kit's raw bridge.
  bridge.register('__MODULE_NAME__.ping', () => ({ pong: true }));
}
