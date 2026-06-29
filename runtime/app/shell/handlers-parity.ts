import { Application, ApplicationSettings, Color, Dialogs, Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { uiImageToDataUrl } from './ios-image';

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const iosOnly = () => err('UNSUPPORTED', 'iOS only for now');

/** Read a CNContact into the kit-contract shape (name + phone/email string arrays). */
function readContact(contact: CNContact): { name: string; phones: string[]; emails: string[] } {
  // CNLabeledValue<T>.value is typed `any` in the SDK, so the per-value map stays loosely typed.
  const collect = (labeled: NSArray<CNLabeledValue<any>>, map: (v: any) => string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < labeled.count; i++) out.push(map(labeled.objectAtIndex(i).value));
    return out;
  };
  return {
    name: `${contact.givenName ?? ''} ${contact.familyName ?? ''}`.trim(),
    phones: collect(contact.phoneNumbers, (v) => String(v.stringValue)),
    emails: collect(contact.emailAddresses, (v) => String(v)),
  };
}

// CLLocationManager delegate for the persistent geo.watch stream. Callbacks are wired via instance
// fields so the closure-captured behavior of the old (NSObject).extend(...) is preserved.
@NativeClass()
class GeoWatchDelegate extends NSObject implements CLLocationManagerDelegate {
  static ObjCProtocols = [CLLocationManagerDelegate];
  static new(): GeoWatchDelegate {
    return <GeoWatchDelegate>super.new();
  }
  locationManagerDidUpdateLocations(_m: CLLocationManager, locations: NSArray<CLLocation>): void {
    const loc = locations.lastObject;
    if (!loc) return;
    bridge.emit('geo.position', {
      lat: loc.coordinate.latitude,
      lng: loc.coordinate.longitude,
      accuracy: loc.horizontalAccuracy,
    });
  }
  locationManagerDidFailWithError(_m: CLLocationManager, error: NSError): void {
    console.warn('AppWrap: geo.watch error', error.localizedDescription);
  }
  locationManagerDidChangeAuthorization(m: CLLocationManager): void {
    const st = m.authorizationStatus;
    if (st === CLAuthorizationStatus.kCLAuthorizationStatusAuthorizedWhenInUse ||
        st === CLAuthorizationStatus.kCLAuthorizationStatusAuthorizedAlways) {
      m.startUpdatingLocation();
    }
  }
}

// CNContactPickerViewController delegate. The picker resolution callbacks are set as instance fields
// after construction (replacing the old closure-captured `resolve`).
@NativeClass()
class ContactPickerDelegate extends NSObject implements CNContactPickerDelegate {
  static ObjCProtocols = [CNContactPickerDelegate];
  static new(): ContactPickerDelegate {
    return <ContactPickerDelegate>super.new();
  }
  onSelect?: (contact: CNContact) => void;
  onCancel?: (picker: CNContactPickerViewController) => void;
  contactPickerDidSelectContact(_picker: CNContactPickerViewController, contact: CNContact): void {
    this.onSelect?.(contact);
  }
  contactPickerDidCancel(picker: CNContactPickerViewController): void {
    this.onCancel?.(picker);
  }
}

// UIImagePickerController delegate (camera.capture). Result/options are set as instance fields after
// construction, replacing the old closure-captured `resolve`/`dataUrl`/`maxSize`.
@NativeClass()
class CameraCaptureDelegate extends NSObject implements UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  static ObjCProtocols = [UIImagePickerControllerDelegate, UINavigationControllerDelegate];
  static new(): CameraCaptureDelegate {
    return <CameraCaptureDelegate>super.new();
  }
  wantDataUrl = false;
  maxSize = 1024;
  onResult?: (out: { picked: boolean; width?: number; height?: number; dataUrl?: string }) => void;
  imagePickerControllerDidFinishPickingMediaWithInfo(picker: UIImagePickerController, info: NSDictionary<string, any>): void {
    picker.dismissViewControllerAnimatedCompletion(true, null);
    const img = info.objectForKey(UIImagePickerControllerOriginalImage) as UIImage | null;
    if (!img) return this.onResult?.({ picked: true });
    const out: { picked: boolean; width?: number; height?: number; dataUrl?: string } =
      { picked: true, width: img.size.width, height: img.size.height };
    if (this.wantDataUrl) out.dataUrl = uiImageToDataUrl(img, this.maxSize);
    this.onResult?.(out);
  }
  imagePickerControllerDidCancel(picker: UIImagePickerController): void {
    picker.dismissViewControllerAnimatedCompletion(true, null);
    this.onResult?.({ picked: false });
  }
}

/**
 * Extended-parity handlers: dialogs, storage.clear, geo watch, theme color,
 * motion, contacts, calendar, camera. iOS-first like handlers-extended.
 */
export function registerParityHandlers(): void {
  // ── dialogs (NS Dialogs — cross-platform) ──────────────────────────
  bridge.register('ui.alert', ({ title, message, ok }: any) =>
    Dialogs.alert({ title, message: String(message ?? ''), okButtonText: ok ?? 'OK' }).then(() => undefined)
  );

  bridge.register('ui.confirm', ({ title, message, ok, cancel }: any) =>
    Dialogs.confirm({
      title,
      message: String(message ?? ''),
      okButtonText: ok ?? 'OK',
      cancelButtonText: cancel ?? 'Cancel',
    }).then((r) => !!r)
  );

  bridge.register('ui.action', async ({ title, options, cancel }: any) => {
    const cancelText = cancel ?? 'Cancel';
    const picked = await Dialogs.action({ title, actions: options ?? [], cancelButtonText: cancelText });
    const idx = (options ?? []).indexOf(picked);
    return idx >= 0 ? idx : null;
  });

  // reviews → moved to the strippable `reviews` module (handlers-reviews.ts): its Android Play
  // In-App Review path carries a gradle dep that must not bundle into builds without `reviews`.

  // ── storage.clear ──────────────────────────────────────────────────
  bridge.register('storage.clear', () => {
    for (const key of ApplicationSettings.getAllKeys()) {
      if (key.startsWith('kit:')) ApplicationSettings.remove(key);
    }
  });

  // ── theme color → native chrome behind the page ────────────────────
  bridge.register('ui.setBackgroundColor', ({ color }: { color: string }) => {
    Utils.dispatchToMainThread(() => {
      const root = Application.getRootView();
      if (root) root.backgroundColor = new Color(String(color));
    });
  });

  // ── geo.watch (persistent CLLocationManager) ───────────────────────
  let geoManager: CLLocationManager | null = null;
  let geoDelegate: GeoWatchDelegate | null = null;

  bridge.register('geo.watch.start', () => {
    if (!isIOS) throw iosOnly();
    if (geoManager) return; // already streaming
    Utils.dispatchToMainThread(() => {
      geoManager = CLLocationManager.new();
      geoDelegate = GeoWatchDelegate.new();
      geoManager.delegate = geoDelegate;
      geoManager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
      const st = geoManager.authorizationStatus;
      if (st === CLAuthorizationStatus.kCLAuthorizationStatusNotDetermined) {
        geoManager.requestWhenInUseAuthorization();
      } else {
        geoManager.startUpdatingLocation();
      }
    });
  });

  bridge.register('geo.watch.stop', () => {
    geoManager?.stopUpdatingLocation();
    geoManager = null;
    geoDelegate = null;
  });

  // ── motion (CMMotionManager) ───────────────────────────────────────
  // Poll the latest sample on a JS timer rather than CoreMotion's queue-handler
  // block: the repeated JS↔Obj-C block is fragile under NativeScript (the handler
  // can silently stop firing on-device). startDeviceMotionUpdates() + reading
  // `mm.deviceMotion` is a plain property read on the main thread — reliable.
  let motionManager: CMMotionManager | null = null;
  let motionTimer: ReturnType<typeof setInterval> | null = null;

  bridge.register('motion.start', (p: { hz?: number } = {}) => {
    if (!isIOS) throw iosOnly();
    if (motionManager) return;
    // Emit rate is configurable (default 10 Hz; games can ask up to 60 for crisp tilt). Both the JS
    // poll cadence AND the CoreMotion sample interval are set — the poll is the actual emit rate, so
    // bumping deviceMotionUpdateInterval alone wouldn't help. Higher Hz = more bridge traffic/battery.
    const hz = Math.max(5, Math.min(60, p.hz || 10));
    const ms = 1000 / hz;
    const mm = CMMotionManager.new();
    if (!mm.deviceMotionAvailable) throw err('UNSUPPORTED', 'No motion sensors (simulator?)');
    motionManager = mm;
    mm.deviceMotionUpdateInterval = ms / 1000;
    mm.startDeviceMotionUpdates();
    const G = 9.81; // CoreMotion reports in g — kit contract is m/s²
    motionTimer = setInterval(() => {
      const m = mm.deviceMotion;
      if (!m) return; // first sample not ready yet
      bridge.emit('motion.data', {
        ax: (m.userAcceleration.x + m.gravity.x) * G,
        ay: (m.userAcceleration.y + m.gravity.y) * G,
        az: (m.userAcceleration.z + m.gravity.z) * G,
        rx: m.rotationRate.x,
        ry: m.rotationRate.y,
        rz: m.rotationRate.z,
      });
    }, ms);
  });

  bridge.register('motion.stop', () => {
    if (motionTimer) clearInterval(motionTimer);
    motionTimer = null;
    motionManager?.stopDeviceMotionUpdates();
    motionManager = null;
  });

  // ── contacts (CNContactPickerViewController — no permission needed) ──
  bridge.register('contacts.pick', () => {
    if (!isIOS) throw iosOnly();
    return new Promise((resolve) => {
      Utils.dispatchToMainThread(() => {
        const delegate = ContactPickerDelegate.new();
        delegate.onSelect = (contact) => {
          resolve({ picked: true, ...readContact(contact) });
        };
        delegate.onCancel = (picker) => {
          picker.dismissViewControllerAnimatedCompletion(true, null);
          resolve({ picked: false });
        };
        const picker = CNContactPickerViewController.new();
        (picker as any)._appwrapDelegate = delegate; // retain delegate against ARC; not a typed property
        picker.delegate = delegate;
        Utils.ios.getRootViewController().presentViewControllerAnimatedCompletion(picker, true, null);
      });
    });
  });

  // ── contacts bulk read (CNContactStore — requires permission) ──────
  bridge.register('contacts.getAll', () => {
    if (!isIOS) throw iosOnly();
    const store = CNContactStore.new();
    return new Promise((resolve, reject) => {
      store.requestAccessForEntityTypeCompletionHandler(CNEntityType.Contacts, (granted: boolean, error: NSError) => {
        if (!granted) {
          return reject(err('DENIED', error?.localizedDescription ?? 'contacts access denied'));
        }
        try {
          // Key string constants conform to CNKeyDescriptor (NSString) at runtime; type the array as such.
          const keys = NSArray.arrayWithArray<CNKeyDescriptor>([
            CNContactGivenNameKey,
            CNContactFamilyNameKey,
            CNContactPhoneNumbersKey,
            CNContactEmailAddressesKey,
          ]);
          const request = CNContactFetchRequest.alloc().initWithKeysToFetch(keys);
          const contacts: Array<{ name: string; phones: string[]; emails: string[] }> = [];
          // null error out-param (ObjC nil) — SDK types it as a non-nullable interop reference.
          store.enumerateContactsWithFetchRequestErrorUsingBlock(request, null as any, (contact: CNContact) => {
            contacts.push(readContact(contact));
          });
          resolve({ contacts });
        } catch (e: any) {
          reject(err('NATIVE_ERROR', e.message));
        }
      });
    });
  });

  // ── calendar (EventKit) ────────────────────────────────────────────
  bridge.register('calendar.createEvent', ({ title, start, durationMin, notes }: any) => {
    if (!isIOS) throw iosOnly();
    const store = EKEventStore.new();
    return new Promise((resolve, reject) => {
      const onAccess = (granted: boolean, error: NSError | null) => {
        if (!granted) {
          return reject(err('DENIED', error?.localizedDescription ?? 'calendar access denied'));
        }
        Utils.dispatchToMainThread(() => {
          try {
            const event = EKEvent.eventWithEventStore(store);
            event.title = String(title ?? 'Event');
            const startDate = start
              ? NSDate.dateWithTimeIntervalSince1970(Date.parse(start) / 1000)
              : NSDate.dateWithTimeIntervalSinceNow(3600);
            // EKEvent.start/endDate are typed `Date`; NS marshals the NSDate we build here.
            event.startDate = startDate as unknown as Date;
            event.endDate = startDate.dateByAddingTimeInterval((durationMin ?? 60) * 60) as unknown as Date;
            if (notes) event.notes = String(notes);
            event.calendar = store.defaultCalendarForNewEvents;
            store.saveEventSpanError(event, EKSpan.ThisEvent, null as any);
            resolve({ id: String(event.eventIdentifier) });
          } catch (e: any) {
            reject(err('NATIVE_ERROR', e.message));
          }
        });
      };
      // iOS 17 renamed the request API; fall back for older versions
      if (store.requestFullAccessToEventsWithCompletion) {
        store.requestFullAccessToEventsWithCompletion(onAccess);
      } else {
        store.requestAccessToEntityTypeCompletion(EKEntityType.Event, onAccess);
      }
    });
  });

  // ── camera capture (UIImagePickerController) ───────────────────────
  bridge.register('camera.capture', ({ dataUrl, maxSize }: { dataUrl?: boolean; maxSize?: number } = {}) => {
    if (!isIOS) throw iosOnly();
    if (!UIImagePickerController.isSourceTypeAvailable(UIImagePickerControllerSourceType.Camera)) {
      throw err('UNSUPPORTED', 'No camera on this device (simulator?)');
    }
    return new Promise((resolve) => {
      Utils.dispatchToMainThread(() => {
        const picker = UIImagePickerController.new();
        picker.sourceType = UIImagePickerControllerSourceType.Camera;
        const delegate = CameraCaptureDelegate.new();
        delegate.wantDataUrl = !!dataUrl;
        delegate.maxSize = maxSize ?? 1024;
        delegate.onResult = resolve;
        (picker as any)._appwrapDelegate = delegate; // interop: retain delegate past the present call (no typed slot)
        picker.delegate = delegate;
        Utils.ios.getRootViewController().presentViewControllerAnimatedCompletion(picker, true, null);
      });
    });
  });
}
