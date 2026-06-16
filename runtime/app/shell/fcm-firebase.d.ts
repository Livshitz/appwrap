/**
 * Minimal ambient declarations for the Firebase Messaging Android classes the FCM service extends.
 * The full classes are provided at runtime by the `firebase-messaging` AAR (added by the CLI only
 * when push is wired) — the NativeScript Android runtime marshals them. Declare-merges into the
 * `com` namespace from @nativescript/types-android. Mirrors ios-frameworks.d.ts.
 */
declare namespace com.google.firebase.messaging {
  class RemoteMessage {
    getData(): any /* java.util.Map<string,string> */;
    getNotification(): { getTitle(): string; getBody(): string } | null;
  }
  class FirebaseMessagingService extends android.app.Service {
    onMessageReceived(message: RemoteMessage): void;
    onNewToken(token: string): void;
  }
}
