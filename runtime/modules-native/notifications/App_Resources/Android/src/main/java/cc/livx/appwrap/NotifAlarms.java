package cc.livx.appwrap;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.URLConnection;
import java.util.Map;

/**
 * Local scheduled notifications that survive the app process (parity with iOS
 * UNUserNotificationCenter). JS (handlers-android.ts) hands a resolved payload to schedule();
 * it is persisted in SharedPreferences and armed on AlarmManager. This receiver — plain Java, no JS
 * runtime needed — builds and posts the notification when the alarm fires, even with the process
 * dead, and re-arms everything after a reboot (the OS drops alarms on reboot).
 */
public class NotifAlarms extends BroadcastReceiver {
    private static final String TAG = "AppWrapNotif";
    private static final String PREFS = "appwrap.notifications";
    private static final String ACTION_FIRE = "cc.livx.appwrap.NOTIF_FIRE";
    private static final String EXTRA_ID = "id";

    // ── called from JS ────────────────────────────────────────────────
    public static void schedule(Context ctx, int id, String payloadJson, long triggerAtMillis) {
        try {
            JSONObject entry = new JSONObject().put("at", triggerAtMillis).put("payload", new JSONObject(payloadJson));
            prefs(ctx).edit().putString(String.valueOf(id), entry.toString()).commit();
        } catch (Exception e) {
            Log.w(TAG, "schedule: bad payload", e);
            return;
        }
        arm(ctx, id, triggerAtMillis);
    }

    public static int pendingCount(Context ctx) {
        return prefs(ctx).getAll().size();
    }

    public static void cancelAll(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        for (String key : prefs(ctx).getAll().keySet()) {
            try { am.cancel(alarmIntent(ctx, Integer.parseInt(key))); } catch (Exception e) { Log.w(TAG, "cancel " + key, e); }
        }
        prefs(ctx).edit().clear().commit();
    }

    // ── receiver ──────────────────────────────────────────────────────
    @Override
    public void onReceive(Context context, Intent intent) {
        final Context ctx = context.getApplicationContext();
        String action = intent.getAction();
        if (ACTION_FIRE.equals(action)) {
            final int id = intent.getIntExtra(EXTRA_ID, 0);
            final String raw = prefs(ctx).getString(String.valueOf(id), null);
            if (raw == null) return; // cleared after arming
            prefs(ctx).edit().remove(String.valueOf(id)).commit();
            final PendingResult pending = goAsync(); // bitmap fetches are network reads — off the main thread
            new Thread(() -> {
                try { post(ctx, id, new JSONObject(raw).getJSONObject("payload")); }
                catch (Exception e) { Log.w(TAG, "fire " + id, e); }
                finally { pending.finish(); }
            }).start();
        } else if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            long now = System.currentTimeMillis();
            for (Map.Entry<String, ?> e : prefs(ctx).getAll().entrySet()) {
                try {
                    long at = new JSONObject(String.valueOf(e.getValue())).getLong("at");
                    arm(ctx, Integer.parseInt(e.getKey()), Math.max(at, now + 1000)); // missed while off → fire now
                } catch (Exception ex) { Log.w(TAG, "re-arm " + e.getKey(), ex); }
            }
        }
    }

    // ── internals ─────────────────────────────────────────────────────
    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static PendingIntent alarmIntent(Context ctx, int id) {
        Intent i = new Intent(ctx, NotifAlarms.class).setAction(ACTION_FIRE)
            .setData(Uri.parse("appwrap-notif://" + id)).putExtra(EXTRA_ID, id);
        return PendingIntent.getBroadcast(ctx, id, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void arm(Context ctx, int id, long at) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = alarmIntent(ctx, id);
        // Exact needs the user-granted SCHEDULE_EXACT_ALARM on 31+ (not requested: Play restricts it);
        // without it the inexact while-idle alarm still fires through Doze, a few minutes late at worst.
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    }

    private static void post(Context ctx, int id, JSONObject p) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        // `silent` (iOS nil-sound parity): sound is a CHANNEL property on Android 8+ and the platform
        // builder has no per-notification mute, so silent ones go to a sibling low-importance channel.
        boolean silent = p.optBoolean("silent");
        String channelId = p.optString("channelId", "appwrap") + (silent ? "-silent" : "");
        String channelName = p.optString("channelName", "Notifications") + (silent ? " (silent)" : "");
        // Idempotent; creates the channel if missing (silent sibling, or app data cleared since).
        nm.createNotificationChannel(new NotificationChannel(channelId, channelName,
            silent ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_DEFAULT));

        Notification.Builder b = new Notification.Builder(ctx, channelId)
            .setSmallIcon(ctx.getApplicationInfo().icon)
            .setContentTitle(p.optString("title", ""))
            .setAutoCancel(true);
        String subtitle = p.optString("subtitle", "");
        String body = p.optString("body", "");
        if (!subtitle.isEmpty()) b.setSubText(subtitle);
        if (!body.isEmpty()) b.setContentText(body);

        // Tap → VIEW intent on the singleTask activity; onNewIntent routes it like an external deep link.
        // Each target gets its own request code (a shared one + FLAG_UPDATE_CURRENT overwrites earlier ones).
        int req = id * 8;
        String deepLink = p.optString("deepLink", "");
        if (!deepLink.isEmpty()) b.setContentIntent(openIntent(ctx, deepLink, req++));
        JSONArray actions = p.optJSONArray("actions");
        if (actions != null) {
            for (int i = 0; i < actions.length(); i++) {
                JSONObject a = actions.optJSONObject(i);
                if (a == null || a.optString("deepLink", "").isEmpty()) continue;
                b.addAction(new Notification.Action.Builder(null, a.optString("title", ""), openIntent(ctx, a.optString("deepLink"), req++)).build());
            }
        }

        String iconUrl = p.optString("iconUrl", "");
        if (!iconUrl.isEmpty()) {
            Bitmap bmp = loadBitmap(iconUrl);
            if (bmp != null) b.setLargeIcon(bmp);
        }
        String image = p.optString("image", "");
        if (!image.isEmpty()) {
            Bitmap hero = loadBitmap(image);
            // BigPictureStyle is the rich card: collapsed shows the large icon, expanded the hero.
            if (hero != null) {
                Notification.BigPictureStyle style = new Notification.BigPictureStyle().bigPicture(hero);
                if (!body.isEmpty()) style.setSummaryText(body);
                b.setStyle(style);
            }
        }
        nm.notify(id, b.build());
    }

    private static PendingIntent openIntent(Context ctx, String link, int req) {
        Intent v = new Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(ctx.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(ctx, req, v, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** http(s) URL or data-URI → Bitmap; null on failure. Short timeouts: a broadcast has ~10 s total. */
    private static Bitmap loadBitmap(String src) {
        try {
            if (src.startsWith("data:")) {
                int comma = src.indexOf(',');
                if (comma < 0) return null;
                byte[] bytes = Base64.decode(src.substring(comma + 1), Base64.DEFAULT);
                return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            }
            URLConnection conn = new java.net.URL(src).openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            try (InputStream in = conn.getInputStream()) { return BitmapFactory.decodeStream(in); }
        } catch (Exception e) {
            Log.w(TAG, "bitmap load failed: " + e);
            return null;
        }
    }
}
