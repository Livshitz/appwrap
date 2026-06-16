# @livx.cc/appwrap

CLI that wraps any PWA into a native iOS/Android app with real native capabilities — pairs with [`@livx.cc/native-kit`](https://www.npmjs.com/package/@livx.cc/native-kit) and the appwrap runtime.

> Requires [Bun](https://bun.sh). The CLI runs as TypeScript via `#!/usr/bin/env bun`.

```bash
bun add -d @livx.cc/appwrap
bunx appwrap init     # scaffold native/ from appwrap.json
bunx appwrap sync     # regenerate native/ after web or config changes
bunx appwrap dev      # live-load your dev server in the native shell
```

Configuration lives in `appwrap.json` (app id, name, icon, modules, permissions, signing). The CLI generates and keeps `native/` in sync from a managed runtime template — you edit the template/config, never the generated output.

**Full documentation, `appwrap.json` reference, and the managed-regeneration model:** see the [appwrap README](https://github.com/Livshitz/appwrap#readme).

## License

MIT © Elya Livshitz
