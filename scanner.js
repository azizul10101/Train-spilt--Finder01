(function () {
  "use strict";
  const API = "https://railspaapi.shohoz.com/v1.0/web/bookings";
  // adaptive request spacing: speeds up when the site is happy, backs off on 429/errors
  const DELAY_MIN = 800, DELAY_MAX = 6000;
  let curDelay = 1000;
  const bump = () => { curDelay = Math.min(DELAY_MAX, Math.round(curDelay * 1.6)); };
  const ease = () => { curDelay = Math.max(DELAY_MIN, Math.round(curDelay * 0.92)); };

  // ---------- debug log (no secrets are ever logged) ----------
  const LOG = [];
  let onLog = null, onAuth = null;
  const shortUrl = (u) => String(u).replace(/^https?:\/\/[^/]+/, "");
  function log(level, msg) {
    LOG.push(new Date().toTimeString().slice(0, 8) + " " + level + " " + msg);
    if (LOG.length > 300) LOG.shift();
    try { if (onLog) onLog(); } catch (e) {}
  }

  const CLASSES = ["S_CHAIR", "SHOVAN", "SNIGDHA", "F_SEAT", "F_BERTH", "F_CHAIR", "AC_S", "AC_B", "AC_CHAIR", "SHULOV"];
  const SEED = ["Chilahati", "Saidpur", "Birampur", "Natore", "Rajshahi", "Hili", "Madhnagar", "Abdulpur", "Khulna", "Dhaka"];
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------- remember the headers the website itself uses ----------
  const auth = {};
  const KEEP = ["authorization", "x-device-id", "x-device-key"];
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      const key = String(k).toLowerCase();
      if (KEEP.includes(key) && !this._tsfOwn) { auth[key] = v; if (onAuth) onAuth(); }
    } catch (e) {}
    return origSet.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const idxOf = (arr, name) => arr.findIndex((x) => x.toLowerCase() === String(name).toLowerCase());

  // ---------- requests ----------
  function xhrGet(url) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x._tsfOwn = true;
      x.open("GET", url);
      x.setRequestHeader("Accept", "application/json");
      x.setRequestHeader("Content-Type", "application/json");
      x.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      if (auth.authorization) x.setRequestHeader("Authorization", auth.authorization);
      if (auth["x-device-id"]) x.setRequestHeader("X-Device-Id", auth["x-device-id"]);
      if (auth["x-device-key"]) x.setRequestHeader("X-Device-Key", auth["x-device-key"]);
      x.onload = () => resolve({ status: x.status, text: x.responseText });
      x.onerror = () => reject(new Error("Network error"));
      x.send();
    });
  }

  async function getJSON(url, tries = 3) {
    let lastErr = new Error("Failed");
    for (let t = 1; t <= tries; t++) {
      const t0 = Date.now();
      try {
        const r = await xhrGet(url);
        log(r.status === 200 ? "OK " : "ERR", r.status + " " + (Date.now() - t0) + "ms " + shortUrl(url));
        if (r.status === 200) { ease(); return JSON.parse(r.text); }
        if (r.status === 401 || r.status === 403) throw Object.assign(new Error("AUTH"), { fatal: true });
        if (r.status >= 400 && r.status < 500 && r.status !== 429)
          throw Object.assign(new Error("HTTP " + r.status), { fatal: true });
        if (r.status === 429) bump();
        lastErr = new Error("HTTP " + r.status);
      } catch (e) {
        if (e.fatal) throw e;
        log("ERR", e.message + " (try " + t + "/" + tries + ") " + shortUrl(url));
        bump();
        lastErr = e;
      }
      await sleep(3000 * t);
    }
    throw lastErr;
  }

  async function fetchTrains(from, to, date, cls) {
    const url =
      `${API}/search-trips-v2?from_city=${encodeURIComponent(from)}` +
      `&to_city=${encodeURIComponent(to)}` +
      `&date_of_journey=${encodeURIComponent(date)}` +
      `&seat_class=${encodeURIComponent(cls)}`;
    const json = await getJSON(url);
    return (json && json.data && json.data.trains) || [];
  }

  // ---------- Gemini (through the extension background) ----------
  function askGemini(prompt) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener("message", h);
        reject(new Error("Gemini timed out"));
      }, 30000);
      function h(e) {
        if (e.source !== window || !e.data || e.data.source !== "TSF_BRIDGE" || e.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", h);
        e.data.ok ? resolve(e.data.text) : reject(new Error(e.data.error || "Gemini error"));
      }
      window.addEventListener("message", h);
      window.postMessage({ source: "TSF_PAGE", id, kind: "gemini", prompt }, "*");
    });
  }
  function parseJsonLoose(t) {
    t = String(t).replace(/```json|```/g, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    return JSON.parse(t.slice(a, b + 1));
  }

  function callBridge(kind, extra) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { window.removeEventListener("message", h); reject(new Error("timeout")); }, 8000);
      function h(e) {
        if (e.source !== window || !e.data || e.data.source !== "TSF_BRIDGE" || e.data.id !== id) return;
        clearTimeout(timer); window.removeEventListener("message", h);
        e.data.ok === false ? reject(new Error(e.data.error || "error")) : resolve(e.data);
      }
      window.addEventListener("message", h);
      window.postMessage({ source: "TSF_PAGE", id, kind, ...(extra || {}) }, "*");
    });
  }

  // ---------- smart cleanup helpers (no AI) ----------
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  function loadKnown() {
    let extra = [];
    try { extra = JSON.parse(localStorage.getItem("tsf_known") || "[]"); } catch (e) {}
    return [...new Set([...SEED, ...extra])];
  }
  function saveKnown(names) {
    try { localStorage.setItem("tsf_known", JSON.stringify([...new Set([...loadKnown(), ...names])])); } catch (e) {}
  }
  function fixStation(raw) {
    const t = String(raw || "").replace(/\b(railway station|station|junction|jn)\b\.?/gi, "").replace(/\s+/g, " ").trim();
    if (!t) return { name: "", note: "" };
    const known = loadKnown(), low = t.toLowerCase();
    const exact = known.find((k) => k.toLowerCase() === low);
    if (exact) return { name: exact, note: exact === t ? "" : `${t} → ${exact}` };
    const lim = low.length > 6 ? 2 : 1;
    const near = known.map((k) => ({ k, d: lev(k.toLowerCase(), low) })).filter((x) => x.d <= lim).sort((a, b) => a.d - b.d);
    if (near.length && (near.length === 1 || near[0].d < near[1].d)) return { name: near[0].k, note: `${t} → ${near[0].k}` };
    return { name: titleCase(t), note: "" };
  }

  function fmtDate(d) {
    return String(d.getDate()).padStart(2, "0") + "-" + MON[d.getMonth()] + "-" + d.getFullYear();
  }
  function parseDate(raw) {
    const s = String(raw || "").trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
    if (!s) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (s === "today") return fmtDate(today);
    if (s === "tomorrow") { today.setDate(today.getDate() + 1); return fmtDate(today); }
    const build = (y, mo, d, noYear) => {
      if (mo > 11 && d <= 12) { const t = mo + 1; mo = d - 1; d = t; }
      let dt = new Date(y, mo, d);
      if (dt.getMonth() !== mo || dt.getDate() !== d) return null;
      if (noYear && dt < today) dt = new Date(y + 1, mo, d);
      return fmtDate(dt);
    };
    const mIdx = (w) => MONTHS.findIndex((x) => w.startsWith(x));
    const yr = (y) => (y < 100 ? 2000 + y : y);
    const now = today.getFullYear();
    let m;
    if ((m = s.match(/^(\d{4})[-\/. ](\d{1,2})[-\/. ](\d{1,2})$/))) return build(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/. ](\d{1,2})[-\/. ](\d{2,4})$/))) return build(yr(+m[3]), +m[2] - 1, +m[1]);
    if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[-\/. ]*([a-z]{3,9})(?:[-\/. ]*(\d{2,4}))?$/))) {
      const mi = mIdx(m[2]); if (mi < 0) return null;
      return build(m[3] ? yr(+m[3]) : now, mi, +m[1], !m[3]);
    }
    if ((m = s.match(/^([a-z]{3,9})[-\/. ]*(\d{1,2})(?:st|nd|rd|th)?(?:[-\/. ]*(\d{2,4}))?$/))) {
      const mi = mIdx(m[1]); if (mi < 0) return null;
      return build(m[3] ? yr(+m[3]) : now, mi, +m[2], !m[3]);
    }
    if ((m = s.match(/^(\d{1,2})$/))) {
      let dt = new Date(now, today.getMonth(), +m[1]);
      if (dt < today) dt = new Date(now, today.getMonth() + 1, +m[1]);
      return fmtDate(dt);
    }
    return null;
  }

  function parseClass(raw, fallback) {
    const s = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
    if (!s) return fallback;
    const exact = CLASSES.find((c) => c.toLowerCase().replace(/_/g, "") === s);
    if (exact) return exact;
    if (s.startsWith("snig")) return "SNIGDHA";
    if (/^ac(b|berth)/.test(s)) return "AC_B";
    if (/^ac(chair)/.test(s)) return "AC_CHAIR";
    if (/^ac/.test(s)) return "AC_S";
    if (/^(f|first)(b|berth)/.test(s)) return "F_BERTH";
    if (/^(f|first)(c|chair)/.test(s)) return "F_CHAIR";
    if (/^(f|first)/.test(s)) return "F_SEAT";
    if (/^shul/.test(s)) return "SHULOV";
    if (/^(s|sc|sch|chair)$|chair/.test(s)) return "S_CHAIR";
    if (/^(sho|sha|sob)/.test(s)) return "SHOVAN";
    return fallback;
  }

  function trainKeyOf(raw) {
    const s = String(raw || "").trim().toLowerCase();
    const m = s.match(/\d{3,4}/);
    const name = s.replace(/[^a-z ]/g, " ").replace(/\b(tr|train|no|number|express|exp|intercity)\b/g, "").replace(/\s+/g, " ").trim();
    return { num: m ? m[0] : "", name };
  }
  function findTrain(trains, key) {
    if (!key.num && !key.name) return trains.length === 1 ? trains[0] : null;
    if (key.num) {
      const t = trains.find((x) => ((String(x.trip_number).match(/\((\d+)\)/) || [])[1]) === key.num);
      if (t) return t;
    }
    if (key.name.length >= 3) {
      let t = trains.find((x) => String(x.trip_number).toLowerCase().includes(key.name));
      if (t) return t;
      t = trains.find((x) => lev(String(x.trip_number).toLowerCase().split(" ")[0], key.name.split(" ")[0]) <= 2);
      if (t) return t;
    }
    return null;
  }
  const describe = (trains) =>
    trains.map((t) => `${t.trip_number} [${(t.seat_types || []).map((s) => s.type).join("/")}]`).join("; ") || "none";

  function analyse(trains, ctx) {
    const train = findTrain(trains, ctx.key);
    if (!train) return null;
    const st = (train.seat_types || []).find((s) => s.type === ctx.cls);
    if (!st) return null;
    return {
      online: Number(st.seat_counts.online) || 0,
      offline: Number(st.seat_counts.offline) || 0,
      fare: st.fare,
      oseq: st.origin_city_seq,
      dseq: st.destination_city_seq,
    };
  }
  async function checkPair(ctx, from, to) {
    const k = from + "|" + to;
    if (ctx.cache.has(k)) return ctx.cache.get(k);
    const res = analyse(await fetchTrains(from, to, ctx.date, ctx.cls), ctx);
    ctx.cache.set(k, res);
    return res;
  }

  // ---------- route finder ----------
  // fi = index of your From, ti = index of your To (in the full train station list).
  // Tickets may start before From or end after To. Optional no-ticket stretches inside your trip.
  function findRoutes(stations, counts, fi, ti, maxGap) {
    const last = stations.length - 1;
    const out = [];
    let budget = 500000;

    function dfs(p, segs, gaps) {
      if (budget-- <= 0 || out.length >= 20000) return;
      if (p >= ti) {
        if (segs.some((s) => s.type === "t")) out.push({ segs: segs.map((s) => ({ ...s })), gaps });
        return;
      }
      const first = segs.length === 0;
      for (let q = last; q > p; q--) {
        const lo = first ? 0 : p, hi = p;
        for (let s = lo; s <= hi; s++) {
          const c = counts[s + "," + q];
          if (c && c.online >= 1) {
            segs.push({ type: "t", a: s, b: q, c });
            dfs(q, segs, gaps);
            segs.pop();
          }
        }
      }
      if (gaps < maxGap) {
        const prev = segs[segs.length - 1];
        if (prev && prev.type === "g") {
          const oldB = prev.b;
          prev.b = p + 1;
          dfs(p + 1, segs, gaps + 1);
          prev.b = oldB;
        } else {
          segs.push({ type: "g", a: p, b: p + 1 });
          dfs(p + 1, segs, gaps + 1);
          segs.pop();
        }
      }
    }
    dfs(fi, [], 0);

    out.forEach((r) => {
      const t = r.segs.filter((s) => s.type === "t");
      r.tickets = t.length;
      r.min = Math.min(...t.map((s) => s.c.online));
      r.fare = t.reduce((sum, s) => sum + (Number(s.c.fare) || 0), 0);
      r.extra = t.reduce((sum, s) => sum + Math.max(0, fi - s.a) + Math.max(0, s.b - ti), 0);
    });
    out.sort((a, b) => a.gaps - b.gaps || a.tickets - b.tickets || a.extra - b.extra || b.min - a.min || a.fare - b.fare);
    return out;
  }

  // ---------- the on-page panel ----------
  function initUI() {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;font-family:Arial,sans-serif;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
    <style>
      *{box-sizing:border-box}
      button{cursor:pointer;font-size:15px;padding:10px 14px;border-radius:8px;border:1px solid #bbb;background:#f4f4f4;color:#222}
      button.primary{background:#0a6;color:#fff;border-color:#0a6;font-weight:bold}
      #toggle{background:#0a6;color:#fff;border:0;border-radius:24px;padding:12px 16px;box-shadow:0 2px 8px rgba(0,0,0,.35)}
      #panel{width:760px;max-width:94vw;max-height:80vh;overflow:auto;background:#fff;color:#222;border:1px solid #bbb;border-radius:10px;padding:12px;margin-bottom:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);font-size:14px;-webkit-text-size-adjust:100%}
      @media (max-width:700px){
        #panel{position:fixed;left:0;right:0;top:0;bottom:0;width:auto;max-width:none;max-height:none;border-radius:0;margin:0;border:0;padding:10px 12px 90px}
      }
      .head{display:flex;justify-content:space-between;align-items:center;position:sticky;top:-12px;background:#fff;padding:6px 0;z-index:2;font-size:16px}
      label{display:block;margin-top:10px;margin-bottom:3px;font-weight:bold}
      input,select,textarea{width:100%;padding:10px;font-size:16px;border:1px solid #bbb;border-radius:8px;background:#fff;color:#222}
      .row{display:flex;gap:8px;flex-wrap:wrap}.row>div{flex:1 1 150px}
      .chips{display:flex;gap:6px;margin-top:6px}
      .chips button{padding:5px 12px;font-size:13px;border-radius:16px}
      .actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
      .actions .primary{flex:1 1 100%;padding:14px;font-size:17px}
      .actions button:not(.primary){flex:1}
      details{margin-top:10px;border:1px solid #ddd;border-radius:8px;padding:6px 10px;background:#fafafa}
      summary{cursor:pointer;font-weight:bold;padding:6px 0}
      #matrix{overflow-x:auto;-webkit-overflow-scrolling:touch}
      table{border-collapse:collapse;margin-top:8px;font-size:11px}
      th,td{border:1px solid #ccc;padding:3px 6px;text-align:center;white-space:nowrap}
      .yes{background:#c8f0c8;font-weight:bold}.zero{background:#f3d0d0}.na{background:#eee;color:#999}
      .cover{outline:2px solid #06c;outline-offset:-2px}
      .route{border:1px solid #7b7;border-radius:8px;padding:8px;margin-top:8px;line-height:1.5}
      .route.warn{border-color:#e0a030;background:#fff8e8}
      .gap{color:#b45f00;font-weight:bold}
      .note{color:#555;font-size:12px}
      #status{margin-top:10px;color:#333;font-weight:bold}
      #understood{margin-top:4px;color:#06c;font-size:12px}
      .hc{display:inline-block;border-radius:12px;padding:2px 10px;margin:4px 6px 0 0;font-size:12px;font-weight:bold}
      .hc.ok{background:#d9f2e3;color:#0a6b47}.hc.bad{background:#fde0e0;color:#b00}.hc.mid{background:#eee;color:#555}
      #prog{height:8px;background:#e5e5e5;border-radius:4px;margin-top:10px;overflow:hidden}
      #progbar{height:100%;width:0;background:#0a6;transition:width .3s}
      .buy{background:#d33;color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:bold}
      #log{font:12px monospace;background:#111;color:#9f9}
      #recent{flex-wrap:wrap}
      .smart{background:#f2f7ff;border:1px solid #cde;border-radius:8px;padding:8px;margin-top:8px}
    </style>
    <div id="panel" hidden>
      <div class="head"><b>🚆 Split Ticket Finder <span class="note">v3</span></b><button id="close">✕ Close</button></div>

      <div id="health"></div>
      <div id="recent" class="chips"></div>
      <details class="smart">
        <summary>✨ Describe your trip (optional, uses Gemini)</summary>
        <input id="free" placeholder="e.g. titumir birampur to rajshahi tomorrow snigdha">
        <div class="actions"><button id="smart" class="primary" style="padding:10px;font-size:15px">Smart fill</button></div>
        <div class="note" style="margin-top:6px"><span id="keystate"></span></div>
        <div class="row" style="margin-top:6px">
          <div style="flex:1 1 100%"><input id="key" type="password" placeholder="Gemini API key (stored only in this extension)"></div>
          <button id="savekey">Save key</button><button id="clearkey">Remove key</button>
        </div>
      </details>

      <div class="row">
        <div><label>Train (name or number)</label><input id="train" placeholder="e.g. 734 or titumir"></div>
      </div>
      <div class="row">
        <div><label>From</label><input id="from" autocapitalize="words"></div>
        <div><label>To</label><input id="to" autocapitalize="words"></div>
      </div>
      <div class="row">
        <div>
          <label>Date</label><input id="date" placeholder="24-Oct-2026 / tomorrow">
          <div class="chips"><button id="dToday">Today</button><button id="dTomorrow">Tomorrow</button></div>
        </div>
        <div><label>Class</label>
          <select id="cls"><option value="">Auto</option>${CLASSES.map((c) => `<option value="${c}">${c}</option>`).join("")}</select>
        </div>
        <div><label>No-ticket stops allowed</label><input id="gap" type="number" inputmode="numeric" min="0" max="5" value="2"></div>
      </div>

      <div class="actions">
        <button id="scan" class="primary">🔍 Scan whole train</button>
        <button id="stop">Stop</button><button id="watch">🔔 Watch</button><button id="redo">Re-detect</button><button id="diag">🩺 Check</button>
      </div>
      <div id="understood"></div>
      <div id="prog" hidden><div id="progbar"></div></div>
      <div id="status"></div>
      <div id="direct"></div>
      <div id="routes"></div>

      <details>
        <summary>🐞 Debug log (সমস্যা হলে এটা Copy করে পাঠান)</summary>
        <div class="actions"><button id="logcopy">📋 Copy log</button><button id="logclear">Clear</button></div>
        <textarea id="log" rows="9" readonly></textarea>
      </details>
      <details>
        <summary>🛤 Train stops (advanced)</summary>
        <textarea id="stops" rows="3" placeholder="leave empty: the whole train route is detected for you"></textarea>
      </details>
      <details>
        <summary>📊 Seat table (all station pairs)</summary>
        <div id="matrix"></div>
      </details>
    </div>
    <button id="toggle">🚆 Split Finder</button>`;
    document.body.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const say = (t) => ($("status").textContent = t);
    let running = false, stopFlag = false, manualStops = false, forceRedo = false;
    let lastPlan = "", hasKey = false, watching = false, watchTimer = null, scanOutcome = null, skipSet = new Set();

    $("stops").addEventListener("input", () => { manualStops = true; });

    function prefill() {
      const q = new URLSearchParams(location.search);
      if (q.get("fromcity") && !$("from").value) $("from").value = q.get("fromcity");
      if (q.get("tocity") && !$("to").value) $("to").value = q.get("tocity");
      if (q.get("doj") && !$("date").value) $("date").value = q.get("doj");
      if (q.get("class") && !$("cls").value) $("cls").value = q.get("class");
    }

    function readForm() {
      const notes = [];
      const fFrom = fixStation($("from").value), fTo = fixStation($("to").value);
      if (fFrom.note) notes.push(fFrom.note);
      if (fTo.note) notes.push(fTo.note);
      const q = new URLSearchParams(location.search);
      const dateIn = $("date").value.trim();
      const date = parseDate(dateIn) || parseDate(q.get("doj"));
      if (date && date !== dateIn) notes.push("date → " + date);
      const clsFallback = parseClass(q.get("class"), "S_CHAIR");
      const clsIn = $("cls").value.trim();
      const cls = parseClass(clsIn, clsFallback);
      if (cls !== clsIn) notes.push("class → " + cls);
      const key = trainKeyOf($("train").value);
      const trainShown = key.num || key.name;
      if (trainShown !== $("train").value.trim()) notes.push("train → " + (trainShown || "(blank)"));
      const gap = clamp(parseInt($("gap").value, 10) || 0, 0, 5);
      $("from").value = fFrom.name; $("to").value = fTo.name;
      if (date) $("date").value = date;
      $("cls").value = cls; $("train").value = trainShown; $("gap").value = gap;
      $("understood").textContent = notes.length ? "Fixed for you: " + notes.join("  ·  ") : "";
      return { from: fFrom.name, to: fTo.name, date, cls, key, gap };
    }

    function renderMatrix(stations, counts, fi, ti) {
      let h = "<table><tr><th>From \\ To</th>" + stations.slice(1).map((s) => `<th>${esc(s)}</th>`).join("") + "</tr>";
      for (let i = 0; i < stations.length - 1; i++) {
        h += `<tr><th>${esc(stations[i])}</th>`;
        for (let j = 1; j < stations.length; j++) {
          if (j <= i) { h += '<td class="na"></td>'; continue; }
          if (skipSet.has(i + "," + j)) { h += '<td class="na">·</td>'; continue; }
          const c = counts[i + "," + j];
          const cov = i <= fi && j >= ti ? " cover" : "";
          if (c === undefined) h += `<td class="${cov}">…</td>`;
          else if (c === null) h += `<td class="na${cov}" title="Train does not serve this pair / lookup failed">–</td>`;
          else h += `<td class="${c.online > 0 ? "yes" : "zero"}${cov}" title="Fare ${esc(c.fare)} | counter seats: ${c.offline}">${c.online}</td>`;
        }
        h += "</tr>";
      }
      $("matrix").innerHTML = h + '</table><div class="note">Numbers = online seats for that From→To. Blue outline = tickets that cover your whole trip. “·” = not needed for your trip, skipped.</div>';
    }

    function renderRoutes(stations, counts, fi, ti, maxGap, partial) {
      const routes = findRoutes(stations, counts, fi, ti, maxGap);
      if (!routes.length) {
        $("routes").innerHTML = partial ? "" : `<div class="route" style="border-color:#c99">❌ ${esc(stations[fi])} → ${esc(stations[ti])}: এখন যাওয়ার উপায় নেই (no way right now), even with ${maxGap} no-ticket stop(s) allowed. “No-ticket stops” বাড়িয়ে (৩–৪) আবার চেষ্টা করুন, অথবা 🔔 Watch চালু রাখুন।</div>`;
        return routes;
      }
      let h = `<b>Best routes for ${esc(stations[fi])} → ${esc(stations[ti])}</b> <span class="note">(fewest no-ticket stops, then fewest tickets, then least extra distance, then most seats)</span>`;
      routes.slice(0, 10).forEach((r, idx) => {
        const tk = r.segs.filter((x) => x.type === "t");
        const mn = Math.min(...tk.map((x) => x.c.online));
        let marked = false;
        const parts = r.segs.map((s) => {
          if (s.type === "t") {
            let badge = "";
            if (tk.length > 1 && s.c.online === mn && !marked) { marked = true; badge = ' <span class="buy">Buy first</span>'; }
            let extra = "";
            if (s.a < fi) extra += ` — you board at ${esc(stations[fi])}`;
            if (s.b > ti) extra += ` — you get off at ${esc(stations[ti])}`;
            return `🎫 ${esc(stations[s.a])} → ${esc(stations[s.b])} (<b>${s.c.online}</b> seats, ৳${esc(s.c.fare)})${badge}<span class="note">${extra}</span>`;
          }
          const hops = s.b - s.a;
          return `<span class="gap">🧍 ${esc(stations[s.a])} → ${esc(stations[s.b])}: NO TICKET (${hops} stop${hops > 1 ? "s" : ""})</span>`;
        });
        let label;
        if (r.gaps === 0 && r.tickets === 1) label = "1 ticket, one seat the whole way";
        else if (r.gaps === 0) label = `${r.tickets} tickets, fully covered`;
        else label = `${r.tickets} ticket(s) + ${r.gaps} stop(s) without a ticket`;
        if (r.extra) label += `, paying for ${r.extra} extra stop(s)`;
        h += `<div class="route ${r.gaps ? "warn" : ""}">#${idx + 1} — ${label}<br>${parts.join("<br>")}<br><small>Total fare ≈ ৳${r.fare}</small></div>`;
      });
      h += '<p class="note">Tip: buy the ticket with the FEWEST seats first. Seat numbers may differ between tickets.</p>';
      const r0 = routes[0];
      lastPlan = `${stations[fi]} → ${stations[ti]}\n` + r0.segs.map((s) => s.type === "t"
        ? `🎫 ${stations[s.a]} → ${stations[s.b]} (${s.c.online} seats, ৳${s.c.fare})`
        : `🧍 ${stations[s.a]} → ${stations[s.b]}: NO TICKET`).join("\n") + `\nTotal ≈ ৳${r0.fare}`;
      h += '<div class="actions"><button data-act="copy">📋 Copy best plan</button></div>';
      $("routes").innerHTML = h;
      return routes;
    }

    function health() {
      const chip = (cls, t) => `<span class="hc ${cls}">${t}</span>`;
      const ok = !!auth.authorization;
      $("health").innerHTML =
        chip(ok ? "ok" : "bad", (ok ? "✓" : "✗") + " Session") +
        chip(hasKey ? "ok" : "mid", (hasKey ? "✓" : "–") + " Gemini") +
        chip("mid", "⚡ " + (curDelay / 1000).toFixed(1) + "s/req") +
        (ok ? "" : '<div class="note" style="margin-top:4px">Session নেই: রেলওয়ে সাইটে লগইন করে একবার যেকোনো ট্রেন সার্চ দিন।</div>');
    }
    function setProg(done, total) {
      $("prog").hidden = !total;
      $("progbar").style.width = (total ? Math.round((done * 100) / total) : 0) + "%";
    }
    function getRecent() {
      try { return JSON.parse(localStorage.getItem("tsf_recent") || "[]"); } catch (e) { return []; }
    }
    function renderRecent() {
      $("recent").innerHTML = getRecent().map((x, i) =>
        `<button data-i="${i}">${esc(x.from)} → ${esc(x.to)}${x.train ? " · " + esc(x.train) : ""}</button>`).join("");
    }
    function saveRecent(f) {
      try {
        const it = { train: $("train").value, from: f.from, to: f.to, cls: f.cls };
        const a = getRecent().filter((x) => !(x.train === it.train && x.from === it.from && x.to === it.to && x.cls === it.cls));
        a.unshift(it);
        localStorage.setItem("tsf_recent", JSON.stringify(a.slice(0, 5)));
      } catch (e) {}
      renderRecent();
    }
    function alertUser() {
      try { navigator.vibrate && navigator.vibrate([300, 150, 300, 150, 600]); } catch (e) {}
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        [0, 0.25, 0.5].forEach((t) => {
          const o = ac.createOscillator(), g = ac.createGain();
          o.connect(g); g.connect(ac.destination);
          o.frequency.value = 880; g.gain.value = 0.2;
          o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.15);
        });
      } catch (e) {}
    }
    function stopWatch() {
      watching = false; clearTimeout(watchTimer);
      $("watch").textContent = "🔔 Watch";
    }
    function scheduleWatch() {
      let left = 180;
      const tick = () => {
        if (!watching) return;
        if (left <= 0) { runScan(); return; }
        say("🔔 Watch চালু — আবার চেক হবে " + left + "s পরে (Stop চাপলে বন্ধ)");
        left--;
        watchTimer = setTimeout(tick, 1000);
      };
      tick();
    }
    function afterScan() {
      if (!watching) return;
      if (!scanOutcome) { stopWatch(); return; }
      if (scanOutcome.routes && scanOutcome.routes.length) {
        alertUser(); stopWatch();
        say("🎉 রুট পাওয়া গেছে! এখনই টিকিট কিনুন — (সবচেয়ে কম সিটের টিকিট আগে)");
        log("INFO", "watch: route found");
      } else scheduleWatch();
    }

    async function diagnose() {
      if (running) return say("স্ক্যান চলছে — আগে Stop দিন।");
      const out = [];
      const line = (ok, t, fix) => out.push(`<div>${ok === null ? "➖" : ok ? "✅" : "❌"} ${esc(t)}${ok === false && fix ? `<div class="note">→ ${esc(fix)}</div>` : ""}</div>`);
      const show = () => { $("direct").innerHTML = `<div class="route"><b>🩺 Check</b>${out.join("")}</div>`; };
      say("🩺 পরীক্ষা চলছে…"); log("INFO", "diagnose start");
      line(!!auth.authorization, auth.authorization ? "Session (রেলওয়ের লগইন টোকেন) ধরা পড়েছে" : "Session ধরা পড়েনি", "সাইটে লগইন করে একবার যেকোনো ট্রেন সার্চ দিন।");
      show();
      try {
        const r = await callBridge("haskey");
        line(true, "App bridge ঠিক আছে");
        line(r.has ? true : null, r.has ? "Gemini key সেভ আছে" : "Gemini key নেই (ঐচ্ছিক, না থাকলেও চলে)");
      } catch (e) {
        line(false, "App bridge কাজ করছে না (" + e.message + ")", "Play Store থেকে 'Android System WebView' আপডেট করুন।");
      }
      show();
      const f = readForm();
      if (auth.authorization && f.from && f.to && f.date) {
        const t0 = Date.now();
        try {
          const trains = await fetchTrains(f.from, f.to, f.date, f.cls);
          line(true, `রেলওয়ে API ঠিক আছে (${Date.now() - t0}ms, ${trains.length}টি ট্রেন)`);
          if ($("train").value.trim()) {
            const tr = findTrain(trains, f.key);
            line(!!tr, tr ? "ট্রেন পাওয়া গেছে: " + tr.trip_number : "এই ট্রেন এই তারিখ/ক্লাসে নেই", "পাওয়া গেছে: " + describe(trains));
          }
        } catch (e) { line(false, "রেলওয়ে API: " + explain(e)); }
      } else line(null, "রেলওয়ে API পরীক্ষা বাদ গেছে — Session আর From, To, Date লাগবে");
      show();
      if (hasKey) {
        const t0 = Date.now();
        try {
          const o = parseJsonLoose(await askGemini('Reply with JSON only: {"ok":true}'));
          line(!!o.ok, `Gemini কাজ করছে (${Date.now() - t0}ms)`, "Key ভুল হতে পারে — আবার সেভ করুন।");
        } catch (e) { line(false, "Gemini: " + e.message, "Key ঠিক আছে কিনা আর ইন্টারনেট আছে কিনা দেখুন।"); }
      }
      show(); say("🩺 পরীক্ষা শেষ।"); log("INFO", "diagnose done");
    }

    // find the train, learn its full route (start and end station)
    async function prepare(f) {
      if (!f.from || !f.to) { say("⚠️ From আর To লিখুন।"); return null; }
      if (!f.date) { say("I couldn't understand the date. Try 24-Oct-2026 or 'tomorrow'."); return null; }
      if (!auth.authorization) { say("⏳ Session এখনো ধরা পড়েনি। রেলওয়ে সাইটে লগইন করে একবার যেকোনো ট্রেন সার্চ দিন (বা Reload চাপুন), তারপর আবার Scan করুন।"); return null; }
      const ctx = { date: f.date, cls: f.cls, key: f.key, cache: new Map(), trainObj: null };
      say(`Looking for the train on ${f.from} → ${f.to}, ${f.date}…`);
      const trains = await fetchTrains(f.from, f.to, f.date, f.cls);
      const train = findTrain(trains, f.key);
      if (!train) {
        say(`I couldn't find train "${$("train").value || "?"}" for ${f.from} → ${f.to} on ${f.date} (${f.cls}). Trains found: ${describe(trains)}. Fix the train/class/date and try again.`);
        return null;
      }
      if (!(train.seat_types || []).some((s) => s.type === f.cls)) {
        const avail = (train.seat_types || []).map((s) => s.type);
        if (avail.length === 1) {
          ctx.cls = avail[0];
          $("cls").value = ctx.cls;
          $("understood").textContent += `  ·  class → ${ctx.cls} (only class on this train)`;
        } else {
          say(`${train.trip_number} has no ${f.cls} here. Classes available: ${avail.join(", ") || "none"}.`);
          return null;
        }
      }
      const num = (String(train.trip_number).match(/\((\d+)\)/) || [])[1];
      ctx.key = num ? { num, name: "" } : f.key;
      ctx.trainObj = train;
      ctx.cache.set(f.from + "|" + f.to, analyse(trains, ctx));
      log("INFO", "train " + train.trip_number + " | " + f.from + " → " + f.to + " | " + f.date + " | " + ctx.cls);
      const dir = ctx.cache.get(f.from + "|" + f.to);
      $("direct").innerHTML = dir && dir.online > 0
        ? `<div class="route">✅ <b>সরাসরি টিকিট আছে:</b> ${esc(f.from)} → ${esc(f.to)} — <b>${dir.online}</b> seats, ৳${esc(dir.fare)}. Split লাগবে না (চাইলে নিচে স্ক্যান চালিয়ে যেতে পারেন)।</div>`
        : '<div class="note">সরাসরি টিকিট নেই (0 seat) — split খুঁজছি…</div>';

      const pr = train.parent_route || {};
      ctx.start = (pr.origin_city_name || "").trim();
      ctx.end = (pr.destination_city_name || "").trim();
      ctx.base = null;
      if (ctx.start && ctx.end) {
        say(`Train runs ${ctx.start} → ${ctx.end}. Reading the full route…`);
        try { ctx.base = await checkPair(ctx, ctx.start, ctx.end); } catch (e) { if (e.message === "AUTH") throw e; }
        await sleep(curDelay);
      }
      if (!ctx.base) {
        ctx.start = f.from; ctx.end = f.to;
        ctx.base = ctx.cache.get(f.from + "|" + f.to);
        $("understood").textContent += "  ·  couldn't read the full route, scanning only your trip";
      }
      return ctx;
    }

    // Gemini suggests stops; every one is verified against the railway site
    async function discover(ctx, f) {
      const { start, end, base } = ctx;
      let names = [], usedGemini = true;
      try {
        const prompt =
          `Bangladesh Railway train "${ctx.trainObj.trip_number}". List every station where this train stops from ${start} to ${end} ` +
          `(both included) in travel order. Use plain English names as written on the Bangladesh Railway e-ticket site, ` +
          `without words like Station or Junction. Respond with JSON only: {"stations":["..."]}`;
        const out = parseJsonLoose(await askGemini(prompt));
        names = out.stations || [];
      } catch (e) {
        usedGemini = false;
        names = loadKnown();
        $("understood").textContent = "Gemini unavailable (" + e.message + "): checking stations I already know instead.";
      }
      const cands = [], seen = new Set([start.toLowerCase(), end.toLowerCase()]);
      [...names, f.from, f.to].forEach((s) => {
        const x = fixStation(s);
        if (x.name && !seen.has(x.name.toLowerCase())) { seen.add(x.name.toLowerCase()); cands.push(x.name); }
      });
      const ok = [], dropped = [];
      let i = 0;
      for (const c of cands) {
        if (stopFlag) return null;
        i++;
        say(`Verifying stop ${i}/${cands.length}: ${c}`);
        const had = ctx.cache.has(start + "|" + c);
        try {
          const r = await checkPair(ctx, start, c);
          if (r && r.dseq > base.oseq && r.dseq < base.dseq) ok.push({ name: c, dseq: r.dseq });
          else dropped.push(c);
        } catch (e) {
          if (e.message === "AUTH") throw e;
          dropped.push(c);
        }
        if (!had) await sleep(curDelay);
      }
      ok.sort((a, b) => a.dseq - b.dseq);
      const uniq = ok.filter((x, k) => k === 0 || x.dseq !== ok[k - 1].dseq);
      saveKnown(uniq.map((x) => x.name));
      if (dropped.length && usedGemini) $("understood").textContent = "Not verified on this train, dropped: " + dropped.join(", ");
      return [start, ...uniq.map((x) => x.name), end];
    }

    async function getStops(ctx, f) {
      const typed = $("stops").value.split(",").map((s) => fixStation(s).name).filter(Boolean);
      if (manualStops && typed.length >= 3) return typed;
      const ck = "tsf_stops_" + (ctx.key.num || ctx.key.name) + "_" + ctx.start + "_" + ctx.end;
      if (!forceRedo) {
        try {
          const cached = JSON.parse(localStorage.getItem(ck) || "null");
          if (Array.isArray(cached) && cached.length >= 2) return cached;
        } catch (e) {}
      }
      say("Detecting every stop of the train…");
      const st = await discover(ctx, f);
      if (!st) return null;
      try { localStorage.setItem(ck, JSON.stringify(st)); } catch (e) {}
      return st;
    }

    function explain(e) {
      const m = String((e && e.message) || e);
      if (m === "AUTH") return "❌ Session নেই বা শেষ হয়ে গেছে (401/403)। সমাধান: রেলওয়ে সাইটে লগইন করে একটা ট্রেন সার্চ দিন, তারপর আবার Scan চাপুন।";
      if (m === "HTTP 422") return "❌ সাইট স্টেশনের নাম নেয়নি (422)। From/To এর বানান ঠিক করুন।";
      if (m === "HTTP 429") return "❌ সাইট বলছে অনেক দ্রুত রিকোয়েস্ট (429)। ১–২ মিনিট থেমে আবার চেষ্টা করুন — অ্যাপ নিজেই ধীর হয়ে গেছে।";
      if (/^HTTP 5/.test(m)) return "❌ রেলওয়ে সার্ভারে সমস্যা (" + m + ")। একটু পরে আবার চেষ্টা করুন।";
      if (/network|failed to fetch|timeout|timed out/i.test(m)) return "❌ ইন্টারনেট/নেটওয়ার্ক সমস্যা। সংযোগ দেখে আবার চেষ্টা করুন।";
      return "❌ Error: " + m + " — নিচে 🐞 Debug log খুলে Copy করে আমাকে পাঠান।";
    }

    async function runScan() {
      if (running) return;
      let wl = null;
      try { wl = navigator.wakeLock ? await navigator.wakeLock.request("screen") : null; } catch (e) {}
      scanOutcome = null;
      try { await runScanInner(); } finally { try { wl && wl.release(); } catch (e) {} }
      afterScan();
    }
    async function runScanInner() {
      if (running) return;
      running = true; stopFlag = false;
      $("direct").innerHTML = ""; setProg(0, 0);
      try {
        const f = readForm();
        const ctx = await prepare(f);
        if (!ctx) { running = false; forceRedo = false; return; }
        saveRecent(f);

        const stations = await getStops(ctx, f);
        forceRedo = false;
        if (!stations) { say("Stopped."); running = false; return; }
        manualStops = false;
        $("stops").value = stations.join(", ");

        const fi = idxOf(stations, f.from), ti = idxOf(stations, f.to);
        if (fi < 0 || ti < 0) {
          say(`${fi < 0 ? f.from : f.to} is not in the stop list. Check the spelling or add it to the stops box.`);
          running = false; return;
        }
        if (fi >= ti) {
          say("This train runs the other way: your From comes after your To on its route.");
          running = false; return;
        }
        if (stations.length > 40) { say("That is more than 40 stops. Please trim the stops box."); running = false; return; }

        const counts = {};
        skipSet = new Set();
        const pairs = [];
        for (let i = 0; i < stations.length - 1; i++)
          for (let j = i + 1; j < stations.length; j++) {
            if ((i <= fi && j > fi) || (i > fi && i < ti)) pairs.push([i, j]);
            else skipSet.add(i + "," + j);
          }
        // most useful first: tickets that cover the whole trip, then longer ones
        const covers = (q) => (q[0] <= fi && q[1] >= ti ? 0 : 1);
        pairs.sort((x, y) => covers(x) - covers(y) || (y[1] - y[0]) - (x[1] - x[0]));
        const todo = pairs.filter(([i, j]) => !ctx.cache.has(stations[i] + "|" + stations[j])).length;
        log("INFO", `scan: ${stations.length} stops, ${pairs.length} pairs needed (${skipSet.size} skipped), ${todo} to fetch`);
        $("routes").innerHTML = "";
        renderMatrix(stations, counts, fi, ti);

        let done = 0, fetched = 0, lastErr = "";
        const t0 = Date.now();
        for (const [i, j] of pairs) {
          if (stopFlag) break;
          const had = ctx.cache.has(stations[i] + "|" + stations[j]);
          const left = Math.max(0, todo - fetched);
          say(`🔎 ${stations[i]} → ${stations[j]}  (${done + 1}/${pairs.length}) · ~${Math.ceil((left * (curDelay + 400)) / 1000)}s বাকি`);
          setProg(done, pairs.length);
          try {
            counts[i + "," + j] = await checkPair(ctx, stations[i], stations[j]);
          } catch (e) {
            if (e.message === "AUTH") throw e;
            counts[i + "," + j] = null;
            lastErr = e.message;
            log("ERR", stations[i] + "→" + stations[j] + ": " + e.message);
          }
          done++;
          if (!had) fetched++;
          if (done % 3 === 0) renderMatrix(stations, counts, fi, ti);
          if (done % 5 === 0) renderRoutes(stations, counts, fi, ti, f.gap, true);
          if (!had) await sleep(curDelay);
        }
        setProg(done, pairs.length);
        renderMatrix(stations, counts, fi, ti);
        log("INFO", `scan finished: ${done}/${pairs.length} pairs in ${Math.round((Date.now() - t0) / 1000)}s${lastErr ? ", last error: " + lastErr : ""}`);
        say(stopFlag ? "⏹ Stopped — এখন পর্যন্ত যা পাওয়া গেছে দেখাচ্ছি।" : lastErr ? `✅ Done — কিছু lookup fail হয়েছে (${lastErr}). নিচে Debug log দেখুন।` : "✅ Done.");
        const routes = renderRoutes(stations, counts, fi, ti, f.gap);
        scanOutcome = stopFlag ? null : { routes };
      } catch (e) { log("ERR", String(e.message || e)); say(explain(e)); }
      running = false; forceRedo = false;
    }

    $("toggle").onclick = () => {
      const p = $("panel");
      p.hidden = !p.hidden;
      if (!p.hidden) prefill();
    };
    $("close").onclick = () => { $("panel").hidden = true; };
    $("dToday").onclick = () => { $("date").value = "today"; };
    $("dTomorrow").onclick = () => { $("date").value = "tomorrow"; };
    const refreshKey = async () => {
      try { const r = await callBridge("haskey"); hasKey = !!r.has; health(); $("keystate").textContent = r.has ? "Gemini key saved ✓" : "No Gemini key saved (optional, the app works without it)"; }
      catch (e) { $("keystate").textContent = ""; }
    };
    $("savekey").onclick = async () => {
      const v = $("key").value.trim();
      if (!v) return say("Paste a key first.");
      try { await callBridge("setkey", { key: v }); $("key").value = ""; } catch (e) { say("Could not save key: " + e.message); }
      refreshKey();
    onLog = () => { const el = $("log"); el.value = LOG.join("\n"); el.scrollTop = el.scrollHeight; };
    onAuth = () => { log("INFO", "session captured from site"); health(); };
    renderRecent(); health(); setInterval(health, 3000);
    log("INFO", "app ready");
    };
    $("clearkey").onclick = async () => { try { await callBridge("clearkey"); } catch (e) {} refreshKey(); };
    refreshKey();
    $("stop").onclick = () => { stopFlag = true; stopWatch(); say("Stopping…"); };
    $("watch").onclick = () => {
      if (watching) { stopWatch(); say("🔔 Watch বন্ধ।"); return; }
      watching = true; $("watch").textContent = "⏹ Stop watch";
      log("INFO", "watch on (every ~3 min)");
      runScan();
    };
    $("diag").onclick = diagnose;
    $("routes").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b || b.dataset.act !== "copy" || !lastPlan) return;
      const ta = document.createElement("textarea");
      ta.value = lastPlan; root.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (x) {}
      ta.remove();
      say(ok ? "📋 Plan copy হয়েছে।" : "Copy করা যায়নি।");
    };
    $("recent").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const x = getRecent()[+b.dataset.i]; if (!x) return;
      $("train").value = x.train || ""; $("from").value = x.from; $("to").value = x.to; $("cls").value = x.cls || "";
      manualStops = false; $("stops").value = "";
    };
    $("logcopy").onclick = () => {
      const el = $("log");
      el.value = ["Train Split Finder v3", navigator.userAgent, "session=" + !!auth.authorization, "gemini=" + hasKey, "delay=" + curDelay + "ms", "---"].concat(LOG).join("\n");
      el.focus(); el.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
      say(ok ? "📋 Log copy হয়েছে।" : "Log সিলেক্ট হয়েছে — Copy চাপুন।");
    };
    $("logclear").onclick = () => { LOG.length = 0; if (onLog) onLog(); };
    $("scan").onclick = runScan;
    $("redo").onclick = () => { if (running) return; forceRedo = true; manualStops = false; $("stops").value = ""; runScan(); };

    $("smart").onclick = async () => {
      const text = $("free").value.trim();
      if (!text) return say("Type your trip in the box first.");
      say("Understanding…");
      try {
        const prompt =
          `Today is ${fmtDate(new Date())}. Convert this Bangladesh train trip request into JSON with keys: ` +
          `from, to (English station names), date (format like 23-Oct-2026; dates are day-first), ` +
          `class (one of ${CLASSES.join(", ")} or ""), train (number or name, or ""). ` +
          `Respond with JSON only. Request: """${text}"""`;
        const o = parseJsonLoose(await askGemini(prompt));
        if (o.from) $("from").value = o.from;
        if (o.to) $("to").value = o.to;
        if (o.date) $("date").value = o.date;
        if (o.class) $("cls").value = o.class;
        if (o.train) $("train").value = o.train;
        manualStops = false; $("stops").value = "";
        readForm();
        say("Filled. Check the boxes, then press Scan whole train.");
      } catch (e) {
        say("Gemini problem: " + e.message + ". You can still fill the boxes by hand.");
      }
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initUI);
  else initUI();
})();