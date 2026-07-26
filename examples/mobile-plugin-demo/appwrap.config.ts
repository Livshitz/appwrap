import { defineConfig } from '@livx.cc/appwrap/config';

// Minimal app proving the MOBILE plugin walking skeleton: one config-gated TS plugin that contributes
// a bridge handler to the NativeScript shell. `appwrap init/sync` bun-builds `greeter-plugin.ts` into
// native/app/shell/plugins/ and generates the `plugins.generated.ts` barrel that registers it.
export default defineConfig({
  id: 'cc.livx.mobilepluginc',
  name: 'Mobile Plugin Demo',
  version: '0.1.0',
  entry: 'index.html',
  backgroundColor: '#0b1020',
  statusBarStyle: 'light',
  pwaDist: 'dist',
  plugins: ['./greeter-plugin.ts'],
});
