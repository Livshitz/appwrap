# Contributing to appwrap

Thanks for your interest in improving appwrap! Contributions are welcome.

## Setup

This is a [Bun](https://bun.sh) monorepo.

```bash
git clone https://github.com/Livshitz/appwrap.git
cd appwrap
bun install
bun test            # run the test suite
bun run build:kit   # build @livx.cc/native-kit
```

The example app lives in `examples/hello-pwa`. Its generated `native/` directory is **not** committed — regenerate it locally with `bunx appwrap init` / `appwrap sync` (you'll need your own Apple Team ID in `appwrap.config.ts` to build for a device).

## Layout

- `packages/native-kit` — the isomorphic capability kit (published to npm).
- `packages/appwrap-cli` — the `appwrap` CLI.
- `runtime/` — the managed native shell template the CLI stamps into `native/`.
- `templates/` — CI/fastlane scaffolds.
- `examples/` — example PWAs.

## Pull requests

- Keep changes focused; one logical change per PR.
- Run `bun test` before opening a PR.
- Match the surrounding code style.
- When you change the runtime shell template, edit `runtime/` — never the generated `native/`.

## Reporting issues

Use [GitHub Issues](https://github.com/Livshitz/appwrap/issues). For security reports, see [SECURITY.md](./SECURITY.md).
