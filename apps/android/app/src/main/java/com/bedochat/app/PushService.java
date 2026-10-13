package com.bedochat.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * D-58: a notification from Bedo Chat (a data message sent by the API, apps/api/src/delivery/fcm.ts), shown with the
 * sender and the text. A new message in the same chat replaces the chat's previous notification; tapping it opens
 * that chat. Arrives whether the app is open, in the background or closed.
 */
public final class PushService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String title = valueOr(data.get("title"), getString(R.string.appName));
        String body = valueOr(data.get("body"), "");
        String url = valueOr(data.get("url"), "/");
        String tag = valueOr(data.get("tag"), "bedo");
        if (!url.startsWith("/")) url = "/";

        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        Push.createChannel(this);
        Intent open = new Intent(this, MainActivity.class)
                .putExtra(MainActivity.EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, Push.CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ContextCompat.getColor(this, R.color.brand))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(tap);
        try {
            int badge = Integer.parseInt(valueOr(data.get("badge"), "0"));
            if (badge > 0) notification.setNumber(badge);
        } catch (NumberFormatException ignored) {
            // No count.
        }
        try {
            NotificationManagerCompat.from(this).notify(tag, 1, notification.build());
        } catch (SecurityException ignored) {
            // Notifications turned off meanwhile.
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // The page asks for the address on every start and saves the new one (resumePush in apps/web/app/_lib/push.ts).
    }

    private static String valueOr(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }
}
