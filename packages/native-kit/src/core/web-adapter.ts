import { Capability, Handshake, KitError, NativeKitAdapter, Unsubscribe } from './types';

/** Decode raw base64 → an ArrayBuffer for File construction (no `data:` prefix expected). */
function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Encode an ArrayBuffer → raw base64 (no `data:` prefix). */
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Map our lock vocabulary to valid ScreenOrientation `OrientationLockType` values. */
function toWebOrientation(o: string): any {
  switch (o) {
    case 'portrait-upside-down': return 'portrait-secondary';
    case 'landscape-left': return 'landscape-primary';
    case 'landscape-right': return 'landscape-secondary';
    default: return o; // 'portrait' | 'landscape' | 'any' are already valid
  }
}

/**
 * Browser fallback adapter. Fulfills what the Web Platform can, reports honest
 * capability flags for the rest. Methods for unsupported capabilities resolve
 * as no-ops — callers branch on capability flags, not try/catch.
 */
export class WebAdapter implements NativeKitAdapter {
  readonly kind = 'web' as const;
  private toastEl: HTMLElement | null = null;
  private wakeLock: any = null;
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private geoWatchId: number | null = null;
  private motionHandler: ((e: DeviceMotionEvent) => void) | null = null;
  /** Tear-down for an in-progress scanner.scan loop (stops the camera, removes the overlay). */
  private scanCancel: (() => void) | null = null;
  /** Stop an in-progress speech.listen session (resolves it with the best transcript so far). */
  private listenStop: (() => void) | null = null;

  detect(): boolean {
    return typeof window !== 'undefined';
  }

  async handshake(): Promise<Handshake> {
    const n = navigator as any;
    const caps: Record<string, Capability> = {
      haptics: 'vibrate' in navigator ? 'web' : 'none',
      share: 'share' in navigator ? 'web' : 'none',
      shareFiles: typeof n.canShare === 'function' ? 'web' : 'none', // navigator.canShare({files}) gates at call time
      orientation: (screen as any)?.orientation ? 'web' : 'none', // Screen Orientation API (lock needs fullscreen)
      storage: 'web',
      secureStorage: 'none',
      // OPFS (navigator.storage.getDirectory) backs read/write/list; pickFile falls back to
      // <input type=file> even without OPFS, so 'web' whenever either surface exists.
      fs: n.storage?.getDirectory || typeof document !== 'undefined' ? 'web' : 'none',
      toast: 'web',
      statusBar: 'none',
      device: 'web',
      clipboard: navigator.clipboard ? 'web' : 'none',
      notifications: 'Notification' in window ? 'web' : 'none',
      badge: typeof (navigator as any).setAppBadge === 'function' ? 'web' : 'none', // Badging API (PWA icon badge)
      biometrics: 'none',
      geo: 'geolocation' in navigator ? 'web' : 'none',
      photos: 'web',
      network: 'web',
      screen: 'wakeLock' in n ? 'web' : 'none',
      keyboard: (window as any).visualViewport ? 'web' : 'none', // VisualViewport resize ≈ keyboard show/hide
      dialogs: 'web',
      reviews: 'none',
      themeColor: 'web', // the browser honors <meta name="theme-color"> itself
      motion: typeof DeviceMotionEvent !== 'undefined' ? 'web' : 'none',
      contacts: n.contacts?.select ? 'web' : 'none',
      calendar: 'none',
      camera: 'web', // <input capture> — mobile browsers open the camera
      media: (navigator as any).mediaDevices?.getUserMedia ? 'web' : 'none',
      // BarcodeDetector (Chrome/Android) decodes; needs a getUserMedia stream to feed it. Both → 'web'.
      scanner: typeof (window as any).BarcodeDetector !== 'undefined' && (navigator as any).mediaDevices?.getUserMedia ? 'web' : 'none',
      // TTS: SpeechSynthesis API (broad support). STT: SpeechRecognition (Chrome/webkit only).
      speech: typeof (window as any).speechSynthesis !== 'undefined' ? 'web' : 'none',
      speechRecognition:
        typeof (window as any).SpeechRecognition !== 'undefined' ||
        typeof (window as any).webkitSpeechRecognition !== 'undefined'
          ? 'web'
          : 'none',
      app: 'web', // openUrl via window.open; openSettings unsupported
      browser: 'web', // new tab/window
      billing: 'none', // no IAP in a plain browser — wire a web checkout yourself
      push: 'none', // remote push (APNs/FCM) is native-only — web push (VAPID) is the app's own concern
    };
    return {
      protocol: 1,
      platform: 'web',
      app: {
        id: location.hostname,
        name: document.title || location.hostname,
        version: '0.0.0',
      },
      capabilities: caps,
    };
  }

  async invoke<T>(method: string, params?: unknown): Promise<T> {
    const p = (params ?? {}) as Record<string, any>;
    switch (method) {
      case 'haptics.impact':
        navigator.vibrate?.(10);
        return undefined as T;
      case 'haptics.notify':
        navigator.vibrate?.(p.type === 'error' ? [40, 60, 40] : [20, 40, 20]);
        return undefined as T;

      case 'share.share':
        if (!navigator.share) throw new KitError('UNSUPPORTED', 'Web Share API unavailable');
        await navigator.share({ title: p.title, text: p.text, url: p.url }).catch((e: Error) => {
          if (e.name === 'AbortError') return; // user dismissed — not an error
          throw new KitError('NATIVE_ERROR', e.message);
        });
        return undefined as T;

      case 'share.files': {
        const files = ((p.files ?? []) as Array<{ name: string; mimeType: string; base64: string }>).map(
          (f) => new File([base64ToBuffer(f.base64)], f.name, { type: f.mimeType })
        );
        const data: ShareData = { files, title: p.title, text: p.text };
        if (!navigator.canShare?.(data)) throw new KitError('UNSUPPORTED', 'Sharing files is unavailable here');
        await navigator.share(data).catch((e: Error) => {
          if (e.name === 'AbortError') return; // user dismissed
          throw new KitError('NATIVE_ERROR', e.message);
        });
        return undefined as T;
      }

      case 'storage.get':
        return JSON.parse(localStorage.getItem(`kit:${p.key}`) ?? 'null') as T;
      case 'storage.set':
        localStorage.setItem(`kit:${p.key}`, JSON.stringify(p.value ?? null));
        return undefined as T;
      case 'storage.remove':
        localStorage.removeItem(`kit:${p.key}`);
        return undefined as T;
      case 'storage.clear':
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('kit:')) localStorage.removeItem(key);
        }
        return undefined as T;
      case 'storage.secure.get':
      case 'storage.secure.set':
      case 'storage.secure.remove':
        throw new KitError('UNSUPPORTED', 'No secure storage on web');

      case 'toast.show':
        this.showToast(String(p.message ?? ''), p.duration === 'long' ? 3500 : 2000);
        return undefined as T;
      case 'ui.statusBar.setStyle':
        return undefined as T; // no-op on web; capability reported as 'none'
      case 'ui.safeArea':
        return this.readSafeArea() as T;
      case 'ui.brightness.get':
      case 'ui.brightness.set':
        throw new KitError('UNSUPPORTED', 'No brightness control on web');
      case 'ui.keepAwake': {
        const wl = (navigator as any).wakeLock;
        if (!wl) throw new KitError('UNSUPPORTED', 'Wake Lock API unavailable');
        if (p.on) this.wakeLock = await wl.request('screen');
        else { await this.wakeLock?.release(); this.wakeLock = null; }
        return undefined as T;
      }

      case 'ui.alert':
        window.alert([p.title, p.message].filter(Boolean).join('\n\n'));
        return undefined as T;
      case 'ui.confirm':
        return window.confirm([p.title, p.message].filter(Boolean).join('\n\n')) as T;
      case 'ui.action':
        return this.showActionSheet(p.title, p.options ?? [], p.cancel ?? 'Cancel') as T;
      case 'ui.setBackgroundColor': {
        // Mirror to <meta name="theme-color"> — the browser tints its own chrome.
        let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
        if (!meta) {
          meta = document.createElement('meta');
          meta.name = 'theme-color';
          document.head.appendChild(meta);
        }
        meta.content = String(p.color ?? '');
        return undefined as T;
      }

      case 'screen.orientation.lock': {
        const so = (screen as any)?.orientation;
        if (!so?.lock) throw new KitError('UNSUPPORTED', 'Screen orientation lock unavailable');
        // Most browsers require fullscreen before locking; surface the real reason.
        await so.lock(toWebOrientation(String(p.orientation))).catch((e: Error) => {
          throw new KitError('UNSUPPORTED', e.message || 'Lock rejected (fullscreen may be required)');
        });
        return undefined as T;
      }
      case 'screen.orientation.unlock':
        (screen as any)?.orientation?.unlock?.();
        return undefined as T;
      case 'screen.orientation.current':
        return (((screen as any)?.orientation?.type ?? '').startsWith('landscape') ? 'landscape' : 'portrait') as T;

      case 'keyboard.hide':
        // No programmatic IME on web — blurring the focused field dismisses it.
        (document.activeElement as HTMLElement | null)?.blur?.();
        return undefined as T;

      case 'reviews.requestReview':
        throw new KitError('UNSUPPORTED', 'No in-app review prompt on web');

      case 'device.info': {
        const battery = await (navigator as any).getBattery?.().catch(() => null);
        return {
          model: navigator.userAgent.replace(/^Mozilla\/\d+\.\d+\s*/, '').slice(0, 64),
          os: 'web',
          osVersion: navigator.platform ?? '',
          language: navigator.language,
          battery: battery ? { level: battery.level, charging: battery.charging } : undefined,
        } as T;
      }

      case 'clipboard.copy':
        if (!navigator.clipboard) throw new KitError('UNSUPPORTED', 'Clipboard API unavailable');
        await navigator.clipboard.writeText(String(p.text ?? ''));
        return undefined as T;
      case 'clipboard.read':
        if (!navigator.clipboard?.readText) throw new KitError('UNSUPPORTED', 'Clipboard read unavailable');
        return (await navigator.clipboard.readText().catch((e: Error) => {
          throw new KitError('DENIED', e.message);
        })) as T;

      case 'notifications.requestPermission':
        if (!('Notification' in window)) throw new KitError('UNSUPPORTED', 'Notifications unavailable');
        return (await Notification.requestPermission()) as T;
      case 'notifications.schedule': {
        if (Notification.permission !== 'granted') throw new KitError('DENIED', 'Permission not granted');
        const delay = (p.delaySec ?? 1) * 1000;
        setTimeout(() => new Notification(p.title, { body: p.body }), delay);
        return { id: p.id ?? Date.now() % 100000 } as T;
      }
      case 'notifications.pending':
        return 0 as T; // web timers aren't introspectable
      case 'notifications.setBadge': {
        const setAppBadge = (navigator as any).setAppBadge?.bind(navigator);
        if (!setAppBadge) throw new KitError('UNSUPPORTED', 'Badging API unavailable');
        await setAppBadge(p.count);
        return undefined as T;
      }
      case 'notifications.clear':
        return undefined as T;

      case 'biometrics.available':
        return { available: false, type: 'none' } as T;
      case 'biometrics.authenticate':
        throw new KitError('UNSUPPORTED', 'No biometrics on web');

      case 'geo.current':
        return new Promise<T>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } as T),
            (err) => reject(new KitError(err.code === 1 ? 'DENIED' : 'NATIVE_ERROR', err.message)),
            { timeout: 10000 }
          );
        });
      case 'geo.watch.start':
        if (this.geoWatchId === null) {
          this.geoWatchId = navigator.geolocation.watchPosition(
            (pos) => this.emit('geo.position', {
              lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy,
            }),
            (err) => console.warn('[native-kit] geo.watch error', err.message)
          );
        }
        return undefined as T;
      case 'geo.watch.stop':
        if (this.geoWatchId !== null) {
          navigator.geolocation.clearWatch(this.geoWatchId);
          this.geoWatchId = null;
        }
        return undefined as T;

      case 'motion.start': {
        if (typeof DeviceMotionEvent === 'undefined') throw new KitError('UNSUPPORTED', 'No motion sensors on this browser');
        // iOS Safari gates motion behind an explicit permission prompt
        const req = (DeviceMotionEvent as any).requestPermission;
        if (req) {
          const state = await req().catch((e: Error) => { throw new KitError('DENIED', e.message); });
          if (state !== 'granted') throw new KitError('DENIED', 'Motion permission not granted');
        }
        if (!this.motionHandler) {
          let last = 0;
          this.motionHandler = (e) => {
            const now = performance.now();
            if (now - last < 100) return; // ~10Hz
            last = now;
            const a = e.accelerationIncludingGravity;
            const r = e.rotationRate;
            this.emit('motion.data', {
              ax: a?.x ?? 0, ay: a?.y ?? 0, az: a?.z ?? 0,
              rx: r?.alpha ?? undefined, ry: r?.beta ?? undefined, rz: r?.gamma ?? undefined,
            });
          };
          window.addEventListener('devicemotion', this.motionHandler);
        }
        return undefined as T;
      }
      case 'motion.stop':
        if (this.motionHandler) {
          window.removeEventListener('devicemotion', this.motionHandler);
          this.motionHandler = null;
        }
        return undefined as T;

      case 'contacts.pick': {
        const select = (navigator as any).contacts?.select;
        if (!select) throw new KitError('UNSUPPORTED', 'Contact Picker API unavailable');
        const picked = await (navigator as any).contacts
          .select(['name', 'tel', 'email'])
          .catch((e: Error) => { throw new KitError('DENIED', e.message); });
        const c = picked?.[0];
        if (!c) return { picked: false } as T;
        return { picked: true, name: c.name?.[0], phones: c.tel, emails: c.email } as T;
      }

      case 'contacts.getAll':
        throw new KitError('UNSUPPORTED', 'No bulk contacts read on web — use contacts.pick');

      case 'calendar.createEvent':
        throw new KitError('UNSUPPORTED', 'No calendar access on web');

      case 'scanner.scan':
        return this.scanBarcode(p.formats, p.camera === 'front' ? 'user' : 'environment') as Promise<T>;
      case 'scanner.cancel':
        this.scanCancel?.();
        return undefined as T;

      case 'speech.speak':
        return this.speak(String(p.text ?? ''), p) as Promise<T>;
      case 'speech.stop':
        (window as any).speechSynthesis?.cancel?.();
        return undefined as T;
      case 'speech.voices':
        return this.listVoices() as Promise<T>;
      case 'speech.listen':
        return this.listen(p) as Promise<T>;
      case 'speech.stopListening':
        this.listenStop?.();
        return undefined as T;

      case 'photos.pick':
        return this.pickImageFile(false, !!p.dataUrl, p.maxSize) as Promise<T>;
      case 'camera.capture':
        return this.pickImageFile(true, !!p.dataUrl, p.maxSize) as Promise<T>;

      case 'fs.read':
        return this.opfsRead(p.path, p.encoding === 'base64' ? 'base64' : 'utf8') as Promise<T>;
      case 'fs.write':
        return this.opfsWrite(p.path, p.data, p.encoding === 'base64' ? 'base64' : 'utf8', false, !!p.recursive) as Promise<T>;
      case 'fs.append':
        return this.opfsWrite(p.path, p.data, p.encoding === 'base64' ? 'base64' : 'utf8', true, true) as Promise<T>;
      case 'fs.delete':
        return this.opfsDelete(p.path) as Promise<T>;
      case 'fs.list':
        return this.opfsList(p.path) as Promise<T>;
      case 'fs.mkdir':
        return this.opfsMkdir(p.path) as Promise<T>;
      case 'fs.stat':
        return this.opfsStat(p.path) as Promise<T>;
      case 'fs.getUri':
        // OPFS files have no URL the page can hand around — be honest rather than fake one.
        throw new KitError('UNSUPPORTED', 'No file URI on web (OPFS is opaque) — read the bytes instead');
      case 'fs.pickFile':
        return this.pickDocuments(p.types, !!p.multiple) as Promise<T>;

      case 'media.configureAudio':
        return undefined as T; // browser owns the audio session — nothing to tune

      case 'network.status': {
        const conn = (navigator as any).connection;
        return { online: navigator.onLine, type: conn?.type ?? (navigator.onLine ? 'unknown' : 'none') } as T;
      }

      case 'app.openUrl':
      case 'browser.open': {
        const win = window.open(String(p.url ?? ''), '_blank', 'noopener');
        if (!win) throw new KitError('DENIED', 'Popup blocked');
        return undefined as T;
      }
      case 'app.openSettings':
        throw new KitError('UNSUPPORTED', 'No app settings page on web');

      case 'app.environment':
        // On web there's no install — report the honest 'web' source. is_emulator is native-only.
        return { source: 'web', isEmulator: false } as T;

      case 'push.permissionStatus': {
        // Best-effort via the Notification API (web push ≠ native push, but the perm signal is useful).
        if (!('Notification' in window)) return 'notDetermined' as T;
        const perm = Notification.permission; // 'granted' | 'denied' | 'default'
        return (perm === 'default' ? 'notDetermined' : perm) as T;
      }

      case 'billing.products':
      case 'billing.purchase':
      case 'billing.restore':
      case 'billing.entitlements':
      case 'billing.appReceipt':
      case 'billing.manageSubscriptions':
        throw new KitError('UNSUPPORTED', 'No in-app purchases on web — use a web checkout');

      case 'push.requestPermission':
      case 'push.register':
      case 'push.unregister':
      case 'push.sendTest':
        throw new KitError('UNSUPPORTED', 'No native remote push on web — use Web Push (VAPID) in your app, or run inside the appwrap shell');

      default:
        throw new KitError('UNSUPPORTED', `Unknown method: ${method}`);
    }
  }

  on(event: string, cb: (payload: unknown) => void): Unsubscribe {
    if (event === 'network.change') {
      const fire = () => cb({ online: navigator.onLine, type: navigator.onLine ? 'unknown' : 'none' });
      window.addEventListener('online', fire);
      window.addEventListener('offline', fire);
      return () => {
        window.removeEventListener('online', fire);
        window.removeEventListener('offline', fire);
      };
    }
    if (event === 'screen.orientation.change') {
      const so = (screen as any)?.orientation;
      if (!so) return () => {};
      const fire = () => cb(String(so.type ?? '').startsWith('landscape') ? 'landscape' : 'portrait');
      so.addEventListener('change', fire);
      return () => so.removeEventListener('change', fire);
    }
    if (event === 'keyboard.show' || event === 'keyboard.hide') {
      const vv = (window as any).visualViewport;
      if (!vv) return () => {};
      let shown = false;
      const onResize = () => {
        // The keyboard shrinks the visual viewport; the hidden band ≈ its height.
        const height = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        const nowShown = height > 120; // threshold filters URL-bar/toolbar resizes
        if (nowShown === shown) return;
        shown = nowShown;
        if (event === 'keyboard.show' && nowShown) cb({ height: Math.round(height) });
        if (event === 'keyboard.hide' && !nowShown) cb(undefined);
      };
      vv.addEventListener('resize', onResize);
      return () => vv.removeEventListener('resize', onResize);
    }
    if (event === 'app.pause' || event === 'app.resume') {
      const handler = () => {
        const paused = document.visibilityState === 'hidden';
        if ((event === 'app.pause') === paused) cb(undefined);
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    }
    // Adapter-emitted streams (geo.position, motion.data, …)
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }

  /** Map our small format enum → BarcodeDetector `formats` strings. Omit/`'all'` = detector default. */
  private toDetectorFormats(formats?: string | string[]): string[] | undefined {
    const want = (Array.isArray(formats) ? formats : formats ? [formats] : []).filter((f) => f && f !== 'all');
    if (!want.length) return undefined;
    const map: Record<string, string> = { qr: 'qr_code', ean13: 'ean_13', code128: 'code_128' };
    return want.map((f) => map[f] ?? f);
  }

  /** Reverse map a detector format string → our enum (best-effort). */
  private fromDetectorFormat(f: string): 'qr' | 'ean13' | 'code128' | 'unknown' {
    if (f === 'qr_code') return 'qr';
    if (f === 'ean_13') return 'ean13';
    if (f === 'code_128') return 'code128';
    return 'unknown';
  }

  /**
   * Open a full-screen camera overlay, run a BarcodeDetector loop, resolve the FIRST hit then tear
   * down. Resolves `{ cancelled: true }` if the user taps the close button or `scanner.cancel` fires.
   */
  private scanBarcode(
    formats: string | string[] | undefined,
    facingMode: 'environment' | 'user'
  ): Promise<{ value: string; format: string; bounds?: any } | { cancelled: true }> {
    const Detector = (window as any).BarcodeDetector;
    const getUserMedia = (navigator as any).mediaDevices?.getUserMedia?.bind((navigator as any).mediaDevices);
    if (!Detector || !getUserMedia) throw new KitError('UNSUPPORTED', 'BarcodeDetector / camera unavailable in this browser');

    return new Promise(async (resolve, reject) => {
      let stream: MediaStream | null = null;
      let raf = 0;
      let done = false;
      const wrap = document.createElement('div');
      const video = document.createElement('video');

      const teardown = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        stream?.getTracks().forEach((t) => t.stop());
        wrap.remove();
        // Only clear if it's still OUR handler — a newer scan may have replaced it.
        if (this.scanCancel === cancelHandler) this.scanCancel = null;
      };
      const cancelHandler = () => { teardown(); resolve({ cancelled: true }); };
      this.scanCancel = cancelHandler;

      try {
        const detector = new Detector(this.toDetectorFormats(formats) ? { formats: this.toDetectorFormats(formats) } : undefined);
        stream = await getUserMedia({ video: { facingMode } });
        wrap.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99999;display:flex;flex-direction:column';
        video.setAttribute('playsinline', '');
        video.muted = true;
        video.style.cssText = 'flex:1;width:100%;height:100%;object-fit:cover';
        (video as any).srcObject = stream;
        const close = document.createElement('button');
        close.textContent = 'Cancel';
        close.style.cssText = 'position:absolute;top:max(12px,env(safe-area-inset-top));right:16px;z-index:1;background:rgba(0,0,0,.5);color:#fff;border:0;border-radius:18px;padding:8px 16px;font:15px system-ui';
        close.onclick = () => { teardown(); resolve({ cancelled: true }); };
        wrap.appendChild(video);
        wrap.appendChild(close);
        document.body.appendChild(wrap);
        await video.play();

        const tick = async () => {
          if (done) return;
          try {
            const codes = await detector.detect(video);
            if (codes?.length) {
              const c = codes[0];
              const b = c.boundingBox;
              teardown();
              resolve({
                value: c.rawValue,
                format: this.fromDetectorFormat(c.format),
                bounds: b ? { x: b.x, y: b.y, width: b.width, height: b.height } : undefined,
              });
              return;
            }
          } catch { /* transient detect error — keep looping */ }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e: any) {
        teardown();
        reject(new KitError(e?.name === 'NotAllowedError' ? 'DENIED' : 'NATIVE_ERROR', e?.message ?? 'scan failed'));
      }
    });
  }

  // ── speech (Web Speech API) ─────────────────────────────────────────

  /** Speak via SpeechSynthesis; resolve when the utterance ends (or rejects on synth error). */
  private speak(text: string, opts: Record<string, any>): Promise<void> {
    const synth = (window as any).speechSynthesis;
    if (!synth) throw new KitError('UNSUPPORTED', 'SpeechSynthesis unavailable');
    return new Promise((resolve, reject) => {
      const u = new (window as any).SpeechSynthesisUtterance(text);
      if (opts.lang) u.lang = opts.lang;
      if (opts.rate != null) u.rate = opts.rate;
      if (opts.pitch != null) u.pitch = opts.pitch;
      if (opts.voice) {
        const v = synth.getVoices().find((vc: any) => vc.voiceURI === opts.voice || vc.name === opts.voice);
        if (v) u.voice = v;
      }
      u.onend = () => resolve();
      u.onerror = (e: any) => reject(new KitError('NATIVE_ERROR', e?.error ?? 'speech synthesis failed'));
      synth.speak(u);
    });
  }

  /** List synthesizer voices, awaiting the async `voiceschanged` event when the list is empty. */
  private listVoices(): Promise<Array<{ id: string; name: string; lang: string }>> {
    const synth = (window as any).speechSynthesis;
    if (!synth) throw new KitError('UNSUPPORTED', 'SpeechSynthesis unavailable');
    const map = (vs: any[]) => vs.map((v) => ({ id: v.voiceURI ?? v.name, name: v.name, lang: v.lang }));
    const ready = synth.getVoices();
    if (ready.length) return Promise.resolve(map(ready));
    // Chrome populates voices asynchronously — wait once for voiceschanged, with a short fallback.
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(map(synth.getVoices()));
      };
      synth.addEventListener?.('voiceschanged', done, { once: true });
      setTimeout(done, 1000);
    });
  }

  /** Capture the mic via SpeechRecognition; resolve the FINAL transcript, stream partials. */
  private listen(opts: Record<string, any>): Promise<string> {
    const Rec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Rec) throw new KitError('UNSUPPORTED', 'SpeechRecognition unavailable (Chrome only)');
    return new Promise((resolve, reject) => {
      const rec = new Rec();
      if (opts.lang) rec.lang = opts.lang;
      rec.interimResults = !!opts.partial;
      rec.continuous = false;
      let best = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.listenStop === stop) this.listenStop = null;
        resolve(best);
      };
      const stop = () => { try { rec.stop(); } catch { /* already stopped */ } };
      this.listenStop = stop;
      rec.onresult = (e: any) => {
        let interim = '';
        let finalText = '';
        for (let i = 0; i < e.results.length; i++) {
          const t = e.results[i][0]?.transcript ?? '';
          if (e.results[i].isFinal) finalText += t;
          else interim += t;
        }
        best = (finalText || interim).trim();
        if (opts.partial && interim) this.emit('speech.partial', { transcript: interim.trim() });
      };
      rec.onerror = (e: any) => {
        if (settled) return;
        settled = true;
        if (this.listenStop === stop) this.listenStop = null;
        reject(new KitError(e?.error === 'not-allowed' ? 'DENIED' : 'NATIVE_ERROR', e?.error ?? 'recognition failed'));
      };
      rec.onend = finish; // fires after stop() or natural end → resolve with best-so-far
      rec.start();
    });
  }

  private pickImageFile(
    capture: boolean,
    wantDataUrl = false,
    maxSize = 1024
  ): Promise<{ picked: boolean; width?: number; height?: number; dataUrl?: string }> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (capture) input.setAttribute('capture', 'environment');
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve({ picked: false });
        const img = new Image();
        img.onload = () => {
          const out: { picked: boolean; width: number; height: number; dataUrl?: string } = {
            picked: true,
            width: img.naturalWidth,
            height: img.naturalHeight,
          };
          if (wantDataUrl) {
            const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
            const cv = document.createElement('canvas');
            cv.width = Math.round(img.naturalWidth * scale);
            cv.height = Math.round(img.naturalHeight * scale);
            cv.getContext('2d')?.drawImage(img, 0, 0, cv.width, cv.height);
            out.dataUrl = cv.toDataURL('image/jpeg', 0.85);
          }
          URL.revokeObjectURL(img.src);
          resolve(out);
        };
        img.onerror = () => resolve({ picked: true });
        img.src = URL.createObjectURL(file);
      };
      input.oncancel = () => resolve({ picked: false });
      input.click();
    });
  }

  // ── filesystem (Origin Private File System) ─────────────────────────
  // OPFS is one private root per origin — our `dir` enum has no meaning here, so paths resolve
  // straight off the root. Slash-separated paths walk nested dirs.

  private async opfsRoot(): Promise<any> {
    const dir = (navigator as any).storage?.getDirectory;
    if (!dir) throw new KitError('UNSUPPORTED', 'No OPFS in this browser');
    return (navigator as any).storage.getDirectory();
  }

  /** Split a path into clean segments, rejecting any `..` so it can't escape the OPFS root. */
  private opfsSegments(path: string): string[] {
    const parts = String(path).split('/').filter(Boolean);
    if (parts.some((seg) => seg === '..')) throw new KitError('NATIVE_ERROR', `Path traversal rejected: ${path}`);
    return parts;
  }

  /** Walk `path` to its parent dir handle + leaf name. `create` makes intermediate dirs. */
  private async opfsResolveParent(path: string, create: boolean): Promise<{ parent: any; name: string }> {
    const parts = this.opfsSegments(path);
    const name = parts.pop();
    if (!name) throw new KitError('NATIVE_ERROR', 'Empty path');
    let dir = await this.opfsRoot();
    for (const seg of parts) dir = await dir.getDirectoryHandle(seg, { create });
    return { parent: dir, name };
  }

  private async opfsRead(path: string, encoding: 'utf8' | 'base64'): Promise<string> {
    const { parent, name } = await this.opfsResolveParent(path, false);
    const handle = await parent.getFileHandle(name).catch(() => { throw new KitError('NATIVE_ERROR', `No such file: ${path}`); });
    const file = await handle.getFile();
    if (encoding === 'base64') return bufferToBase64(await file.arrayBuffer());
    return file.text();
  }

  private async opfsWrite(path: string, data: string, encoding: 'utf8' | 'base64', append: boolean, recursive: boolean): Promise<{ uri: string }> {
    const { parent, name } = await this.opfsResolveParent(path, recursive);
    const handle = await parent.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: append });
    if (append) writable.seek?.((await handle.getFile()).size);
    const payload: BlobPart = encoding === 'base64' ? base64ToBuffer(data) : data;
    await writable.write(payload);
    await writable.close();
    return { uri: `opfs:/${path}` };
  }

  private async opfsDelete(path: string): Promise<void> {
    const { parent, name } = await this.opfsResolveParent(path, false);
    await parent.removeEntry(name, { recursive: false }).catch(() => {}); // no-throw if absent
  }

  private async opfsList(path: string): Promise<Array<{ name: string; type: 'file' | 'dir' }>> {
    let dir = await this.opfsRoot();
    for (const seg of this.opfsSegments(path)) dir = await dir.getDirectoryHandle(seg);
    const out: Array<{ name: string; type: 'file' | 'dir' }> = [];
    for await (const [name, handle] of (dir as any).entries()) {
      out.push({ name, type: handle.kind === 'directory' ? 'dir' : 'file' });
    }
    return out;
  }

  private async opfsMkdir(path: string): Promise<void> {
    let dir = await this.opfsRoot();
    for (const seg of this.opfsSegments(path)) dir = await dir.getDirectoryHandle(seg, { create: true });
  }

  private async opfsStat(path: string): Promise<{ name: string; type: 'file' | 'dir'; size?: number; mtime?: number }> {
    const { parent, name } = await this.opfsResolveParent(path, false);
    const fileHandle = await parent.getFileHandle(name).catch(() => null);
    if (fileHandle) {
      const f = await fileHandle.getFile();
      return { name, type: 'file', size: f.size, mtime: f.lastModified };
    }
    await parent.getDirectoryHandle(name).catch(() => { throw new KitError('NATIVE_ERROR', `No such path: ${path}`); });
    return { name, type: 'dir' };
  }

  /** Document picker via a hidden `<input type=file>` (works everywhere; reuses the photos pattern). */
  private pickDocuments(types?: string[], multiple = false): Promise<Array<{ name: string; mimeType: string; size: number; base64: string }>> {
    const toPicked = async (file: File) => ({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      base64: bufferToBase64(await file.arrayBuffer()),
    });
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (multiple) input.multiple = true;
      if (types?.length) input.accept = types.join(',');
      input.onchange = async () => {
        const files = Array.from(input.files ?? []);
        resolve(await Promise.all(files.map(toPicked)));
      };
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  /** Minimal action sheet — fixed bottom panel, resolves option index or null on cancel. */
  private showActionSheet(title: string | undefined, options: string[], cancel: string): Promise<number | null> {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99999;display:flex;align-items:flex-end';
      const sheet = document.createElement('div');
      sheet.style.cssText =
        'width:100%;background:#1c1c22;color:#fff;border-radius:16px 16px 0 0;' +
        'padding:12px;font:15px system-ui;display:flex;flex-direction:column;gap:6px';
      const done = (result: number | null) => { wrap.remove(); resolve(result); };
      if (title) {
        const h = document.createElement('div');
        h.textContent = title;
        h.style.cssText = 'text-align:center;opacity:.6;font-size:13px;padding:4px';
        sheet.appendChild(h);
      }
      const mkBtn = (label: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText =
          'background:#2a2a32;color:inherit;border:0;border-radius:10px;padding:12px;font:inherit;cursor:pointer';
        b.onclick = onClick;
        sheet.appendChild(b);
      };
      options.forEach((label, i) => mkBtn(label, () => done(i)));
      mkBtn(cancel, () => done(null));
      wrap.onclick = (e) => { if (e.target === wrap) done(null); };
      wrap.appendChild(sheet);
      document.body.appendChild(wrap);
    });
  }

  /** Measure env(safe-area-inset-*) via a probe element. */
  private readSafeArea() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const insets = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
    el.remove();
    return insets;
  }

  private showToast(message: string, ms: number): void {
    this.toastEl?.remove();
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText =
      'position:fixed;bottom:48px;left:50%;transform:translateX(-50%);' +
      'background:rgba(20,20,24,.92);color:#fff;padding:10px 18px;border-radius:20px;' +
      'font:14px/1.3 system-ui;z-index:99999;max-width:80vw;text-align:center;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.25)';
    document.body.appendChild(el);
    this.toastEl = el;
    setTimeout(() => {
      el.remove();
      if (this.toastEl === el) this.toastEl = null;
    }, ms);
  }
}
