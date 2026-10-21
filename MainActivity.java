package com.splitfinder.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String HOME = "https://eticket.railway.gov.bd/";
    private static final String HOST = "eticket.railway.gov.bd";
    private static final String ORIGIN = "https://eticket.railway.gov.bd";
    private static final String MODEL = "gemini-2.5-flash";
    private static final int GREEN = Color.parseColor("#0A6B47");

    private WebView web;
    private ProgressBar bar;
    private String injected = "";
    private boolean docStart;
    private SharedPreferences prefs;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = getSharedPreferences("tsf", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(GREEN);
        try {
            injected = "(function(){if(window.__tsfLoaded)return;window.__tsfLoaded=true;\n"
                    + asset("bridge-shim.js") + "\n" + asset("scanner.js") + "\n})();";
        } catch (IOException e) {
            injected = "";
        }
        buildUi();
        setupWebView();
        web.loadUrl(HOME);
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private String asset(String name) throws IOException {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private Button barButton(String text, View.OnClickListener l) {
        Button btn = new Button(this);
        btn.setText(text);
        btn.setAllCaps(false);
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(14);
        btn.setMinHeight(0);
        btn.setMinimumHeight(0);
        btn.setMinWidth(0);
        btn.setMinimumWidth(0);
        btn.setPadding(dp(14), dp(8), dp(14), dp(8));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(70, 255, 255, 255));
        bg.setCornerRadius(dp(20));
        btn.setBackground(bg);
        btn.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(8);
        btn.setLayoutParams(lp);
        return btn;
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setBackgroundColor(GREEN);
        top.setPadding(dp(14), dp(8), dp(10), dp(8));

        TextView title = new TextView(this);
        title.setText("Train Split Finder");
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(title);
        top.addView(barButton("Home", v -> web.loadUrl(HOME)));
        top.addView(barButton("Reload", v -> {
            String u = web.getUrl();
            if (u == null || u.startsWith("data:")) web.loadUrl(HOME);
            else web.reload();
        }));
        root.addView(top);

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        web = new WebView(this);
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
    }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        // The native bridge and the injected script are limited to the railway site only.
        Set<String> origins = Collections.singleton(ORIGIN);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "TSFNative", origins,
                    (view, message, sourceOrigin, isMainFrame, reply) -> onBridge(message, isMainFrame, reply));
        }
        docStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (docStart && !injected.isEmpty()) {
            WebViewCompat.addDocumentStartJavaScript(web, injected, origins);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String sc = u.getScheme();
                if ("http".equals(sc) || "https".equals(sc)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                // Fallback for very old WebView versions without document-start scripts.
                if (!docStart && !injected.isEmpty() && url != null && HOST.equals(Uri.parse(url).getHost())) {
                    v.evaluateJavascript(injected, null);
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) {
                    v.loadData("<meta name='viewport' content='width=device-width'>"
                            + "<body style='font-family:sans-serif;padding:24px'>"
                            + "<h3>No connection</h3><p>Check your internet, then press Reload.</p></body>",
                            "text/html", "UTF-8");
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                bar.setProgress(p);
                bar.setVisibility(p < 100 ? View.VISIBLE : View.GONE);
            }
        });
    }

    // ---------- bridge: Gemini + key storage (replaces the Chrome extension background script) ----------
    private void onBridge(WebMessageCompat m, boolean isMainFrame, JavaScriptReplyProxy reply) {
        if (!isMainFrame || m.getData() == null) return;
        final JSONObject o;
        try {
            o = new JSONObject(m.getData());
        } catch (JSONException e) {
            return;
        }
        final String id = o.optString("id");
        switch (o.optString("kind")) {
            case "haskey":
                send(reply, id, true, "has", !prefs.getString("geminiKey", "").isEmpty());
                break;
            case "setkey": {
                String k = o.optString("key").trim();
                if (k.isEmpty()) {
                    send(reply, id, false, "error", "empty key");
                } else {
                    prefs.edit().putString("geminiKey", k).apply();
                    send(reply, id, true, null, null);
                }
                break;
            }
            case "clearkey":
                prefs.edit().remove("geminiKey").apply();
                send(reply, id, true, null, null);
                break;
            case "gemini": {
                final String prompt = o.optString("prompt");
                pool.execute(() -> {
                    try {
                        String key = prefs.getString("geminiKey", "");
                        if (key.isEmpty()) throw new Exception("No Gemini key saved. Open 'Describe your trip' and save your key.");
                        send(reply, id, true, "text", gemini(key, prompt));
                    } catch (Exception e) {
                        send(reply, id, false, "error", String.valueOf(e.getMessage()));
                    }
                });
                break;
            }
            default:
                break;
        }
    }

    private void send(JavaScriptReplyProxy proxy, String id, boolean ok, String key, Object val) {
        try {
            JSONObject r = new JSONObject().put("id", id).put("ok", ok);
            if (key != null) r.put(key, val);
            final String out = r.toString();
            runOnUiThread(() -> proxy.postMessage(out));
        } catch (JSONException ignored) {
        }
    }

    private static final String[] MODELS = {"gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"};

    private static class ModelGone extends Exception {
        ModelGone(String m) { super(m); }
    }

    // tries the remembered model first; if Google retired it (404), falls back to the next one
    private String gemini(String key, String prompt) throws Exception {
        java.util.List<String> order = new java.util.ArrayList<>();
        order.add(prefs.getString("geminiModel", MODELS[0]));
        for (String m : MODELS) if (!order.contains(m)) order.add(m);
        Exception last = null;
        for (String m : order) {
            try {
                String out = geminiOnce(key, prompt, m);
                prefs.edit().putString("geminiModel", m).apply();
                return out;
            } catch (ModelGone e) {
                last = e;
            }
        }
        throw last != null ? last : new Exception("Gemini failed");
    }

    private String geminiOnce(String key, String prompt, String model) throws Exception {
        URL url = new URL("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent");
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("x-goog-api-key", key);
            JSONObject body = new JSONObject()
                    .put("contents", new JSONArray().put(new JSONObject()
                            .put("parts", new JSONArray().put(new JSONObject().put("text", prompt)))))
                    .put("generationConfig", new JSONObject()
                            .put("responseMimeType", "application/json").put("temperature", 0));
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            InputStream is = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (is != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            }
            JSONObject j = new JSONObject(out.toString("UTF-8"));
            if (code >= 400) {
                JSONObject err = j.optJSONObject("error");
                String msg = err != null ? err.optString("message", "HTTP " + code) : "HTTP " + code;
                if (code == 404) throw new ModelGone(msg);
                throw new Exception(msg);
            }
            JSONArray cands = j.optJSONArray("candidates");
            StringBuilder sb = new StringBuilder();
            if (cands != null && cands.length() > 0) {
                JSONObject content = cands.getJSONObject(0).optJSONObject("content");
                JSONArray parts = content == null ? null : content.optJSONArray("parts");
                if (parts != null)
                    for (int i = 0; i < parts.length(); i++) sb.append(parts.getJSONObject(i).optString("text", ""));
            }
            return sb.toString();
        } finally {
            c.disconnect();
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        // keep the railway login after the app is closed
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
