import { kit } from '@livx.cc/native-kit';

/** A random, URL-safe nonce for Sign in with Apple (Firebase needs the RAW value back as rawNonce). */
function randomNonce(len = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => '0123456789abcdef'[b & 15] + '0123456789abcdef'[b >> 4]).join('').slice(0, len);
}

const BUILD = 'loopbc-1'; // bump on each deploy so a stale bundle is obvious in the log

// The demo's own public push relay (examples/push-relay). Not a secret — the relay only sends a test
// push to a token YOU register; the "send" half lives in the app, not the kit. Safe to commit.
const PUSH_RELAY_URL = 'https://appwrap-push-relay.bodify.bod.ee';

const $ = (id: string) => document.getElementById(id)!;

function log(msg: string) {
  const lines = $('loglines');
  lines.textContent = `${new Date().toTimeString().slice(0, 8)} ${msg}\n` + lines.textContent;
  // Also emit to the console so the native shell forwards it (`appwrap logs ios`) — lets every
  // tile result be verified on-device headlessly, not just read off the screen.
  console.log('[demo]', msg);
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

/** Which platforms a capability is meaningful on — drives the All/Mobile/Desktop filter pills.
 * This is CROSS-platform knowledge (what mobile vs desktop each support), so it's static: a single
 * handshake only reports the platform we're running on, it can't tell us the other's capabilities.
 * The live per-platform support still shows in each tile's badge (native/web/none). */
type Plat = 'both' | 'mobile' | 'desktop';

function tile(title: string, cap: string, buttons: Array<[string, () => Promise<unknown> | unknown]>, platforms: Plat = 'both') {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.platforms = platforms;
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
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string };
        log(`${title}/${label} ✗ ${err.code ?? ''} ${err.message ?? ''}`);
        setLast(`${title}/${label} ERR ${err.code ?? ''}`);
      }
    };
    row.appendChild(b);
  }
  $('tiles').appendChild(el);
  return el;
}

/** Dim a tile, disable its buttons, and append a note — for a capability absent on this platform. */
function markUnsupported(tileEl: HTMLElement, note: string) {
  tileEl.classList.add('unsupported');
  tileEl.querySelectorAll('button').forEach((b) => (b as HTMLButtonElement).disabled = true);
  const n = document.createElement('div');
  n.className = 'note';
  n.textContent = note;
  tileEl.appendChild(n);
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

const AudioCtx = (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;

// ── live media helpers (mic / camera / speaker) ──────────────────────
let camStream: MediaStream | null = null;

async function toggleCamera(tileEl: HTMLElement): Promise<string> {
  const box = showPreview(tileEl);
  if (camStream) { kit.media.stop(camStream); camStream = null; box.innerHTML = ''; return 'stopped'; }
  camStream = await kit.media.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  const v = document.createElement('video');
  v.className = 'cam';
  v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = camStream;
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
    rec.onerror = (e: Event) => reject((e as { error?: unknown }).error ?? new Error('record failed'));
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
    videoEl.playsInline = true; // stay inline on iOS (no fullscreen takeover)
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
  let currentPlatform = 'web';
  try {
    const hs = await kit.ready();
    currentPlatform = hs.platform;
    $('context').innerHTML =
      `<b>${hs.app.name}</b> v${hs.app.version} · protocol v${hs.protocol}<br/>` +
      `context: <b>${kit.is.native ? 'NATIVE' : 'WEB'}</b> · platform: ${hs.platform} · id: ${hs.app.id}`;
    log(`ver: app v${hs.app.version} · shell build ${hs.app.build ?? '?'} · proto v${hs.protocol} · pwa ${BUILD}`);
    log(`handshake ok — capabilities: ${JSON.stringify(hs.capabilities)}`);
    const tap = hs.debug?.lastNotifTap;
    if (tap) log(`lastNotifTap: ${JSON.stringify(tap)}`);
    // COLD-START deep link: the shell handed the launch link back IN the handshake, so we can route to
    // the target BEFORE first paint (no `/home` flash). The initial applyRoute() below renders it.
    // Warm links still arrive via kit.lifecycle.onDeepLink (wired further down).
    const launchLink = kit.lifecycle.launchDeepLink;
    if (launchLink) {
      location.hash = routeForDeepLink(launchLink);
      log(`cold deeplink → ${launchLink}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    $('context').textContent = `handshake failed: ${msg}`;
    log(`handshake ✗ ${msg}`);
    return;
  }

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

  tile('Scanner', kit.scanner.capability, [
    ['scan QR/barcode', async () => {
      const r = await kit.scanner.scan({ formats: 'all' });
      return 'cancelled' in r ? 'cancelled' : `${r.format}: ${r.value.slice(0, 40)}`;
    }],
  ]);

  // Speech: TTS badge on the tile; STT (recognitionCapability) noted on its own button.
  kit.speech.onPartial((p) => log(`Speech/partial → ${p.transcript}`));
  tile(`Speech (STT ${kit.speech.recognitionCapability})`, kit.speech.capability, [
    ['speak', async () => { await kit.speech.speak('Hello from AppWrap'); return 'spoken'; }],
    ['stop', () => kit.speech.stop()],
    ['voices', async () => `${(await kit.speech.voices()).length} voices`],
    ['tap to listen', async () => {
      if (kit.speech.recognitionCapability === 'none') return 'STT unsupported here';
      const transcript = await kit.speech.listen({ partial: true });
      return `heard: ${transcript.slice(0, 60) || '(nothing)'}`;
    }],
    ['stop listening', () => kit.speech.stopListening()],
  ]);

  // Tracking (iOS App Tracking Transparency). cap 'none' off iOS (no ATT) → buttons resolve to the
  // honest fallback ('authorized' / no IDFA) without prompting.
  tile('Tracking (ATT)', kit.tracking.capability, [
    ['request consent', () => kit.tracking.requestPermission()],
    ['status', () => kit.tracking.status()],
    ['idfa', async () => (await kit.tracking.idfa()) ?? '(none — not authorized / off iOS)'],
  ]);

  // Native Sign in with Apple (iOS ASAuthorization). Generates a raw nonce, signs in, and shows the
  // identityToken JWT header (proves a real token came back) + the raw nonce you'd pass to Firebase as
  // rawNonce. Resolves '(cancelled)' if the user dismisses the sheet (never throws).
  tile('Sign in with Apple', kit.appleSignIn.capability, [
    ['sign in', async () => {
      const nonce = randomNonce();
      const r = await kit.appleSignIn.signIn({ nonce });
      if (!('identityToken' in r)) return '(cancelled)';
      const head = r.identityToken.split('.')[0] ?? '';
      return `token.header=${head.slice(0, 24)}… nonce=${r.nonce.slice(0, 8)}… user=${r.user?.email ?? r.user?.name?.displayName ?? '(none — not first auth)'}`;
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

  // Filesystem — round-trips a file (write → read → list), then opens the document picker.
  tile('Filesystem', kit.fs.capability, [
    ['write+read', async () => {
      await kit.fs.write('demo/note.txt', `hello @ ${Date.now()}`);
      return kit.fs.read('demo/note.txt');
    }],
    ['list', () => kit.fs.list('demo')],
    ['stat', () => kit.fs.stat('demo/note.txt')],
    ['pick', async () => (await kit.fs.pickFile()).map((f) => `${f.name} (${f.size}b)`)],
  ]);

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

  // Background task — opt-in module (appwrap.config.ts `modules: ["backgroundTask", …]` +
  // `backgroundTasks: ["sync"]`). The 'sync' handler writes Date.now() to kit.storage; the OS runs it
  // headlessly when IT decides (can't be triggered on demand). "run now" proves the handler + API shape
  // work in the foreground; "last bg-run" shows the most recent recorded timestamp.
  const BG_KEY = 'lastBgRun';
  const syncHandler = async () => { await kit.storage.set(BG_KEY, Date.now()); };
  kit.backgroundTask.register('sync', syncHandler); // idempotent — call at boot on every launch
  tile('Background task', kit.backgroundTask.capability, [
    ['schedule (~15m)', async () => { await kit.backgroundTask.schedule({ id: 'sync', minIntervalMs: 15 * 60_000 }); return 'scheduled — OS wakes when it decides'; }],
    ['run now (manual)', async () => { await syncHandler(); return 'handler ran (foreground proof)'; }],
    ['last bg-run', async () => {
      const ts = await kit.storage.get<number>(BG_KEY);
      return ts ? new Date(ts).toLocaleString() : 'never';
    }],
    ['cancel', async () => { await kit.backgroundTask.cancel('sync'); return 'cancelled'; }],
  ]);

  tile('Contacts', kit.contacts.capability, [
    ['pick contact', async () => {
      const c = await kit.contacts.pick();
      return c.picked ? `${c.name} ${c.phones?.[0] ?? ''}`.trim() : c;
    }],
    ['scan all (getAll)', async () => {
      const { contacts } = await kit.contacts.getAll(); // full address book (needs Contacts permission)
      const first = contacts[0];
      return `${contacts.length} contacts${first ? ` · e.g. ${first.name ?? '?'} ${first.phones?.[0] ?? ''}`.trim() : ''}`;
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
      const info: Record<string, unknown> = { secureContext: window.isSecureContext, getUserMedia: kit.media.available };
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
    // canOpenUrl is honest out-of-the-box: https resolves everywhere (→ true); an undeclared, clearly-
    // fictional custom scheme (→ false). To probe a REAL installed app by custom scheme (e.g. whatsapp://)
    // declare the scheme in appwrap.config.ts `queryUrlSchemes` (stamps iOS + Android in one go).
    ['can open https', async () => `https → ${await kit.app.canOpenUrl('https://livx.cc')}`],
    ['can open (none)', async () => `appwrap-not-installed:// → ${await kit.app.canOpenUrl('appwrap-not-installed://x')}`],
  ]);

  // Home-screen long-press quick actions. Set 1-2; long-press the app icon to activate → onShortcut.
  kit.app.onShortcut((id) => log(`shortcut activated → ${id}`));
  tile('Shortcuts', kit.app.shortcutsCapability, [
    ['set 2', async () => {
      await kit.app.setShortcuts([
        { id: 'new', title: 'New Item', subtitle: 'Create' },
        { id: 'search', title: 'Search' },
      ]);
      return 'set — long-press the app icon';
    }],
    ['clear', async () => { await kit.app.setShortcuts([]); return 'cleared'; }],
  ]);

  // Privacy screen — blur in the app-switcher + block screenshots (Android FLAG_SECURE).
  tile('Privacy screen', kit.screen.privacyCapability, [
    ['on', async () => { await kit.screen.setPrivacy(true); return 'on — background the app to see the blur'; }],
    ['off', async () => { await kit.screen.setPrivacy(false); return 'off'; }],
  ]);

  // App-icon badge — set a count on the home-screen icon; "clear" removes it.
  tile('Badge', kit.app.badgeCapability, [
    ['set 3', () => kit.app.badge(3)],
    ['clear', () => kit.app.badge(0)],
  ]);

  tile('Browser', kit.browser.capability, [
    ['in-app', () => kit.browser.open('https://livx.cc', { toolbarColor: '#0b1020' })],
  ]);

  // Deep-link round trip: hand our own scheme to the OS → it reopens us → router navigates.
  tile('Deep links', kit.app.capability, [
    ['→ profile', () => kit.app.openUrl('hellowrap://profile')],
    ['→ item/7', () => kit.app.openUrl('hellowrap://item/7')],
  ]);

  // OTA updates — checks the deployed manifest for a newer bundle. On a bundled/app:// build
  // `latest` is unknown (no manifest URL) → updateAvailable:false, honestly. reload() hard-reloads.
  kit.updates.onAvailable((s) => log(`update available → ${s.latest}`));
  tile('Updates', kit.updates.capability, [
    ['check', () => kit.updates.check()],
    ['reload', () => kit.updates.reload()],
  ]);

  // System-browser OAuth (iOS ASWebAuthenticationSession). Opt-in module; the sheet closes the moment
  // the provider redirects back to our callbackScheme. Demo points at a public test endpoint.
  tile('OAuth', kit.oauth.capability, [
    ['authorize', () => kit.oauth.authorize({
      url: 'https://example.com/oauth/authorize?client_id=demo&redirect_uri=hellowrap://oauth&response_type=code',
      callbackScheme: 'hellowrap',
    })],
  ]);

  // Remote push (APNs/FCM). Gated by `push:{enabled}` in appwrap.config (NOT the modules list) — the iOS
  // aps-environment entitlement needs a PAID team. register() returns a raw token; sending is your
  // backend's job. NOTE: a token is NOT permission — register() gets an APNs token even while
  // authorization is `notDetermined`, but iOS silently DROPS the alert until the user grants
  // notifications. So you must requestPermission() (shows the prompt) before a push will display.
  kit.push.onMessage((m) => log(`push message → ${JSON.stringify(m).slice(0, 60)}`));
  tile('Push', kit.push.capability, [
    ['request permission', () => kit.push.requestPermission()],
    ['permission', () => kit.push.permissionStatus()],
    ['register', async () => (await kit.push.register()).token.slice(0, 24) + '…'],
    // The DEMO sends the test push (not the kit): grab the token, then POST it to our relay's /register
    // with test:true. The relay serves CORS + OPTIONS, so this cross-origin WebView fetch reaches it.
    ['send me a push', async () => {
      // Ensure the user has been prompted — otherwise the push is delivered but never shown.
      if (await kit.push.permissionStatus() === 'notDetermined') await kit.push.requestPermission();
      const { platform, token, topic } = await kit.push.register();
      const res = await fetch(`${PUSH_RELAY_URL}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // `topic` = the iOS bundle id; APNs REQUIRES the apns-topic to match the token's app or it
        // rejects with `DeviceTokenNotForTopic`. The shell resolves it natively (NSBundle bundle id)
        // and returns it on the token — no hardcoding. Omitted when undefined (web/FCM ignore it).
        body: JSON.stringify({ token, platform: platform === 'apns' ? 'ios' : 'android', ...(topic ? { topic } : {}), test: true }),
      });
      // Surface the relay's REAL result (it always returns HTTP 200; the APNs reason is in the body) —
      // so a failure like DeviceTokenNotForTopic / BadDeviceToken is visible, not masked by the 200.
      const r = await res.json().catch(() => ({}));
      return r.sent
        ? 'sent ✓ (lock the phone / background the app to see the banner)'
        : `relay ok but APNs rejected → ${r.result?.reason ?? JSON.stringify(r).slice(0, 80)}`;
    }],
  ]);

  // ── Desktop-specific demos ─────────────────────────────────────────
  // Native on the desktop shell; degrade gracefully elsewhere. Tagged 'desktop' so the
  // filter pills group them, and the ones with no cross-platform fallback show a disabled note.
  const isDesktop = currentPlatform === 'desktop';
  const dcap = isDesktop ? 'native' : 'none';
  const SCHEME = 'hellowrap'; // matches urlScheme in appwrap.config.ts

  // Dock badge — set/clear the macOS Dock-icon badge count (kit.notifications.setBadge / clear).
  const dockBadgeTile = tile('Dock badge', kit.app.badgeCapability, [
    ['set', () => { const n = Number(dockBadgeInput.value) || 0; return kit.notifications.setBadge(n).then(() => `Dock badge → ${n}`); }],
    ['clear', () => kit.notifications.clear().then(() => 'cleared')],
  ], 'desktop');
  const dockBadgeInput = document.createElement('input');
  dockBadgeInput.type = 'number'; dockBadgeInput.value = '5'; dockBadgeInput.placeholder = 'badge count';
  dockBadgeTile.appendChild(dockBadgeInput);

  // Dock bounce — request user attention (macOS Dock-icon bounce). Switch to another app to see it.
  const bounceTile = tile('Dock bounce', dcap, [
    ['bounce (switch away in 3s)', () => {
      setTimeout(() => kit.invoke('app.requestAttention', { critical: true }).catch((e) => log(`bounce ✗ ${e?.message ?? e}`)), 3000);
      return 'bouncing in 3s — switch to another app now';
    }],
  ], 'desktop');
  if (!isDesktop) markUnsupported(bounceTile, 'Desktop only — no Dock to bounce on this platform.');

  // Notification — the desktop toast is a real Notification Center banner.
  tile('Notification', kit.toast.capability, [
    ['show banner', () => kit.toast.show('AppWrap desktop notification 🔔')],
  ], 'desktop');

  // Popup window — window.open a small child window (desktop chassis renders it as a real popup).
  tile('Popup window', 'web', [
    ['open example.com', () => { window.open('https://example.com', '_blank', 'width=400,height=500'); return 'opened popup'; }],
  ], 'desktop');

  // Deep link — the app's registered scheme + a copyable test link.
  const dlTile = tile('Deep link', kit.app.capability, [
    ['copy link', () => kit.clipboard.copy(`${SCHEME}://test`).then(() => `copied ${SCHEME}://test`)],
    ['open', () => kit.app.openUrl(`${SCHEME}://test`)],
  ], 'desktop');
  const dlNote = document.createElement('div');
  dlNote.className = 'note';
  dlNote.innerHTML = `scheme: <code>${SCHEME}://test</code>`;
  dlTile.appendChild(dlNote);

  // ── Tag mobile-only capabilities (hardware/OS features desktop has no equivalent for) ──────
  // Everything else stays 'both'. This is static cross-platform knowledge (see the Plat note above).
  const MOBILE_ONLY = new Set([
    'Haptics', 'Push', 'Motion', 'Biometrics', 'Steps', 'Camera', 'Photos', 'Scanner',
    'Tracking (ATT)', 'Sign in with Apple', 'Orientation', 'Keyboard', 'Background task',
    'Contacts', 'Calendar', 'Reviews', 'Privacy screen', 'Status bar', 'Shortcuts', 'Screen',
  ]);
  document.querySelectorAll<HTMLElement>('#tiles .tile').forEach((t) => {
    if (t.dataset.platforms !== 'both') return; // desktop tiles already tagged
    const name = (t.querySelector('h3')?.firstChild?.textContent ?? '').trim();
    if (MOBILE_ONLY.has(name)) t.dataset.platforms = 'mobile';
  });

  // ── Platform filter pills (All / Mobile / Desktop) — default to the current platform ───────
  const PILL_KEY = 'demo.platformPill';
  const defaultPill = isDesktop ? 'desktop' : (currentPlatform === 'ios' || currentPlatform === 'android') ? 'mobile' : 'all';
  let selectedPill = localStorage.getItem(PILL_KEY) ?? defaultPill;
  const pillBox = $('pills');
  const applyFilter = () => {
    document.querySelectorAll<HTMLElement>('#tiles .tile').forEach((t) => {
      const p = t.dataset.platforms;
      t.style.display = selectedPill === 'all' || p === 'both' || p === selectedPill ? '' : 'none';
    });
    pillBox.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('active', b.dataset.val === selectedPill));
  };
  for (const [label, val] of [['All', 'all'], ['Mobile', 'mobile'], ['Desktop', 'desktop']] as const) {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.val = val;
    b.onclick = () => { selectedPill = val; localStorage.setItem(PILL_KEY, val); applyFilter(); };
    pillBox.appendChild(b);
  }
  applyFilter();

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

  // Headless push-token capture: after the handshake resolves the capability map, auto-register and
  // log the FULL APNs/FCM token to the console (forwarded via `appwrap logs ios`) so a test push can
  // be sent without a UI tap. The token isn't a secret (sending still needs the APNs key).
  kit.ready().then(() => {
    if (kit.push.capability !== 'native') return; // web / un-provisioned build
    // The token reaches the relay NATIVELY (appwrap.config push.registrationUrl) — the shell POSTs it,
    // sidestepping the WKWebView app:// CORS wall — and the relay sends a welcome push. Nothing to do here
    // but confirm registration fired.
    kit.push.register()
      .then((t) => log(`PUSH TOKEN [${t.platform}] ${t.token}`))
      .catch((e) => log(`push register failed: ${e?.message ?? e}`));
  });

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
const inNativeShell = !!(window as { appwrapNative?: unknown }).appwrapNative
  || !!(window as { webkit?: { messageHandlers?: { appwrap?: unknown } } }).webkit?.messageHandlers?.appwrap;
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !inNativeShell) {
  navigator.serviceWorker.register('sw.js').catch((e) => log(`sw register failed: ${e.message}`));
}

main();
