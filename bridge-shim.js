// Connects the page script (scanner.js) to the native app (Gemini + key storage).
function tsfHook() {
  if (typeof TSFNative !== "undefined" && !TSFNative.__tsfHooked) {
    TSFNative.__tsfHooked = true;
    TSFNative.onmessage = function (ev) {
      try {
        var o = JSON.parse(ev.data);
        o.source = "TSF_BRIDGE";
        window.postMessage(o, "*");
      } catch (_) {}
    };
  }
}
tsfHook();
window.addEventListener("message", function (e) {
  if (e.source !== window || !e.data || e.data.source !== "TSF_PAGE") return;
  tsfHook();
  if (typeof TSFNative === "undefined") {
    window.postMessage({ source: "TSF_BRIDGE", id: e.data.id, ok: false,
      error: "Native bridge unavailable. Update 'Android System WebView' from Play Store." }, "*");
    return;
  }
  TSFNative.postMessage(JSON.stringify(e.data));
});
