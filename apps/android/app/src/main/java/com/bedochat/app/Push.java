package com.bedochat.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * D-58: the app's side of notifications. The page asks for the permission and the device address (the same answer
 * shape as the iPhone app: { permission: granted | denied | default, endpoint }); the address is the Firebase token as
 * https://fcm.googleapis.com/v1/bedochat-android/<token>, which the API recognises (apps/api/src/delivery/fcm.ts).
 */
final class Push {
    static final String CHANNEL = "messages";
    private static final String ENDPOINT_PREFIX = "https://fcm.googleapis.com/v1/bedochat-android/";
    private static final String PREFS = "bedo";
    private static final String ASKED = "notifications-asked";

    interface Answer {
        void done(JSONObject status);
    }

    private Push() {
    }

    /** The notification channel (Android 8 and later): one, "Messages", that makes a sound and shows on screen. */
    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, context.getString(R.string.channelMessages), NotificationManager.IMPORTANCE_HIGH);
        channel.setShowBadge(true);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static void markAsked(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ASKED, true).apply();
    }

    /**
     * The phone's answer for Bedo Chat's notifications: "granted"; "default" while the app may still ask (Android 13
     * and later, never asked or asked once); "denied" when only the phone's Settings can turn them on.
     */
    static String permission(Activity activity) {
        boolean enabled = NotificationManagerCompat.from(activity).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT < 33) return enabled ? "granted" : "denied";
        boolean allowed = ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        if (allowed) return enabled ? "granted" : "denied";
        boolean asked = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ASKED, false);
        if (!asked || activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) return "default";
        return "denied";
    }

    /** The permission and, when allowed and Firebase is set up in this build, the device address. */
    static void status(Activity activity, Answer answer) {
        String permission = permission(activity);
        if (!"granted".equals(permission) || !BuildConfig.FIREBASE) {
            answer.done(json(permission, null));
            return;
        }
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                String token = task.isSuccessful() ? task.getResult() : null;
                answer.done(json(permission, token == null || token.isEmpty() ? null : ENDPOINT_PREFIX + token));
            });
        } catch (RuntimeException error) {
            // Firebase not available on this phone (no Google services): the app works without notifications.
            answer.done(json(permission, null));
        }
    }

    private static JSONObject json(String permission, String endpoint) {
        JSONObject status = new JSONObject();
        try {
            status.put("permission", permission);
            status.put("endpoint", endpoint == null ? JSONObject.NULL : endpoint);
        } catch (JSONException ignored) {
            // Never thrown for these values.
        }
        return status;
    }

    /** The phone's notification settings for Bedo Chat (where they are turned back on after "Don't allow"). */
    static void openSettings(Activity activity) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 26) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.getPackageName()));
        }
        try {
            activity.startActivity(intent);
        } catch (RuntimeException error) {
            activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.getPackageName())));
        }
    }
}
