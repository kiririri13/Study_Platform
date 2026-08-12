package com.studyplatform.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.google.firebase.messaging.FirebaseMessagingService;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class UrokroomMessagingService extends FirebaseMessagingService {
    private static final String PREFS_NAME = "urokroom";
    private static final String AUTH_TOKEN_KEY = "auth_token";
    private static final String FCM_TOKEN_KEY = "fcm_token";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(FCM_TOKEN_KEY, token).apply();
        sendFcmTokenToServer(prefs);
    }

    private void sendFcmTokenToServer(SharedPreferences prefs) {
        String authToken = prefs.getString(AUTH_TOKEN_KEY, "");
        String fcmToken = prefs.getString(FCM_TOKEN_KEY, "");
        if (authToken.isEmpty() || fcmToken.isEmpty()) return;

        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(BuildConfig.WEB_APP_URL + "/api/fcm/register");
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(10000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                connection.setRequestProperty("Authorization", "Bearer " + authToken);
                String escapedToken = fcmToken.replace("\\", "\\\\").replace("\"", "\\\"");
                byte[] body = ("{\"token\":\"" + escapedToken + "\",\"platform\":\"android\"}").getBytes(StandardCharsets.UTF_8);
                try (OutputStream stream = connection.getOutputStream()) {
                    stream.write(body);
                }
                connection.getResponseCode();
            } catch (Exception ignored) {
                // Registration will be retried later by MainActivity.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }
}
