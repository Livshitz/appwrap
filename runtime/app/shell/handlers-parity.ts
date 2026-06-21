import { Application, ApplicationSettings, Color, Dialogs, Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { uiImageToDataUrl } from './ios-image';

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const iosOnly = () => err('UNSUPPORTED', 'iOS only for now');

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
  let geoManager: any = null;
  let geoDelegate: any = null;

  bridge.register('geo.watch.start', () => {
    if (!isIOS) throw iosOnly();
    if (geoManager) return; // already streaming
    const DelegateClass = (NSObject as any).extend(
      {
        locationManagerDidUpdateLocations(_m: CLLocationManager, locations: NSArray<CLLocation>) {
          const loc = locations.lastObject;
          if (!loc) return;
          bridge.emit('geo.position', {
            lat: loc.coordinate.latitude,
            lng: loc.coordinate.longitude,
            accuracy: loc.horizontalAccuracy,
          });
        },
        locationManagerDidFailWithError(_m: CLLocationManager, error: NSError) {
          console.warn('AppWrap: geo.watch error', error.localizedDescription);
        },
        locationManagerDidChangeAuthorization(m: CLLocationManager) {
          const st = m.authorizationStatus;
          if (st === CLAuthorizationStatus.kCLAuthorizationStatusAuthorizedWhenInUse ||
              st === CLAuthorizationStatus.kCLAuthorizationStatusAuthorizedAlways) {
            m.startUpdatingLocation();
          }
        },
      },
      { protocols: [CLLocationManagerDelegate] }
    );
    Utils.dispatchToMainThread(() => {
      geoManager = CLLocationManager.new();
      geoDelegate = DelegateClass.new();
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
  let motionManager: any = null;
  let motionTimer: any = null;

  bridge.register('motion.start', () => {
    if (!isIOS) throw iosOnly();
    if (motionManager) return;
    const mm = CMMotionManager.new();
    if (!mm.deviceMotionAvailable) throw err('UNSUPPORTED', 'No motion sensors (simulator?)');
    motionManager = mm;
    mm.deviceMotionUpdateInterval = 0.1;
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
    }, 100);
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
        const DelegateClass = (NSObject as any).extend(
          {
            contactPickerDidSelectContact(_picker: any, contact: any) {
              const collect = (labeled: NSArray<any>, map: (v: any) => string) => {
                const out: string[] = [];
                for (let i = 0; i < labeled.count; i++) out.push(map(labeled.objectAtIndex(i).value));
                return out;
              };
              resolve({
                picked: true,
                name: `${contact.givenName ?? ''} ${contact.familyName ?? ''}`.trim(),
                phones: collect(contact.phoneNumbers, (v) => String(v.stringValue)),
                emails: collect(contact.emailAddresses, (v) => String(v)),
              });
            },
            contactPickerDidCancel(picker: any) {
              picker.dismissViewControllerAnimatedCompletion(true, null);
              resolve({ picked: false });
            },
          },
          { protocols: [CNContactPickerDelegate] }
        );
        const picker = CNContactPickerViewController.new();
        const delegate = DelegateClass.new();
        (picker as any)._appwrapDelegate = delegate; // retain
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
      store.requestAccessForEntityTypeCompletionHandler(CNEntityType.Contacts, (granted: boolean, error: NSError | null) => {
        if (!granted) {
          return reject(err('DENIED', error?.localizedDescription ?? 'contacts access denied'));
        }
        try {
          const collect = (labeled: NSArray<any>, map: (v: any) => string) => {
            const out: string[] = [];
            for (let i = 0; i < labeled.count; i++) out.push(map(labeled.objectAtIndex(i).value));
            return out;
          };
          const keys = NSArray.arrayWithArray([
            CNContactGivenNameKey,
            CNContactFamilyNameKey,
            CNContactPhoneNumbersKey,
            CNContactEmailAddressesKey,
          ] as any);
          const request = CNContactFetchRequest.alloc().initWithKeysToFetch(keys);
          const contacts: Array<{ name: string; phones: string[]; emails: string[] }> = [];
          store.enumerateContactsWithFetchRequestErrorUsingBlock(request, null as any, (contact: any) => {
            contacts.push({
              name: `${contact.givenName ?? ''} ${contact.familyName ?? ''}`.trim(),
              phones: collect(contact.phoneNumbers, (v) => String(v.stringValue)),
              emails: collect(contact.emailAddresses, (v) => String(v)),
            });
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
            event.startDate = startDate;
            event.endDate = startDate.dateByAddingTimeInterval((durationMin ?? 60) * 60);
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
  bridge.register('camera.capture', ({ dataUrl, maxSize }: any = {}) => {
    if (!isIOS) throw iosOnly();
    if (!UIImagePickerController.isSourceTypeAvailable(UIImagePickerControllerSourceType.Camera)) {
      throw err('UNSUPPORTED', 'No camera on this device (simulator?)');
    }
    return new Promise((resolve) => {
      Utils.dispatchToMainThread(() => {
        const DelegateClass = (NSObject as any).extend(
          {
            imagePickerControllerDidFinishPickingMediaWithInfo(picker: any, info: NSDictionary<string, any>) {
              picker.dismissViewControllerAnimatedCompletion(true, null);
              const img = info.objectForKey(UIImagePickerControllerOriginalImage) as UIImage | null;
              if (!img) return resolve({ picked: true });
              const out: any = { picked: true, width: img.size.width, height: img.size.height };
              if (dataUrl) out.dataUrl = uiImageToDataUrl(img, maxSize ?? 1024);
              resolve(out);
            },
            imagePickerControllerDidCancel(picker: any) {
              picker.dismissViewControllerAnimatedCompletion(true, null);
              resolve({ picked: false });
            },
          },
          { protocols: [UIImagePickerControllerDelegate, UINavigationControllerDelegate] }
        );
        const picker = UIImagePickerController.new();
        picker.sourceType = UIImagePickerControllerSourceType.Camera;
        const delegate = DelegateClass.new();
        (picker as any)._appwrapDelegate = delegate; // retain
        picker.delegate = delegate;
        Utils.ios.getRootViewController().presentViewControllerAnimatedCompletion(picker, true, null);
      });
    });
  });
}
