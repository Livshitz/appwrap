import { Capability, Handshake, KitError, NativeKitAdapter, Unsubscribe } from './types';

/** Decode raw base64 → an ArrayBuffer for File construction (no `data:` prefix expected). */
function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
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
      toast: 'web',
      statusBar: 'none',
      device: 'web',
      clipboard: navigator.clipboard ? 'web' : 'none',
      notifications: 'Notification' in window ? 'web' : 'none',
      biometrics: 'none',
      geo: 'geolocation' in navigator ? 'web' : 'none',
      photos: 'web',
      network: 'web',
      screen: 'wakeLock' in n ? 'web' : 'none',
      dialogs: 'web',
      reviews: 'none',
      themeColor: 'web', // the browser honors <meta name="theme-color"> itself
      motion: typeof DeviceMotionEvent !== 'undefined' ? 'web' : 'none',
      contacts: n.contacts?.select ? 'web' : 'none',
      calendar: 'none',
      camera: 'web', // <input capture> — mobile browsers open the camera
      media: (navigator as any).mediaDevices?.getUserMedia ? 'web' : 'none',
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

      case 'calendar.createEvent':
        throw new KitError('UNSUPPORTED', 'No calendar access on web');

      case 'photos.pick':
        return this.pickImageFile(false, !!p.dataUrl, p.maxSize) as Promise<T>;
      case 'camera.capture':
        return this.pickImageFile(true, !!p.dataUrl, p.maxSize) as Promise<T>;

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
