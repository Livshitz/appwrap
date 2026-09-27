// appwrap: config `iosKeyboardWithoutUserAction: true` stamps Info.plist `AppwrapKeyboardWithoutUserAction` →
// programmatic `el.focus()` raises the keyboard (WKWebView's missing `keyboardDisplayRequiresUserAction = NO`).
// WebKit only shows the keyboard when the private WKContentView focus hook sees `userIsInteracting`; we wrap
// that hook and force it YES (the approach Cordova/Capacitor ship). Native for the same reason as
// AppwrapKeyboardAccessory.m (JS swizzles of private WebKit classes SIGABRT on device). Absent key → no-op;
// selector not found (future iOS renames it) → logged no-op, never a crash.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <dlfcn.h>

@interface AppwrapKeyboardFocus : NSObject
@end

@implementation AppwrapKeyboardFocus
+ (void)load {
  if (![[[NSBundle mainBundle] objectForInfoDictionaryKey:@"AppwrapKeyboardWithoutUserAction"] boolValue]) return;
  dlopen("/System/Library/Frameworks/WebKit.framework/WebKit", RTLD_LAZY);
  Class cls = NSClassFromString(@"WKContentView");
  // iOS 13+ signature; args after userIsInteracting are passed through untouched. Scalars are taken as
  // 64-bit words (arm64/x86_64 pass each in its own register) so no bits of `activityStateChanges` are lost.
  SEL sel = sel_getUid("_elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:");
  Method m = cls ? class_getInstanceMethod(cls, sel) : NULL;
  if (!m) { NSLog(@"[appwrap] keyboard focus: WKContentView focus hook not found — focus() needs a tap"); return; }
  typedef void (*Orig)(id, SEL, void *, BOOL, uintptr_t, uintptr_t, id);
  Orig orig = (Orig)method_getImplementation(m);
  method_setImplementation(m, imp_implementationWithBlock(^void(id me, void *info, BOOL interacting, uintptr_t blur, uintptr_t changes, id userObject) {
    orig(me, sel, info, YES, blur, changes, userObject);
  }));
}
@end
