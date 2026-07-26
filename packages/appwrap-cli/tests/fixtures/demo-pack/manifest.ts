// A minimal out-of-tree module pack fixture for the pack-staging gate. Contributes one capability
// (`demoPing`) with a register handler and a trivial native-source asset. Authored the way a real
// pack is — the handler imports shell APIs via the `@livx.cc/appwrap/runtime/...` specifier, which
// the generator rewrites to relative on staging.
import type { PackModule } from '../../../src/packs';

const pack: PackModule = {
  manifestSchemaVersion: 1,
  modules: [
    {
      name: 'demoPing',
      group: 'demoPing',
      capabilities: { demoPing: { ios: true, android: true } },
      handler: { file: './handler.ts', fn: 'registerDemoPingHandlers' },
      nativeSrc: 'demoPing',
    },
  ],
};
export default pack;
