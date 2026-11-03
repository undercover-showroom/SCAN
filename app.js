/* UNDERCOVER SHOWROOM - Contrôle des billets (v1) */
const API_URL = "https://script.google.com/macros/s/AKfycbzEvN5uOQSeMAr1zSzAZ7_nr5yCKDasvEub_UHt5CUKblbJj99mZihRBCN5wrVrZTMK/exec";
const SALT = "undercover-showroom-2026";

/* ======================= COEUR (logique, sans écran) ======================= */
function createCore(deps) {
  const K = { list: "uc_list", queue: "uc_queue", hash: "uc_hash", conflicts: "uc_conflicts" };
  const store = deps.store;
  let pin = null;

  function fmt(d) {
    const p = new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Indian/Antananarivo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return p.day + "/" + p.month + "/" + p.year + " " + p.hour + ":" + p.minute + ":" + p.second;
  }

  async function post(action, extra, timeoutMs, pinOverride) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 8000) : null;
    try {
      const body = JSON.stringify(Object.assign({ pin: pinOverride !== undefined ? pinOverride : pin, action: action }, extra || {}));
      const resp = await deps.fetchFn(deps.api, { method: "POST", body: body, redirect: "follow", signal: ctrl ? ctrl.signal : undefined });
      return await resp.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function getList() { return store.get(K.list) || []; }
  function getQueue() { return store.get(K.queue) || []; }

  async function unlock(p) {
    const hashNow = await deps.sha256(SALT + p);
    let r = null;
    try { r = await post("stats", {}, 8000, p); } catch (e) { r = null; }
    if (r && r.result === "PIN_INCORRECT") return { status: "bad-pin" };
    if (r && r.result === "BLOQUE") return { status: "blocked" };
    if (r && r.ok) {
      pin = p;
      store.set(K.hash, hashNow);
      await syncQueue();
      await refreshList();
      return { status: "online" };
    }
    const h = store.get(K.hash);
    if (!h || !store.get(K.list)) return { status: "need-online" };
    if (h !== hashNow) return { status: "bad-pin" };
    pin = p;
    return { status: "offline" };
  }

  function lock() { pin = null; }
  function isUnlocked() { return pin !== null; }

  async function refreshList() {
    let r;
    try { r = await post("list", {}, 20000); } catch (e) { return false; }
    if (!r || !r.ok || !r.billets) return false;
    const list = r.billets;
    // garder les entrées faites hors ligne et pas encore envoyées
    getQueue().forEach(function (item) {
      const parts = String(item.qr).split("|");
      const b = list.find(function (x) { return x.n === parts[0].trim(); });
      if (b && !b.u) { b.u = true; b.d = fmt(new Date(item.ts)); }
    });
    store.set(K.list, list);
    return true;
  }

  async function syncQueue() {
    const q = getQueue();
    if (!q.length) return { sent: 0 };
    let r;
    try { r = await post("sync", { scans: q }, 20000); } catch (e) { return { sent: 0, error: "network" }; }
    if (!r || !r.ok || !r.resultats) return { sent: 0, error: "server" };
    const conflicts = store.get(K.conflicts) || [];
    r.resultats.forEach(function (x, i) {
      if (x.result !== "VALIDE") conflicts.push({ qr: q[i].qr, number: x.number || "", result: x.result, ts: q[i].ts });
    });
    store.set(K.conflicts, conflicts);
    store.set(K.queue, getQueue().slice(q.length));
    return { sent: q.length, conflicts: conflicts.length };
  }

  async function scan(qr) {
    const lu = String(qr || "").trim();
    const parts = lu.split("|");
    const list = getList();
    let local = null, number = "";
    if (parts.length === 2) {
      number = parts[0].trim();
      const code = parts[1].trim().toUpperCase();
      local = list.find(function (b) { return b.n === number && b.c === code; }) || null;
    }
    // 1) déjà utilisé d'après la copie locale (inclut les entrées hors ligne)
    if (local && local.u) {
      return { result: "DEJA_UTILISE", number: number, category: local.cat, usedAt: local.d, source: "local" };
    }
    // 2) le serveur fait foi quand il répond
    let r = null;
    try { r = await post("scan", { qr: lu }, 6000); } catch (e) { r = null; }
    if (r && r.ok && (r.result === "VALIDE" || r.result === "DEJA_UTILISE" || r.result === "INCONNU")) {
      if ((r.result === "VALIDE" || r.result === "DEJA_UTILISE") && r.number) {
        const b = list.find(function (x) { return x.n === r.number; });
        if (b) { b.u = true; b.d = r.usedAt || b.d; store.set(K.list, list); }
      }
      return Object.assign({ source: "serveur" }, r);
    }
    if (r && (r.result === "PIN_INCORRECT" || r.result === "BLOQUE")) {
      return { result: "ERREUR_PIN", source: "serveur" };
    }
    // 3) serveur injoignable : décision locale, mise en file d'attente
    if (!local) return { result: "INCONNU", qr: lu, source: "hors ligne" };
    const now = new Date();
    local.u = true; local.d = fmt(now);
    store.set(K.list, list);
    const q = getQueue(); q.push({ qr: lu, ts: now.toISOString() });
    store.set(K.queue, q);
    return { result: "VALIDE", number: number, category: local.cat, usedAt: local.d, source: "hors ligne" };
  }

  function stats() {
    const list = getList();
    const used = list.filter(function (b) { return b.u; }).length;
    return { total: list.length, used: used, remaining: list.length - used,
             pending: getQueue().length, conflicts: (store.get(K.conflicts) || []) };
  }

  function clearConflicts() { store.set(K.conflicts, []); }

  function exportCsv() {
    const rows = [["NUMÉRO BILLET", "CATÉGORIE", "STATUT", "DATE D'ENTRÉE"]];
    getList().forEach(function (b) { rows.push([b.n, b.cat, b.u ? "UTILISÉ" : "NON UTILISÉ", b.d || ""]); });
    return rows.map(function (r) { return r.join(";"); }).join("\r\n");
  }

  return { unlock, lock, isUnlocked, refreshList, syncQueue, scan, stats, clearConflicts, exportCsv, fmt };
}

if (typeof module !== "undefined") module.exports = { createCore: createCore };

/* ======================= ÉCRAN ======================= */
if (typeof document !== "undefined") {
  (function () {
    const $ = function (id) { return document.getElementById(id); };
    const store = {
      get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
      set: function (k, v) { localStorage.setItem(k, JSON.stringify(v)); }
    };
    async function sha256(t) {
      const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
      return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, "0"); }).join("");
    }
    const core = createCore({ api: API_URL, store: store, fetchFn: function (u, o) { return fetch(u, o); }, sha256: sha256 });

    let stream = null, scanning = false, jsqrReady = false, lastText = "", lastTime = 0, dismissTimer = null, audio = null;
    const video = $("video"), canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });

    function initAudio() {
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === "suspended") audio.resume();
      } catch (e) {}
    }

    function beep(type) {
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        const seq = type === "ok" ? [[880, 0.12]] : type === "dup" ? [[300, 0.15], [300, 0.15]] : [[180, 0.4]];
        let t = audio.currentTime;
        seq.forEach(function (s) {
          const o = audio.createOscillator(), g = audio.createGain();
          o.frequency.value = s[0]; o.connect(g); g.connect(audio.destination);
          g.gain.value = 0.2; o.start(t); o.stop(t + s[1]); t += s[1] + 0.08;
        });
      } catch (e) {}
    }

    async function loadJsQR() {
      if (typeof jsQR !== "undefined") { jsqrReady = true; return true; }
      const urls = ["./jsQR.min.js", "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js"];
      for (const u of urls) {
        try {
          const r = await fetch(u);
          if (!r.ok) continue;
          const code = await r.text();
          const s = document.createElement("script");
          s.textContent = code;
          document.head.appendChild(s);
          if (typeof jsQR !== "undefined") { jsqrReady = true; return true; }
        } catch (e) {}
      }
      return false;
    }

    function setStatus() {
      const s = core.stats(), online = navigator.onLine;
      $("net").textContent = online ? "EN LIGNE" : "HORS LIGNE";
      $("net").className = "pill " + (online ? "on" : "off");
      $("used").textContent = s.used; $("left").textContent = s.remaining; $("total").textContent = s.total;
      $("pending").textContent = s.pending ? s.pending + " entrée(s) hors ligne à envoyer" : "Tout est synchronisé";
      $("pending").className = s.pending ? "warn" : "okline";
      const c = s.conflicts;
      $("conflicts").style.display = c.length ? "block" : "none";
      if (c.length) $("conftext").textContent = "À vérifier (" + c.length + ") : " + c.map(function (x) { return (x.number || x.qr) + " [" + x.result + "]"; }).join(", ");
    }

    function showResult(r) {
      const o = $("overlay");
      let cls = "unk", title = "BILLET INCONNU", sub = "Ne pas laisser entrer sans contrôle", tone = "unk";
      if (r.result === "VALIDE") { cls = "ok"; title = "ENTRÉE VALIDÉE"; sub = ""; tone = "ok"; }
      else if (r.result === "DEJA_UTILISE") { cls = "dup"; title = "DÉJÀ UTILISÉ"; sub = "Entré le " + (r.usedAt || "?"); tone = "dup"; }
      else if (r.result === "ERREUR_PIN") { cls = "unk"; title = "PIN REFUSÉ"; sub = "Verrouille puis rouvre l'appli"; }
      o.className = "overlay " + cls;
      $("rtitle").textContent = title;
      $("rnum").textContent = r.number || "";
      $("rcat").textContent = r.category || "";
      $("rsub").textContent = sub;
      $("rsrc").textContent = r.source === "hors ligne" ? "Décision hors ligne (sera envoyée plus tard)" : "";
      o.style.display = "flex";
      beep(tone);
      clearTimeout(dismissTimer);
      dismissTimer = setTimeout(dismiss, r.result === "VALIDE" ? 2500 : 6000);
    }

    function dismiss() {
      clearTimeout(dismissTimer);
      $("overlay").style.display = "none";
      lastTime = Date.now();
      if (core.isUnlocked()) { scanning = true; tick(); }
    }

    async function onDetect(text) {
      if (text === lastText && Date.now() - lastTime < 3000) { setTimeout(tick, 150); return; }
      scanning = false; lastText = text; lastTime = Date.now();
      $("hint").textContent = "Vérification…";
      const r = await core.scan(text);
      $("hint").textContent = "Place le QR code dans le cadre";
      setStatus();
      showResult(r);
    }

    function tick() {
      if (!scanning) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, 720 / video.videoWidth);
        const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
        canvas.width = w; canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
        if (code && code.data) { onDetect(code.data); return; }
      }
      setTimeout(function () { requestAnimationFrame(tick); }, 80);
    }

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        video.srcObject = stream; await video.play();
        scanning = true; tick();
      } catch (e) {
        $("hint").textContent = "Caméra indisponible : autorise la caméra dans Réglages > Safari (ou l'appli) puis rouvre.";
      }
    }

    function stopCamera() {
      scanning = false;
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    }

    async function doSync(manual) {
      const r = await core.syncQueue();
      if (r.sent && navigator.onLine) await core.refreshList();
      setStatus();
      if (manual) $("hint").textContent = r.error ? "Synchronisation impossible pour l'instant" : "Synchronisation faite";
    }

    $("go").addEventListener("click", async function () {
      const p = $("pin").value.trim();
      if (!p) return;
      $("lockmsg").textContent = "Connexion…";
      initAudio();
      const r = await core.unlock(p);
      if (r.status === "bad-pin") { $("lockmsg").textContent = "PIN incorrect"; return; }
      if (r.status === "blocked") { $("lockmsg").textContent = "Trop d'essais : attends 10 minutes"; return; }
      if (r.status === "need-online") { $("lockmsg").textContent = "Première ouverture : connecte-toi à Internet"; return; }
      $("pin").value = "";
      $("lock").style.display = "none"; $("app").style.display = "flex";
      setStatus();
      if (!(await loadJsQR())) { $("hint").textContent = "Lecteur QR non chargé : connecte-toi à Internet puis rouvre l'appli"; return; }
      startCamera();
    });
    $("pin").addEventListener("keydown", function (e) { if (e.key === "Enter") $("go").click(); });
    $("lockbtn").addEventListener("click", function () {
      core.lock(); stopCamera(); $("app").style.display = "none"; $("lock").style.display = "flex"; $("lockmsg").textContent = "";
    });
    $("syncbtn").addEventListener("click", function () { doSync(true); });
    $("clearconf").addEventListener("click", function () { core.clearConflicts(); setStatus(); });
    $("exportbtn").addEventListener("click", function () {
      const blob = new Blob(["\ufeff" + core.exportCsv()], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "entrees_undercover_showroom.csv";
      document.body.appendChild(a); a.click(); a.remove();
    });
    $("overlay").addEventListener("click", dismiss);
    window.addEventListener("online", function () { if (core.isUnlocked()) doSync(false); setStatus(); });
    window.addEventListener("offline", setStatus);
    setInterval(function () { if (core.isUnlocked() && navigator.onLine && core.stats().pending) doSync(false); else if (core.isUnlocked()) setStatus(); }, 20000);

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(function () {});
    window.__uc = { core: core };
  })();
}
