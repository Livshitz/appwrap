/// <reference path="./node_modules/@nativescript/types-ios/index.d.ts" />
/// <reference path="./node_modules/@nativescript/types-android/lib/android-32.d.ts" />

// Opt-in iOS framework typings the shell's native handlers use. @nativescript/types-ios ships the FULL
// SDK but its default index references only a curated subset (for IDE/compile speed); reference the
// extras here so handlers get real types + autocomplete instead of `any`. (NativeScript-documented:
// blog.nativescript.org/where-did-my-types-go) Path arch ('objc-x86_64') is where they were generated;
// the API surface is arch-independent for type-checking.
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!Contacts.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!ContactsUI.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!HealthKit.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!EventKit.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!CoreMotion.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!StoreKit.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!LocalAuthentication.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!PhotosUI.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!_LocationEssentials.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!CoreLocation.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!AVFoundation.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!Speech.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!BackgroundTasks.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!AuthenticationServices.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!Photos.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!AppTrackingTransparency.d.ts" />
/// <reference path="./node_modules/@nativescript/types-ios/lib/ios/objc-x86_64/objc!AdSupport.d.ts" />
