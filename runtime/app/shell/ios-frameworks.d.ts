/**
 * Ambient declarations for iOS frameworks not covered by the default
 * @nativescript/types-ios reference set (LocalAuthentication, CoreLocation,
 * PhotosUI). Marshalled at runtime by the NativeScript iOS runtime regardless.
 */
declare const LAContext: any;
declare const LAPolicy: any;
declare const LABiometryType: any;
declare const CLLocationManager: any;
declare const CLAuthorizationStatus: any;
declare const CLLocationManagerDelegate: any;
declare const kCLLocationAccuracyHundredMeters: number;
declare type CLLocation = any;
declare type CLLocationManager = any;
declare const PHPickerConfiguration: any;
declare const PHPickerViewController: any;
declare const PHPickerViewControllerDelegate: any;
declare type PHPickerResult = any;
declare type PHPickerViewController = any;
// StoreKit / CoreMotion / ContactsUI / EventKit (parity handlers)
declare const SKStoreReviewController: any;
declare const CMMotionManager: any;
declare const CMPedometer: any;
// HealthKit (health/steps module)
declare const HKHealthStore: any;
declare const HKObjectType: any;
declare const HKQuery: any;
declare const HKStatisticsQuery: any;
declare const HKStatisticsOptions: any;
declare const HKUnit: any;
declare const CNContactPickerViewController: any;
declare const CNContactPickerDelegate: any;
declare const EKEventStore: any;
declare const EKEvent: any;
declare const EKSpan: any;
declare const EKEntityType: any;
