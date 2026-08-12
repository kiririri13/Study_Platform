package com.studyplatform.app;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.firebase.messaging.FirebaseMessaging;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1207;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1208;
    private static final String PREFS_NAME = "urokroom";
    private static final String AUTH_TOKEN_KEY = "auth_token";
    private static final String FCM_TOKEN_KEY = "fcm_token";

    private WebView webView;
    private View offlineView;
    private ValueCallback<Uri[]> filePathCallback;
    private SharedPreferences prefs;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        offlineView = createOfflineView();
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        root.addView(offlineView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);
        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        webView.addJavascriptInterface(new AndroidBridge(), "UrokroomAndroid");
        webView.setWebViewClient(new PlatformWebViewClient());
        webView.setWebChromeClient(new PlatformChromeClient());

        createNotificationChannel();
        requestNotificationPermission();
        refreshFcmToken();
        loadPlatform();
    }

    private View createOfflineView() {
        TextView view = new TextView(this);
        view.setText("Не удалось открыть платформу.\n\nПроверь, что сайт доступен с устройства.\n\nНажми, чтобы попробовать снова.");
        view.setTextSize(18);
        view.setTextColor(0xFF172033);
        view.setBackgroundColor(0xFFF5F8FF);
        view.setGravity(android.view.Gravity.CENTER);
        view.setPadding(40, 40, 40, 40);
        view.setVisibility(View.GONE);
        view.setOnClickListener(v -> loadPlatform());
        return view;
    }

    private void loadPlatform() {
        offlineView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(BuildConfig.WEB_APP_URL);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(
            "urokroom_notifications",
            "Urokroom",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Уведомления о занятиях и домашних заданиях");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void refreshFcmToken() {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) return;
            prefs.edit().putString(FCM_TOKEN_KEY, task.getResult()).apply();
            sendFcmTokenToServer();
        });
    }

    private void sendFcmTokenToServer() {
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
                // Registration is retried after the next login or token refresh.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private class AndroidBridge {
        @JavascriptInterface
        public void syncAuthToken(String authToken) {
            if (authToken == null || authToken.trim().isEmpty()) {
                prefs.edit().remove(AUTH_TOKEN_KEY).apply();
                return;
            }
            prefs.edit().putString(AUTH_TOKEN_KEY, authToken).apply();
            sendFcmTokenToServer();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || filePathCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK) {
            if (data == null || data.getData() == null) {
                results = new Uri[0];
            } else if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else {
                results = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    private class PlatformWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("http".equals(scheme) || "https".equals(scheme)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                return true;
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                webView.setVisibility(View.GONE);
                offlineView.setVisibility(View.VISIBLE);
            }
        }
    }

    private class PlatformChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
            WebView webView,
            ValueCallback<Uri[]> callback,
            FileChooserParams params
        ) {
            if (filePathCallback != null) filePathCallback.onReceiveValue(null);
            filePathCallback = callback;

            Intent intent = params.createIntent();
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.setAction(Intent.ACTION_GET_CONTENT);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "application/pdf"});

            Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            Intent chooser = Intent.createChooser(intent, "Выберите файл");
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});

            try {
                startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
            } catch (ActivityNotFoundException err) {
                filePathCallback = null;
                return false;
            }
            return true;
        }
    }
}
