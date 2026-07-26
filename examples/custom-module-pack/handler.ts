// Handler for the `confetti` example pack. Imports the shell bridge via the sanctioned specifier
// (rewritten to relative on staging). Registers one demo method the web side can invoke over the bridge.
import { bridge } from '@livx.cc/appwrap/runtime/app/shell/bridge';

export function registerConfettiHandlers(): void {
  bridge.register('confetti.fire', (params: { count?: number } = {}) => {
    // A real handler would trigger a native burst here; the demo just echoes the request.
    return { fired: true, count: params.count ?? 100 };
  });
}
