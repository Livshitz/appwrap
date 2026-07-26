// Pack handler authored out-of-tree: imports the shell bridge via the sanctioned package specifier
// (resolvable standalone because the npm package ships runtime/). Staging rewrites it to './bridge'.
import { bridge } from '@livx.cc/appwrap/runtime/app/shell/bridge';

export function registerDemoPingHandlers(): void {
  bridge.register('demo.ping', () => ({ pong: true }));
}
