# @livx.cc/appwrap

CLI that wraps any PWA into a native iOS/Android app with real native capabilities — pairs with [`@livx.cc/native-kit`](https://www.npmjs.com/package/@livx.cc/native-kit) and the appwrap runtime.

> Requires [Bun](https://bun.sh). The CLI runs as TypeScript via `#!/usr/bin/env bun`.

```bash
bun add -d @livx.cc/appwrap
bunx @livx.cc/appwrap init     # scaffold native/ from your config
bunx @livx.cc/appwrap sync     # regenerate native/ after web or config changes
bunx @livx.cc/appwrap dev      # live-load your dev server in the native shell
```

Configuration lives in a typed `appwrap.config.ts` (app id, name, icon, modules, permissions, signing) — author it with autocomplete + type-checking via `defineConfig`:

```ts
import { defineConfig } from '@livx.cc/appwrap/config';
export default defineConfig({ id: 'com.you.app', name: 'My App', version: '1.0.0', pwaDist: 'dist' });
```

A plain `appwrap.json` is still supported as a fallback (the CLI resolves `appwrap.config.ts` → `appwrap.config.js` → `appwrap.json`). The CLI generates and keeps `native/` in sync from a managed runtime template — you edit the template/config, never the generated output.

**Full documentation, config reference, and the managed-regeneration model:** see the [appwrap README](https://github.com/Livshitz/appwrap#readme).

## License

MIT © Elya Livshitz
