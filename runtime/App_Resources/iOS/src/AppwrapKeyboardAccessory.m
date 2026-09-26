// appwrap: config `iosHideKeyboardAccessory: true` stamps Info.plist `AppwrapHideKeyboardAccessory` → this
// drops WKWebView's ▲▼✓ keyboard input-accessory bar. The bar is the `inputAccessoryView` of the private
// WKContentView (the first responder while a web field is focused); we give THAT class a nil-returning
// override. Native on purpose: doing it from JS (NativeScript extend / objc runtime interop on a
// metadata-less private class) SIGABRTs on device. Absent/false key → no-op.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <dlfcn.h>

@interface AppwrapKeyboardAccessory : NSObject
@end

@implementation AppwrapKeyboardAccessory
+ (void)load {
  if (![[[NSBundle mainBundle] objectForInfoDictionaryKey:@"AppwrapHideKeyboardAccessory"] boolValue]) return;
  // WebKit may not be loaded yet at +load (the shell reaches it via NativeScript metadata, not a link) — load it.
  dlopen("/System/Library/Frameworks/WebKit.framework/WebKit", RTLD_LAZY);
  Class cls = NSClassFromString(@"WKContentView");
  Method m = cls ? class_getInstanceMethod(cls, @selector(inputAccessoryView)) : NULL;
  if (!m) { NSLog(@"[appwrap] keyboard accessory: WKContentView not found — bar kept"); return; }
  IMP nilImp = imp_implementationWithBlock(^id(id _self) { return nil; });
  // Add on WKContentView itself (not the inherited UIResponder method) so other responders are untouched.
  if (!class_addMethod(cls, @selector(inputAccessoryView), nilImp, method_getTypeEncoding(m))) method_setImplementation(m, nilImp);
}
@end
