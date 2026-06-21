/**
 * appwrap push relay — the reference backend the demo (and any appwrap app) POSTs its push token to.
 * On register it sends a welcome push and remembers the token so you can broadcast later.
 *
 *   kit.push.register()  →  POST /register {token, platform, topic}  →  APNs (.p8) / FCM (HTTP v1)  →  📱
 *
 * Provider-agnostic by design: `kit.push` only hands you the device token; THIS is the "send" half.
 * Secrets (via `bod env set`): APNS_KEY_B64, APNS_KID, APNS_TEAM, APNS_PROD?, FCM_SA_B64, RELAY_API_KEY?.
 */
import { connect as http2connect } from 'node:http2';
import { createSign } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const env = (k: string) => process.env[k] || '';

// ── token store (BodDB-free: in-memory is fine for a demo relay; survives within an instance) ──
type Entry = { token: string; platform: 'ios' | 'android'; topic?: string; at: number };
const tokens = new Map<string, Entry>(); // key = `${platform}:${token}`

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

// ── APNs (iOS) — token-based (.p8) over HTTP/2 ──
function apnsJwt(): string {
  const key = Buffer.from(env('APNS_KEY_B64'), 'base64').toString('utf8');
  const iat = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: env('APNS_KID') })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: env('APNS_TEAM'), iat })).toString('base64url');
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}
let apnsJwtCache: { jwt: string; at: number } | null = null;
function apnsJwtCached(): string {
  if (!apnsJwtCache || Date.now() - apnsJwtCache.at > 50 * 60_000) apnsJwtCache = { jwt: apnsJwt(), at: Date.now() };
  return apnsJwtCache.jwt;
}
function sendApns(token: string, topic: string, title: string, body: string): Promise<{ status: number; id?: string; reason?: string }> {
  const host = env('APNS_PROD') === '1' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  return new Promise((resolve) => {
    const client = http2connect(host);
    let settled = false;
    const done = (r: { status: number; id?: string; reason?: string }) => { if (settled) return; settled = true; try { client.close(); } catch {} resolve(r); };
    client.on('error', (e: any) => done({ status: 0, reason: String(e?.message || e) }));
    const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default', badge: 1 } });
    const req = client.request({
      ':method': 'POST', ':path': `/3/device/${token}`,
      authorization: `bearer ${apnsJwtCached()}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10',
    });
    let status = 0, id: string | undefined, data = '';
    req.on('response', (h: any) => { status = h[':status']; id = h['apns-id']; });
    req.on('data', (c: Buffer) => (data += c));
    // Resolve at end so a non-200 surfaces APNs's `reason` (e.g. BadDeviceToken) instead of losing it.
    req.on('end', () => done({ status, id, reason: data ? (() => { try { return JSON.parse(data).reason; } catch { return data.slice(0, 120); } })() : undefined }));
    req.end(payload);
  });
}

// ── FCM (Android) — HTTP v1 with a service-account OAuth token ──
let fcmTok: { tok: string; at: number } | null = null;
async function fcmAccessToken(sa: any): Promise<string> {
  if (fcmTok && Date.now() - fcmTok.at < 50 * 60_000) return fcmTok.tok;
  const iat = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  })).toString('base64url');
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${head}.${claim}.${sig}`,
  });
  const j = await res.json();
  fcmTok = { tok: j.access_token, at: Date.now() };
  return j.access_token;
}
async function sendFcm(token: string, title: string, body: string): Promise<{ status: number; reason?: string }> {
  const sa = JSON.parse(Buffer.from(env('FCM_SA_B64'), 'base64').toString('utf8'));
  const at = await fcmAccessToken(sa);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title, body } } }),
  });
  return { status: res.status, reason: res.ok ? undefined : (await res.text()).slice(0, 200) };
}

const WELCOME = { title: 'Welcome to AppWrap 👋', body: 'Remote push works — this notification came from the relay.' };

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/health') return json({ ok: true, tokens: tokens.size });

    // Register a device token. Apps register on EVERY launch (to keep the latest token), so the welcome
    // push fires ONLY the first time we see a token — re-registering is just a silent refresh, not a
    // notification every launch. (In-memory: a relay restart re-welcomes once, fine for a demo.)
    if (url.pathname === '/register' && req.method === 'POST') {
      const { token, platform, topic } = (await req.json().catch(() => ({}))) as any;
      if (!token || (platform !== 'ios' && platform !== 'android')) return json({ error: 'token + platform(ios|android) required' }, 400);
      const key = `${platform}:${token}`;
      const isNew = !tokens.has(key);
      tokens.set(key, { token, platform, topic, at: Date.now() });
      if (!isNew) return json({ ok: true, sent: false, alreadyRegistered: true, registered: tokens.size });
      const result = platform === 'ios'
        ? await sendApns(token, topic || env('APNS_DEFAULT_TOPIC'), WELCOME.title, WELCOME.body)
        : await sendFcm(token, WELCOME.title, WELCOME.body);
      const ok = result.status === 200;
      console.log(`[relay] register ${platform} (new) → ${ok ? 'sent welcome' : 'FAILED'} ${JSON.stringify(result)}`);
      return json({ ok, sent: ok, result, registered: tokens.size });
    }

    // Broadcast to every stored token (api-key protected).
    if (url.pathname === '/broadcast' && req.method === 'POST') {
      if (env('RELAY_API_KEY') && req.headers.get('authorization') !== `Bearer ${env('RELAY_API_KEY')}`) return json({ error: 'unauthorized' }, 401);
      const { title, body } = (await req.json().catch(() => ({}))) as any;
      let sent = 0;
      for (const e of tokens.values()) {
        const r = e.platform === 'ios'
          ? await sendApns(e.token, e.topic || env('APNS_DEFAULT_TOPIC'), title || WELCOME.title, body || WELCOME.body)
          : await sendFcm(e.token, title || WELCOME.title, body || WELCOME.body);
        if (r.status === 200) sent++;
      }
      return json({ ok: true, sent, of: tokens.size });
    }

    return json({ service: 'appwrap-push-relay', endpoints: ['POST /register', 'POST /broadcast', 'GET /health'] });
  },
});
console.log(`[relay] listening on :${PORT}`);
