# Working on appwrap with a coding agent

Guidance for AI coding agents (Claude Code, Cursor, …) working in this repo or wrapping a PWA with appwrap. Human-readable too.

## What this is

Take any PWA and ship it as a real native app — the same web app, hosted in a NativeScript WKWebView/WebView shell, with native capabilities exposed through one isomorphic SDK. Three artifacts:

- **`@livx.cc/native-kit`** (`packages/native-kit`) — isomorphic JS SDK the PWA imports. The same `kit.*` API runs in a plain browser and inside the shell; every domain reports a `capability` flag (`'native' | 'web' | 'none'`) so you branch and degrade gracefully. Zero deps.
- **`@livx.cc/appwrap`** (`packages/appwrap-cli`) — the CLI. `appwrap init` scaffolds a native wrapper from a single config file (`appwrap.config.ts`, or `appwrap.json`). The runtime shell template is bundled into the published package, so `bunx appwrap` works without cloning this repo.
- **`runtime/`** — the NativeScript shell template (the source the CLI stamps into `native/`).

`native/` is a **generated, disposable artifact** — gitignore it, never hand-edit it; regenerate with `appwrap init`.

## Prerequisites

- **[Bun](https://bun.sh)** — appwrap is bun-first (`curl -fsSL https://bun.sh/install | bash`).
- **NativeScript CLI** — for any simulator/device/store build (`init`/`sync` don't need it): `bun add -g nativescript`, then `ns doctor ios` / `ns doctor android` to verify the toolchain.
- **iOS** — Xcode + Command Line Tools (`xcode-select --install`; provides `xcodebuild` + `devicectl`) and CocoaPods (`brew install cocoapods`). A physical-device install needs the device registered to your Apple team — set `teamId` in `appwrap.config.ts`.
- **Android** — Android Studio + JDK 17. `ANDROID_HOME` is auto-detected from common SDK locations (export it only if yours is non-standard).

## Quick start (wrap your own PWA)

```bash
bun add -d @livx.cc/appwrap @livx.cc/native-kit
bun run build                 # your build → dist/
bunx appwrap init             # generate native/ (gitignore it)
bunx appwrap run ios          # compile + boot in the simulator (or: run android)
```

Describe the app in a typed config (preferred — autocomplete + type-checking via `defineConfig`):

```ts
// appwrap.config.ts
import { defineConfig } from '@livx.cc/appwrap/config';
export default defineConfig({ id: 'com.you.app', name: 'My App', version: '1.0.0', pwaDist: 'dist' });
```

A plain `appwrap.json` is still supported as a fallback. The CLI probes `appwrap.config.ts` → `appwrap.config.js` → `appwrap.json` (or pass `--config <path>`).

```ts
import { kit } from '@livx.cc/native-kit';
await kit.ready();
if (kit.haptics.capability === 'native') await kit.haptics.impact('medium');
```

## CLI

- **`appwrap init`** — generate `native/` from the config (+ first-time scaffold + `.gitignore`). Idempotent; won't clobber a `native/` it didn't generate without `--force`. Run after a framework upgrade or a fresh clone.
- **`appwrap sync`** — refresh `native/` from source (re-stamp config + re-copy built PWA + shell). Routine iteration.
- **`appwrap dev [--url <url>]`** — point the shell at a live dev server (loader `server`); reverts on the next `sync`. Dev server must bind `0.0.0.0` so a device can reach it.
- **`appwrap build ios|android [--release] [--aab]`** — release builds. Android signing from env (`APPWRAP_ANDROID_KEYSTORE` + password/alias — never in the config).
- **`appwrap deploy ios`** — build + install + launch on a connected device via `devicectl` (`ns run`/`ns deploy` can't see a physical device). `--device`, `--no-launch`, `--resume`/`-r` (skip build if ipa exists and inputs unchanged), `--force`/`-f` (always rebuild, ignoring cache). If `teamId` is unset an arrow-key team picker runs automatically (reads from keychain + provisioning profiles, shows paid/free badge).
- **`appwrap logs ios`** — stream the WebView console (forwarded to a file, since NativeScript native `console.log` doesn't reach `devicectl`/`idevicesyslog`). `--once`, `--native`.

## Config (`appwrap.config.ts` / `appwrap.json`)

TS preferred (typed via `defineConfig` from `@livx.cc/appwrap/config`); JSON still works as a fallback. The full shape + per-field docs live in `packages/appwrap-cli/src/config.ts`.

Required: `id`, `name`, `version`, `pwaDist`. Common optional: `entry`, `backgroundColor`, `statusBarStyle`, `urlScheme`, `icon`, `loader` (`app` bundled | `server` remote-load), `serverUrl`, `teamId`, `modules[]`, `permissions{}`, `buildNumber`, `storekitConfig`, `overrides`.

- **`modules[]`** — opt-in capability allow-list (see `runtime/app/shell/capabilities.manifest.ts`). Present → only the listed capabilities (+ always-on core) are advertised/permissioned/compiled-in (lighter build). Absent → all active. Each module declares its own perms / background-modes / native-deps / entitlements; the CLI collects + dedups.
- **`permissions{}`** — iOS usage strings (`location`, `photos`, `camera`, `microphone`, `faceid`, `calendar`, `contacts`, `motion`, `health`). With `modules`, only overrides a module's default copy.
- **`loader: "server"` + `serverUrl`** — remote-load: the shell loads a live URL instead of bundled `www`. Good for retrofitting a same-origin web app; no offline bundle.

## Capabilities

Always-on core (haptics, storage, toast, share, ui, device, clipboard, network, lifecycle) + opt-in modules: `notifications`, `biometrics`, `geo`, `photos`, `camera`, `media` (mic/camera/speaker), `motion`, `contacts`, `calendar`, `reviews`, `billing`, `health`, `oauth`, plus remote `push`. Always branch on `kit.<domain>.capability` and handle the `'web'`/`'none'` fallbacks.

**Adding a native capability** — self-contained module contract:
1. Manifest entry in `runtime/app/shell/capabilities.manifest.ts` (`MODULES[]`) declaring its own perms/entitlements/gradle-deps/native-source.
2. JS module in `packages/native-kit/src/modules/` + register in `core/NativeKit.ts` + export in `index.ts`.
3. Native handler in a `handlers*.ts` group, or — for an opt-in/heavy module — its own `handlers-<name>.ts` added to `OPTIONAL_GROUPS` (tree-shaken when inactive).
4. Module-owned native source (Swift/Kotlin) under `runtime/modules-native/<nativeSrc>/`.
5. Bump `SHELL_BUILD` in `handlers.ts`; add a kit unit test.

The handshake capability map + optional-handler barrel are generated into `native/app/shell/*.generated.ts` at init/sync — disposable, don't hand-edit.

## Gotchas

1. **`native/` is disposable** — gitignore it, never hand-edit; fix the source (`runtime/`, the config, `overrides/`) and regenerate.
2. **`.ipa` ≠ the intermediate `.app`** — inspect the signed app in the `.ipa` Payload, not `platforms/ios/build/.../*.app`.
3. **"signal 15" is not a crash** — it's SIGTERM (your `timeout`/console-detach). Real crashes are SIGABRT/SIGSEGV.
4. **Stale-bundle trap** — a build can report SUCCEEDED while shipping an old bundle if webpack/TS failed upstream. Verify a `SHELL_BUILD` marker, not just the exit code.
5. **CI must run `appwrap init`, not `sync`** — `native/` is gitignored → absent on a fresh checkout; `sync` fails, `init` regenerates.
6. **Service workers don't register under a custom scheme** in WKWebView (platform limit) — route their jobs to native lanes (`kit.push`, background-fetch, the shell's offline serving). Plain `Worker`/`SharedWorker` are fine.
7. **OAuth (Google etc.) is blocked in embedded WebViews** (`403 disallowed_useragent`) — use the `oauth` module (`kit.oauth.authorize` → system browser) then exchange the code → `signInWithCredential`.
8. **In-call audio routes to the earpiece** — WebRTC `getUserMedia` drives the iOS audio session to the receiver; the `media` module re-routes a call to the loudspeaker.

## Verify loop

Rebuild PWA → `appwrap sync` (or re-`init` after `runtime/` changes) → deploy → exercise on device. Kit unit tests: `bun test packages/`.
