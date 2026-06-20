import { kit, type BillingProvider, type Entitlement } from '@livx.cc/native-kit';

/** Demo web-checkout provider. In production this is
 *  `new HttpBillingProvider({ baseUrl: '/api/billing' })` → Stripe Checkout + Billing Portal.
 *  Here (no backend) it's in-memory so the web build shows the SAME kit.billing.* calls working. */
function demoWebBilling(): BillingProvider {
  let owned: Entitlement[] = [];
  return {
    products: async (ids) => ids.map((id) => ({
      id, title: id.split('.').pop()!, description: 'demo product',
      price: id.includes('coins') ? 0.99 : 4.99, displayPrice: id.includes('coins') ? '$0.99' : '$4.99',
      currency: 'USD', type: id.includes('coins') ? 'consumable' : 'autoRenewable',
      subscriptionPeriod: id.includes('coins') ? undefined : 'P1M',
    })),
    purchase: async (productId) => { owned = [{ productId, active: true, purchasedAt: Date.now() }]; return owned; },
    entitlements: async () => owned,
    manageSubscriptions: async () => { kit.toast.show('→ Stripe Billing Portal (demo)'); },
  };
}

const BUILD = 'media-diag-8'; // bump on each deploy so a stale bundle is obvious in the log

const $ = (id: string) => document.getElementById(id)!;

function log(msg: string) {
  const lines = $('loglines');
  lines.textContent = `${new Date().toTimeString().slice(0, 8)} ${msg}\n` + lines.textContent;
}

/** Single-line "last result" — replaced atomically so native a11y re-reads it reliably. */
function setLast(msg: string) {
  const old = $('last');
  const el = document.createElement('div');
  el.id = 'last';
  el.textContent = msg.slice(0, 80);
  old.replaceWith(el);
}

function badge(cap: string) {
  return `<span class="badge ${cap}">${cap}</span>`;
}

function tile(title: string, cap: string, buttons: Array<[string, () => Promise<unknown> | unknown]>) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `<h3>${title} ${badge(cap)}</h3><div class="row"></div>`;
  const row = el.querySelector('.row')!;
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = async () => {
      try {
        const r = await fn();
        log(`${title}/${label} ✓${r !== undefined ? ' → ' + JSON.stringify(r) : ''}`);
        setLast(`${title}/${label} OK${r !== undefined ? ' ' + JSON.stringify(r) : ''}`);
      } catch (e: any) {
        log(`${title}/${label} ✗ ${e.code ?? ''} ${e.message}`);
        setLast(`${title}/${label} ERR ${e.code ?? ''}`);
      }
    };
    row.appendChild(b);
  }
  $('tiles').appendChild(el);
  return el;
}

/** Render an image preview (data URL) inside a tile — proves the bytes reached the PWA. */
function showImg(tileEl: HTMLElement, dataUrl?: string) {
  showPreview(tileEl).innerHTML = dataUrl ? `<img src="${dataUrl}" alt="preview" />` : '';
}

function showPreview(tileEl: HTMLElement): HTMLElement {
  let box = tileEl.querySelector<HTMLElement>('.preview');
  if (!box) { box = document.createElement('div'); box.className = 'preview'; tileEl.appendChild(box); }
  return box;
}

const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;

// ── live media helpers (mic / camera / speaker) ──────────────────────
let camStream: MediaStream | null = null;

async function toggleCamera(tileEl: HTMLElement): Promise<string> {
  const box = showPreview(tileEl);
  if (camStream) { kit.media.stop(camStream); camStream = null; box.innerHTML = ''; return 'stopped'; }
  camStream = await kit.media.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  const v = document.createElement('video');
  v.className = 'cam';
  v.autoplay = true; v.muted = true; (v as any).playsInline = true; v.srcObject = camStream;
  box.innerHTML = ''; box.appendChild(v);
  const s = camStream.getVideoTracks()[0].getSettings();
  return `${s.width}×${s.height} live`;
}

function micLevelTest(tileEl: HTMLElement): Promise<string> {
  return kit.media.getUserMedia({ audio: true }).then((stream) => {
    const box = showPreview(tileEl);
    const meter = document.createElement('div'); meter.className = 'meter';
    const bar = document.createElement('span'); meter.appendChild(bar);
    box.innerHTML = ''; box.appendChild(meter);
    const ac = new AudioCtx();
    const an = ac.createAnalyser(); an.fftSize = 256;
    ac.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const t0 = Date.now(); let peak = 0;
    return new Promise<string>((resolve) => {
      const tick = () => {
        an.getByteTimeDomainData(data);
        let max = 0; for (const v of data) { const d = Math.abs(v - 128); if (d > max) max = d; }
        const lvl = Math.min(1, max / 128); peak = Math.max(peak, lvl);
        bar.style.width = `${Math.round(lvl * 100)}%`;
        if (Date.now() - t0 < 3000) requestAnimationFrame(tick);
        else { kit.media.stop(stream); ac.close(); resolve(`peak ${Math.round(peak * 100)}%`); }
      };
      tick();
    });
  });
}

async function recordTest(tileEl: HTMLElement): Promise<string> {
  await kit.media.configureAudio('playAndRecord').catch(() => {});
  const stream = await kit.media.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  return new Promise<string>((resolve, reject) => {
    rec.onstop = async () => {
      kit.media.stop(stream);
      await kit.media.configureAudio('playback').catch(() => {});
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const audio = document.createElement('audio'); audio.controls = true; audio.src = URL.createObjectURL(blob);
      showPreview(tileEl).replaceChildren(audio);
      audio.play().catch(() => {});
      resolve(`${Math.round(blob.size / 1024)}KB — playing back`);
    };
    rec.onerror = (e: any) => reject(e.error ?? new Error('record failed'));
    rec.start();
    setTimeout(() => rec.stop(), 3000);
  });
}

async function playTone(): Promise<string> {
  await kit.media.configureAudio('playback').catch(() => {}); // over the silent switch
  const ac = new AudioCtx();
  const osc = ac.createOscillator(); const g = ac.createGain();
  osc.frequency.value = 440; g.gain.value = 0.1;
  osc.connect(g).connect(ac.destination);
  osc.start(); setTimeout(() => { osc.stop(); ac.close(); }, 600);
  return '440Hz ♪';
}

// ── music player (background-capable playback) ───────────────────────
const TRACK_URL = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
let playerEl: HTMLAudioElement | null = null;

function ensurePlayer(tileEl: HTMLElement): HTMLAudioElement {
  if (!playerEl) {
    playerEl = document.createElement('audio');
    playerEl.src = TRACK_URL; playerEl.loop = true; playerEl.controls = true;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'AppWrap Demo Track', artist: 'native-kit' });
    }
    showPreview(tileEl).appendChild(playerEl);
  }
  return playerEl;
}

// ── video player (inline playback) ───────────────────────────────────
const VIDEO_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';
let videoEl: HTMLVideoElement | null = null;

function ensureVideo(tileEl: HTMLElement): HTMLVideoElement {
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.className = 'player';
    videoEl.src = VIDEO_URL; videoEl.controls = true; videoEl.loop = true;
    (videoEl as any).playsInline = true; // stay inline on iOS (no fullscreen takeover)
    showPreview(tileEl).appendChild(videoEl);
  }
  return videoEl;
}

/** Apply a theme color: recolor the page (visible) AND update the meta tag so
 * syncThemeColor() propagates it to the native chrome + status-bar contrast. */
function setThemeColor(color: string): string {
  document.documentElement.style.setProperty('--accent', color);
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = color;
  return color;
}

// ── tiny hash router (works under app://, https://appwrap.local and file://) ──
type RouteMatch = { page: 'home' | 'profile' | 'settings' | 'item'; id?: string };

function matchRoute(hash: string): RouteMatch {
  const path = (hash.replace(/^#/, '') || '/').split('?')[0];
  const segs = path.split('/').filter(Boolean);
  if (segs[0] === 'profile') return { page: 'profile' };
  if (segs[0] === 'settings') return { page: 'settings' };
  if (segs[0] === 'item') return { page: 'item', id: segs[1] ?? '1' };
  return { page: 'home' };
}

function navigate(path: string) {
  if (location.hash.replace(/^#/, '') !== path) location.hash = path;
  applyRoute(); // always re-apply — hashchange can be unreliable inside WebViews
}

function applyRoute() {
  const m = matchRoute(location.hash);
  document.querySelectorAll<HTMLElement>('.page').forEach((p) => p.classList.remove('active'));
  $(`page-${m.page}`).classList.add('active');
  document.querySelectorAll<HTMLAnchorElement>('#nav a').forEach((a) => {
    a.classList.toggle('active', matchRoute('#' + a.getAttribute('data-route')!).page === m.page);
  });
  if (m.page === 'item') {
    $('item-id').textContent = m.id ?? '—';
    $('item-link').textContent = `hellowrap://item/${m.id ?? '1'}`;
  }
  log(`route → /${m.page}${m.id ? '/' + m.id : ''}`);
}

/** Map an incoming deep-link URL (hellowrap://<host>/<seg>) to an internal route.
 * Parsed by hand — `new URL()` parses custom-scheme hosts inconsistently across
 * WebViews (fine in iOS JSC, drops the host in Android's Chromium build). */
function routeForDeepLink(url: string): string {
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)(?:\/([^/?#]+))?/i);
  const host = m?.[1];
  const seg = m?.[2];
  if (host === 'profile') return '/profile';
  if (host === 'settings') return '/settings';
  if (host === 'item') return `/item/${seg ?? '1'}`;
  return '/'; // demo/unknown → home
}

async function main() {
  try {
    const hs = await kit.ready();
    $('context').innerHTML =
      `<b>${hs.app.name}</b> v${hs.app.version} · protocol v${hs.protocol}<br/>` +
      `context: <b>${kit.is.native ? 'NATIVE' : 'WEB'}</b> · platform: ${hs.platform} · id: ${hs.app.id}`;
    log(`ver: app v${hs.app.version} · shell build ${hs.app.build ?? '?'} · proto v${hs.protocol} · pwa ${BUILD}`);
    log(`handshake ok — capabilities: ${JSON.stringify(hs.capabilities)}`);
    const tap = hs.debug?.lastNotifTap;
    if (tap) log(`lastNotifTap: ${JSON.stringify(tap)}`);
  } catch (e: any) {
    $('context').textContent = `handshake failed: ${e.message}`;
    log(`handshake ✗ ${e.message}`);
    return;
  }

  // Same kit.billing.* API everywhere: native shells use the device store (StoreKit/Play);
  // on the web we plug in a checkout provider (Stripe in prod) so the calls still work.
  if (kit.is.web) kit.billing.configure({ webProvider: demoWebBilling() });

  tile('Haptics', kit.haptics.capability, [
    ['light', () => kit.haptics.impact('light')],
    ['medium', () => kit.haptics.impact('medium')],
    ['heavy', () => kit.haptics.impact('heavy')],
    ['success', () => kit.haptics.notify('success')],
    ['error', () => kit.haptics.notify('error')],
  ]);

  tile('Share', kit.share.capability, [
    ['share link', () => kit.share.share({ title: 'AppWrap', text: 'Wrapped with appwrap 🎁', url: 'https://livx.cc' })],
  ]);

  tile('Share files', kit.share.filesCapability, [
    ['share .txt', () => kit.share.files(
      [{ name: 'hello.txt', mimeType: 'text/plain', base64: btoa('Hello from appwrap!') }],
      { text: 'A file from the kit' }
    )],
  ]);

  let counter = 0;
  tile('Storage', kit.storage.capability, [
    ['set', async () => { await kit.storage.set('counter', ++counter); return counter; }],
    ['get', () => kit.storage.get('counter')],
    ['remove', () => kit.storage.remove('counter')],
    ['kv-clear', () => kit.storage.clear()],
  ]);

  tile('Toast', kit.toast.capability, [
    ['short', () => kit.toast.show('Hello from the kit 👋')],
    ['long', () => kit.toast.show('This one sticks around a bit longer…', 'long')],
  ]);

  tile('Status bar', kit.ui.statusBarCapability, [
    ['light', () => kit.ui.setStatusBarStyle('light')],
    ['dark', () => kit.ui.setStatusBarStyle('dark')],
  ]);

  tile('Device', kit.device.capability, [
    ['info', async () => {
      const d = await kit.device.info();
      return `${d.model} ${d.os} ${d.osVersion} ${d.language}` + (d.battery ? ` 🔋${Math.round(d.battery.level * 100)}%` : '');
    }],
  ]);

  tile('Analytics ctx', kit.app.capability, [
    // The flat super-property bag you'd spread into mixpanel.register(...).
    ['kit.context()', async () => JSON.stringify(await kit.context())],
    ['app.environment()', async () => JSON.stringify(await kit.app.environment())],
  ]);

  tile('Clipboard', kit.clipboard.capability, [
    ['copy', () => kit.clipboard.copy('appwrap-was-here')],
    ['read', () => kit.clipboard.read()],
  ]);

  tile('Secure store', kit.storage.secure.capability, [
    ['lock-set', () => kit.storage.secure.set('token', 'sekret-123')],
    ['lock-get', () => kit.storage.secure.get('token')],
    ['lock-del', () => kit.storage.secure.remove('token')],
  ]);

  tile('Notifications', kit.notifications.capability, [
    ['permission', () => kit.notifications.requestPermission()],
    ['schedule 2s', () => kit.notifications.schedule({ title: 'AppWrap 🎁', body: 'Scheduled from the kit', delaySec: 2 })],
    // Background the app, then tap the notification → it deep-links to /item/7.
    ['deep-link 4s', () => kit.notifications.schedule({
      title: 'Tap me 👆', body: 'Opens item/7', delaySec: 4, deepLink: 'hellowrap://item/7',
    })],
    ['pending', () => kit.notifications.pending()],
    ['badge 3', () => kit.notifications.setBadge(3)],
    ['clear', () => kit.notifications.clear()],
  ]);

  tile('Biometrics', kit.biometrics.capability, [
    ['available', () => kit.biometrics.available()],
    ['auth', () => kit.biometrics.authenticate('Prove it is you')],
  ]);

  tile('Location', kit.geo.capability, [
    ['current', async () => {
      const g = await kit.geo.current();
      return `${g.lat.toFixed(4)},${g.lng.toFixed(4)}`;
    }],
    ['geo-watch', () => new Promise(async (resolve, reject) => {
      try {
        const stop = await kit.geo.watch((pos) => {
          stop();
          resolve(`${pos.lat.toFixed(4)},${pos.lng.toFixed(4)}`);
        });
        setTimeout(() => { stop(); reject(Object.assign(new Error('no position in 15s'), { code: 'TIMEOUT' })); }, 15000);
      } catch (e) { reject(e); }
    })],
  ]);

  const photosTile = tile('Photos', kit.photos.capability, [
    ['pick', () => kit.photos.pick()],
    ['pick → preview', async () => {
      const r = await kit.photos.pick({ dataUrl: true });
      showImg(photosTile, r.dataUrl);
      return r.picked ? `${r.width}×${r.height}${r.dataUrl ? ' (preview ✓)' : ''}` : 'cancelled';
    }],
  ]);

  tile('Network', kit.network.capability, [
    ['status', () => kit.network.status()],
  ]);

  tile('Screen', kit.ui.screenCapability, [
    ['safe area', () => kit.ui.safeArea()],
    ['dim', async () => { await kit.ui.setBrightness(0.2); return 0.2; }],
    ['bright', async () => { await kit.ui.setBrightness(0.9); return 0.9; }],
    ['awake on', () => kit.ui.keepAwake(true)],
    ['awake off', () => kit.ui.keepAwake(false)],
  ]);

  tile('Orientation', kit.screen.orientation.capability, [
    ['portrait', () => kit.screen.orientation.lock('portrait')],
    ['landscape', () => kit.screen.orientation.lock('landscape')],
    ['unlock', () => kit.screen.orientation.unlock()],
    ['current', () => kit.screen.orientation.current()],
  ]);
  kit.screen.orientation.onChange((o) => log(`orientation → ${o}`));

  // Keyboard — focus the input to raise it; the height lands in the log, "hide" dismisses it.
  const kbTile = tile('Keyboard', kit.keyboard.capability, [
    ['hide', () => kit.keyboard.hide()],
  ]);
  const kbInput = document.createElement('input');
  kbInput.type = 'text';
  kbInput.placeholder = 'tap to raise the keyboard';
  kbInput.style.cssText = 'width:100%;margin-top:8px;padding:8px;font:inherit;box-sizing:border-box';
  kbTile.appendChild(kbInput);
  kit.keyboard.onShow((e) => log(`keyboard show → ${e.height}px`));
  kit.keyboard.onHide(() => log('keyboard hide'));

  tile('Dialogs', kit.ui.dialogsCapability, [
    ['alert', () => kit.ui.alert({ title: 'AppWrap', message: 'Native alert via the kit' })],
    ['confirm', () => kit.ui.confirm({ title: 'AppWrap', message: 'Proceed with the demo?' })],
    ['sheet', () => kit.ui.action({ title: 'Pick a fruit', options: ['Apple', 'Banana'] })],
  ]);

  tile('Reviews', kit.reviews.capability, [
    ['rate us', () => kit.reviews.requestReview()],
  ]);

  tile('Theme', kit.ui.themeColorCapability, [
    ['indigo', () => setThemeColor('#4b0082')],
    ['crimson', () => setThemeColor('#dc143c')],
  ]);

  tile('Motion', kit.motion.capability, [
    ['sample', () => new Promise(async (resolve, reject) => {
      try {
        const stop = await kit.motion.watch((s) => {
          stop();
          resolve(`a=${s.ax.toFixed(1)},${s.ay.toFixed(1)},${s.az.toFixed(1)}`);
        });
        setTimeout(() => { stop(); reject(Object.assign(new Error('no sample in 3s'), { code: 'TIMEOUT' })); }, 3000);
      } catch (e) { reject(e); }
    })],
  ]);

  // Health / steps — opt-in module (appwrap.config.ts `modules: ["health", …]`). Live count in the
  // foreground; "BG+" reads steps accrued while the app was backgrounded (the OS keeps counting).
  let stepStop: (() => void) | null = null;
  tile('Steps', kit.health.capability, [
    ['grant', () => kit.health.requestAccess()],
    ['start (live)', () => new Promise(async (resolve, reject) => {
      try {
        if (stepStop) { stepStop(); stepStop = null; }
        stepStop = await kit.health.watch((steps) => kit.toast.show(`steps: ${steps}`));
        resolve('streaming — walk a bit (toasts update)');
      } catch (e) { reject(e); }
    })],
    ['count now', () => kit.health.count()],
    ['BG+ (read after backgrounding)', async () => `steps incl. background: ${await kit.health.count()}`],
    ['stop', () => { stepStop?.(); stepStop = null; return 'stopped'; }],
  ]);

  tile('Contacts', kit.contacts.capability, [
    ['pick contact', async () => {
      const c = await kit.contacts.pick();
      return c.picked ? `${c.name} ${c.phones?.[0] ?? ''}`.trim() : c;
    }],
  ]);

  tile('Calendar', kit.calendar.capability, [
    ['add event', () => kit.calendar.createEvent({ title: 'AppWrap demo 🎁', durationMin: 30 })],
  ]);

  const cameraTile = tile('Camera', kit.photos.cameraCapability, [
    ['capture', () => kit.photos.capture()],
    ['capture → preview', async () => {
      const r = await kit.photos.capture({ dataUrl: true });
      showImg(cameraTile, r.dataUrl);
      return r.picked ? `${r.width ?? '?'}×${r.height ?? '?'}${r.dataUrl ? ' (preview ✓)' : ''}` : 'cancelled';
    }],
  ]);

  // Live media — getUserMedia bridged into the PWA (mic / camera / speaker).
  const mediaTile = tile('Media (mic·cam·speaker)', kit.media.capability, [
    ['diagnostic', async () => {
      const info: any = { secureContext: window.isSecureContext, getUserMedia: kit.media.available };
      if (kit.is.native) info.native = await kit.invoke('debug.webviewInfo').catch(() => 'err');
      return info;
    }],
    ['mic 3s', () => micLevelTest(mediaTile)],
    ['camera', () => toggleCamera(mediaTile)],
    ['record 3s', () => recordTest(mediaTile)],
    ['speaker tone', () => playTone()],
    ['devices', async () => (await kit.media.devices()).map((d) => d.kind).join(', ') || '(none)'],
  ]);

  // Audio playback — music-player apps: plays over the iOS silent switch and
  // keeps going in the background (UIBackgroundModes audio).
  const playerTile = tile('Audio player', kit.media.capability, [
    ['▶ play', async () => { await kit.media.configureAudio('playback'); await ensurePlayer(playerTile).play(); return 'playing'; }],
    ['⏸ pause', () => { ensurePlayer(playerTile).pause(); return 'paused'; }],
  ]);

  // Inline video playback (the <video> stays in-page on iOS — playsInline).
  const videoTile = tile('Video player', kit.media.capability, [
    ['▶ play', async () => { await kit.media.configureAudio('playback'); await ensureVideo(videoTile).play(); return 'playing'; }],
    ['⏸ pause', () => { ensureVideo(videoTile).pause(); return 'paused'; }],
  ]);

  tile('App', kit.app.capability, [
    ['open url', () => kit.app.openUrl('https://livx.cc')],
    ['settings', () => kit.app.openSettings()],
  ]);

  tile('Browser', kit.browser.capability, [
    ['in-app', () => kit.browser.open('https://livx.cc', { toolbarColor: '#0b1020' })],
  ]);

  // IAP / subscriptions. Products resolve from a .storekit config (sim, Xcode-run) or
  // App Store Connect (device). Validation is pluggable — default ClientTrusted here.
  const PRODUCT_IDS = ['cc.livx.hellowrap.pro_monthly', 'cc.livx.hellowrap.coins_100'];
  tile('Billing', kit.billing.capability, [
    ['products', async () => {
      const ps = await kit.billing.products(PRODUCT_IDS);
      return ps.length ? ps.map((p) => `${p.id}=${p.displayPrice}`).join(' · ') : '(no products configured)';
    }],
    ['buy pro', async () => {
      const r = await kit.billing.purchase('cc.livx.hellowrap.pro_monthly');
      return r.entitlements.map((e) => e.productId).join(',') || 'purchased';
    }],
    ['restore', () => kit.billing.restore()],
    ['entitlements', () => kit.billing.entitlements()],
    ['manage subs', () => kit.billing.manageSubscriptions()],
  ]);

  // Deep-link round trip: hand our own scheme to the OS → it reopens us → router navigates.
  tile('Deep links', kit.app.capability, [
    ['→ profile', () => kit.app.openUrl('hellowrap://profile')],
    ['→ item/7', () => kit.app.openUrl('hellowrap://item/7')],
  ]);

  // ── wire the router ────────────────────────────────────────────────
  document.querySelectorAll<HTMLAnchorElement>('#nav a').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); navigate(a.getAttribute('data-route')!); };
  });
  window.addEventListener('hashchange', applyRoute);
  applyRoute(); // render the initial route

  // Copy the whole log to the clipboard (native clipboard in the shell, web fallback).
  $('copylog').onclick = async () => {
    const text = ($('last').textContent ?? '') + '\n' + ($('loglines').textContent ?? '');
    try { await kit.clipboard.copy(text); } catch { await navigator.clipboard?.writeText(text).catch(() => {}); }
    setLast('log copied ✓');
  };
  log(`build: ${BUILD}`); // build marker — confirms the running bundle is current

  // Keep native chrome tinted to the page's theme-color meta
  kit.ui.syncThemeColor();

  // Event surface — everything lands in the log
  kit.lifecycle.onPause(() => log('event: app.pause'));
  kit.lifecycle.onResume(() => log('event: app.resume'));
  kit.lifecycle.onDeepLink((url) => {
    log(`event: deeplink.open → ${url}`);
    setLast(`event deeplink ${url}`);
    navigate(routeForDeepLink(url)); // deep-link straight into the matching page
  });
  kit.network.onChange((s) => log(`event: network.change → ${s.type} online=${s.online}`));

  kit.storage.get<number>('counter').then((v) => { if (typeof v === 'number') counter = v; });
}

// PWA bits — only meaningful in real-web context; the native shell serves from the bundle
// (Android shell origin is https://appwrap.local, so also gate on the native transport).
const inNativeShell = !!(window as any).appwrapNative || !!(window as any).webkit?.messageHandlers?.appwrap;
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !inNativeShell) {
  navigator.serviceWorker.register('sw.js').catch((e) => log(`sw register failed: ${e.message}`));
}

main();
