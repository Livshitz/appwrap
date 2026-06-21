# appwrap push relay

The reference backend that turns `kit.push` from "get a token" into a real notification. `kit.push` is
provider-agnostic — it hands your app a device token; *sending* is a server's job. This relay is that
server: the app POSTs its token on register, the relay sends a welcome push (and remembers it so you can
broadcast later). Deploy it once and every user of your app gets remote notifications.

```
app (kit.push.register) ──POST /register {token,platform,topic}──▶ relay ──▶ APNs (.p8) / FCM (v1) ──▶ 📱
```

## Endpoints
- `POST /register` `{ token, platform: "ios"|"android", topic? }` → stores the token + sends a welcome push.
- `POST /broadcast` `{ title?, body? }` (Bearer `RELAY_API_KEY`) → pushes every stored token.
- `GET /health` → `{ ok, tokens }`.

## Secrets (`bod env set KEY=VALUE -a appwrap-push-relay`)
| key | what |
|-----|------|
| `APNS_KEY_B64` | base64 of your APNs auth key `.p8` (`base64 -i AuthKey_XXXX.p8`) |
| `APNS_KID` | the APNs Key ID |
| `APNS_TEAM` | your Apple Team ID |
| `APNS_DEFAULT_TOPIC` | default bundle id (e.g. `cc.livx.hellowrap.paid`) if the app omits `topic` |
| `APNS_PROD` | `1` for App Store builds; omit/`0` for sandbox (dev/TestFlight) |
| `FCM_SA_B64` | base64 of a Firebase service-account JSON (for Android/FCM HTTP v1) |
| `RELAY_API_KEY` | optional bearer for `/broadcast` |

## Deploy
```
bod deploy --upload    # from this directory (reads bodify.yaml)
```
APNs is HTTP/2-only — handled here via `node:http2` (no curl/library needed). The app wires it with one
line in `kit.push.register().then(t => fetch(RELAY+'/register', {method:'POST', body: JSON.stringify({token:t.token, platform: t.platform, topic: appBundleId})}))`.
