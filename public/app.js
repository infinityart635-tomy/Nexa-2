/* NEXA POS Wi-Fi - v9
   Frontend helper: WebSocket sync + small utilities.
*/
(function(){
  const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

  const listeners = new Set();
  const msgListeners = new Set();
  let ws = null;
  let db = null;
  let publicState = null;
  let hello = { role: "cliente", name: "Cliente" };
  let connected = false;
  const NOTIF_KEY = "resto_notifications";
  const NOTIF_SEEN_KEY = "resto_notifications_seen";
  const MOZO_REQUEST_NOTIFIED_KEY = "nexa_mozo_request_notified";
  const THEME_KEY = "nexa_theme";
  const ACTIVITY_KEY = "nexa_last_active_at";
  const PWA_DISMISSED_KEY = "nexa_pwa_install_dismissed";
  const UPDATE_DISMISSED_KEY = "nexa_update_dismissed_build";
  const THEMES = ["noir","ember","mint","cobalt","sand"];
  let notifications = [];
  let installPromptEvent = null;
  let currentBuildId = "";
  let pendingBuildId = "";

  function roleRank(role){
    role = String(role || "anon");
    if(role === "admin") return 4;
    if(role === "mozo") return 3;
    if(role === "account") return 2;
    if(role === "cliente") return 1;
    return 0;
  }

  function isAuthScreen(){
    const path = (location && location.pathname ? location.pathname : "").toLowerCase();
    return path === "/login.html" || path === "/login" || path === "/";
  }

  function loadNotifications(){
    try{
      const raw = localStorage.getItem(NOTIF_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      notifications = Array.isArray(arr) ? arr : [];
    }catch{
      notifications = [];
    }
  }
  function saveNotifications(){
    try{ localStorage.setItem(NOTIF_KEY, JSON.stringify(notifications.slice(0,100))); }catch{}
  }
  function addNotification(n){
    const incomingId = n && n.id ? String(n.id) : "";
    if(incomingId && notifications.some(item => String(item && item.id || "") === incomingId)) return;
    const item = {
      id: incomingId || (Date.now()+"-"+Math.random().toString(36).slice(2,6)),
      text: String(n.text||""),
      kind: String(n.kind||"info"),
      by: String(n.by||""),
      at: Number(n.at||Date.now()),
      data: n.data || {}
    };
    notifications.unshift(item);
    if(notifications.length > 100) notifications.length = 100;
    saveNotifications();
    window.dispatchEvent(new CustomEvent("resto:notify", { detail: item }));
  }
  function getNotifications(){ return notifications.slice(); }
  function clearNotifications(){
    notifications = [];
    saveNotifications();
    window.dispatchEvent(new CustomEvent("resto:notify", { detail: null }));
  }
  function getSeenAt(){
    try{ return Number(localStorage.getItem(NOTIF_SEEN_KEY) || 0); }catch{ return 0; }
  }
  function setSeenAt(ts){
    try{ localStorage.setItem(NOTIF_SEEN_KEY, String(ts||Date.now())); }catch{}
  }

  function emit(){
    listeners.forEach(fn => { try{ fn(db, connected); }catch(e){} });
    updateCashGateBanner();
  }

  function applyTheme(id){
    const theme = THEMES.includes(id) ? id : "noir";
    document.documentElement.setAttribute("data-theme", theme);
    return theme;
  }
  function getTheme(){
    try{ return localStorage.getItem(THEME_KEY) || "noir"; }catch{ return "noir"; }
  }
  function setTheme(id){
    const theme = applyTheme(id);
    try{ localStorage.setItem(THEME_KEY, theme); }catch{}
    return theme;
  }
  applyTheme(getTheme());

  function applyNavGroupColors(){
    const map = {
      operacion: "navOp",
      catalogo: "navCat",
      gestion: "navGest",
      perfil: "navPerfil"
    };
    document.querySelectorAll(".navGroup").forEach(group=>{
      const label = group.querySelector(".navLabel");
      if(!label) return;
      const key = String(label.textContent || "").trim().toLowerCase();
      const cls = map[key];
      if(cls) group.classList.add(cls);
    });
  }
  function ymdLocal(d = new Date()){
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  function getDayCloseCutoffMinutes(db){
    const hour = Number(db && db.settings && db.settings.cash && db.settings.cash.dayCloseCutoffHour);
    const safeHour = Number.isFinite(hour) ? Math.max(0, Math.min(23.99, hour)) : 2;
    return Math.round(safeHour * 60);
  }
  function getBusinessDateKey(db, ts = Date.now()){
    const cutoffMinutes = getDayCloseCutoffMinutes(db);
    if (cutoffMinutes <= 0) return ymdLocal(new Date(ts));
    const d = new Date(ts);
    const minutes = d.getHours() * 60 + d.getMinutes();
    const base = ymdLocal(d);
    if (minutes > cutoffMinutes) return base;
    const back = new Date(d.getTime() - 86400000);
    return ymdLocal(back);
  }
  function ensureCashGateBanner(){
    let el = document.getElementById("cashGateBanner");
    if(el) return el;
    el = document.createElement("div");
    el.id = "cashGateBanner";
    el.className = "cashGateBanner";
    el.innerHTML = `
      <div class="cashGateInner">
        <div class="cashGateTitle">CAJA CERRADA</div>
        <div class="cashGateText">Debes abrir la caja antes de empezar.</div>
        <a class="cashGateBtn" href="/admin_caja_test.html">Ir a Caja/Cierre</a>
      </div>
    `;
    document.body.appendChild(el);
    return el;
  }
  function updateCashGateBanner(){
    if(isAuthScreen()) return;
    const el = ensureCashGateBanner();
    const path = (location && location.pathname) ? location.pathname.toLowerCase() : "";
    if(path === "/admin_stats.html" || path === "/admin_caja.html" || path === "/admin_caja_test.html"){
      el.style.display = "none";
      return;
    }
    if(db){
      const turns = (db.cash && Array.isArray(db.cash.turns)) ? db.cash.turns : [];
      const sessions = (db.cash && Array.isArray(db.cash.sessions)) ? db.cash.sessions : [];
      const openTurnAny = turns.some(t=>t && !t.closedAt && !t.locked);
      const openSessionAny = sessions.some(s=>s && !s.closedAt);
      if(openTurnAny || openSessionAny){
        el.style.display = "none";
        return;
      }
      const businessKey = getBusinessDateKey(db, Date.now());
      const openTurn = turns.some(t=>t && t.dateKey === businessKey && !t.closedAt && !t.locked);
      const openSession = sessions.some(s=>s && s.dateKey === businessKey && !s.closedAt);
      const closures = Array.isArray(db.dayClosures) ? db.dayClosures : [];
      const closed = closures.some(c=>c && c.dateKey === businessKey);
      el.style.display = ((!openTurn && !openSession) || closed) ? "block" : "none";
      return;
    }
    const today = ymdLocal();
    const status = publicState && publicState.cashStatus ? publicState.cashStatus : null;
    if(status && status.openAny){
      el.style.display = "none";
      return;
    }
    if(!status || status.dateKey !== today){
      el.style.display = "none";
      return;
    }
    el.style.display = (!status.open || status.closed) ? "block" : "none";
  }
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", applyNavGroupColors);
  } else {
    applyNavGroupColors();
  }
  function applyRoleNav(){
    fetch("/api/auth/me", { cache: "no-store" })
      .then(r=>r.json())
      .then(me=>{
        if(me && me.role === "admin"){
          document.querySelectorAll('a[href="/menu.html"]').forEach(a=>a.style.display="none");
        }
      })
      .catch(()=>{});
  }
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", applyRoleNav);
  } else {
    applyRoleNav();
  }
  function markActivity(){
    try{ localStorage.setItem(ACTIVITY_KEY, String(Date.now())); }catch{}
  }
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) markActivity(); });
  window.addEventListener("focus", markActivity);
  document.addEventListener("click", markActivity, { passive: true });
  document.addEventListener("keydown", markActivity);
  setInterval(()=>{ if(!document.hidden) markActivity(); }, 60000);
  markActivity();

  function connect(role, name){
    hello = { role: role || "anon", name: name || "Anonimo" };
    if(ws && (ws.readyState === 0 || ws.readyState === 1)) return;

    ws = new WebSocket(WS_URL);
    ws.addEventListener("open", () => {
      connected = true;
      ws.send(JSON.stringify({ type: "hello", role: hello.role, name: hello.name, app: "nexa-pos-wifi", version: "v9" }));
      ws.send(JSON.stringify({ type: "state:request" }));
      emit();
    });
    ws.addEventListener("close", () => {
      connected = false;
      emit();
      setTimeout(()=>connect(hello.role, hello.name), 1000);
    });
    ws.addEventListener("message", (ev) => {
      let msg = null;
      try{ msg = JSON.parse(ev.data); }catch{ return; }
      if(msg.type === "state" && msg.db){
        db = msg.db;
        emit();
        return;
      }
      if(msg.type === "public" && msg.menu){
        publicState = msg.menu;
        emit();
        return;
      }
      if(msg.type === "hello:ok"){
        window.dispatchEvent(new CustomEvent("resto:hello", { detail: msg }));
        if(roleRank(msg.role) < roleRank(hello.role)){
          toast("Tu sesion no tiene permiso para esta pantalla. Vuelve a entrar al restaurante.", "warn");
        }
        return;
      }
      if(msg.type === "action:error"){
        const need = msg.needRole ? ` (${msg.needRole})` : "";
        const text = msg.error === "forbidden"
          ? `No tienes permiso para guardar esta accion${need}.`
          : `No se pudo guardar: ${msg.error || "error"}.`;
        toast(text, "warn");
        window.dispatchEvent(new CustomEvent("resto:action-error", { detail: msg }));
        return;
      }
      if(msg.type === "action:ok"){
        window.dispatchEvent(new CustomEvent("resto:action-ok", { detail: msg }));
        return;
      }
      if(msg.type === "notify" && msg.text){
        addNotification(msg);
        if(!msg.by || msg.by !== hello.name) toast(msg.text, msg.kind);
        return;
      }
      // Otros mensajes (por ejemplo: customer:request)
      msgListeners.forEach(fn => { try{ fn(msg); }catch(e){} });
    });
  }

  function onState(fn){
    listeners.add(fn);
    if(db !== null) fn(db, connected);
    return ()=>listeners.delete(fn);
  }

  function onMessage(fn){
    msgListeners.add(fn);
    return ()=>msgListeners.delete(fn);
  }

  function sendAction(kind, payload){
    if(!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: "action", kind, payload: payload || {} }));
    return true;
  }

  function money(n, currency){
    const v = Number(n || 0);
    const cur = currency || (db && db.settings && db.settings.currency) || "ARS";
    try{
      return new Intl.NumberFormat("es-AR", { style:"currency", currency: cur, maximumFractionDigits: 0 }).format(v);
    }catch{
      return `$${Math.round(v)}`;
    }
  }

  function byId(id){ return document.getElementById(id); }

  function esc(s){
    return String(s||"").replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }

  function toast(text, kind){
    const el = document.createElement("div");
    const k = String(kind || "");
    el.className = "toast" + (k ? (" " + k) : "");
    el.textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(()=>el.classList.add("show"));
    setTimeout(()=>{ el.classList.remove("show"); setTimeout(()=>el.remove(), 250); }, 2600);
  }

  function isStandaloneApp(){
    try{
      return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    }catch{
      return false;
    }
  }
  function isInstallEligibleContext(){
    return location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  }
  function loadMozoRequestNotified(){
    try{
      const arr = JSON.parse(localStorage.getItem(MOZO_REQUEST_NOTIFIED_KEY) || "[]");
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    }catch{
      return new Set();
    }
  }
  function saveMozoRequestNotified(set){
    try{ localStorage.setItem(MOZO_REQUEST_NOTIFIED_KEY, JSON.stringify(Array.from(set).slice(-300))); }catch{}
  }
  async function syncPendingMozoRequestNotifications(){
    try{
      const r = await fetch("/api/auth/profile", { cache: "no-store" });
      if(!r.ok) return;
      const profile = await r.json();
      const pending = Array.isArray(profile && profile.pendingRequests) ? profile.pendingRequests : [];
      if(!pending.length) return;
      const seen = loadMozoRequestNotified();
      let changed = false;
      pending.forEach(req => {
        const id = String((req && req.id) || "");
        if(!id || seen.has(id)) return;
        const requesterUser = req && req.user ? req.user : {};
        const requester = String((requesterUser && (requesterUser.name || requesterUser.username || requesterUser.email)) || "Un usuario");
        const restaurant = String((req && req.restaurantName) || "tu comercio");
        addNotification({
          id: "mozo-request:" + id,
          text: `${requester} solicito acceso como mozo a ${restaurant}`,
          kind: "warn",
          by: "NEXA",
          data: { action: "mozo:request", requestId: id, restaurantId: req && req.restaurantId }
        });
        seen.add(id);
        changed = true;
      });
      if(changed) saveMozoRequestNotified(seen);
    }catch{}
  }
  function registerAppCache(){
    if(!isInstallEligibleContext() || !("serviceWorker" in navigator)) return;
    window.addEventListener("load", ()=>{
      navigator.serviceWorker.register("/sw.js").catch(()=>{});
    }, { once: true });
  }
  function ensurePwaHead(){
    if(!document.querySelector('link[rel="manifest"]')){
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = "/manifest.webmanifest";
      document.head.appendChild(link);
    }
    if(!document.querySelector('meta[name="theme-color"]')){
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = "#121212";
      document.head.appendChild(meta);
    }
    if(!document.querySelector('link[rel="icon"]')){
      const icon = document.createElement("link");
      icon.rel = "icon";
      icon.href = "/icons/icon-192.png";
      icon.type = "image/png";
      document.head.appendChild(icon);
    }
  }
  function ensureInstallPrompt(){
    if(document.getElementById("pwaInstallCard")) return document.getElementById("pwaInstallCard");
    const card = document.createElement("div");
    card.id = "pwaInstallCard";
    card.className = "pwaInstallCard";
    card.style.display = "none";
    card.innerHTML = `
      <div class="pwaInstallTitle">Instalar NEXA</div>
      <div class="pwaInstallText">Puedes agregar la app al escritorio y abrirla como programa.</div>
      <div class="pwaInstallActions">
        <button class="btn primary" id="pwaInstallBtn" type="button">Instalar</button>
        <button class="btn" id="pwaInstallClose" type="button">Ahora no</button>
      </div>
    `;
    document.body.appendChild(card);
    document.getElementById("pwaInstallBtn").addEventListener("click", triggerInstallPrompt);
    document.getElementById("pwaInstallClose").addEventListener("click", ()=>{
      try{ localStorage.setItem(PWA_DISMISSED_KEY, String(Date.now())); }catch{}
      hideInstallPrompt();
    });
    return card;
  }
  function showInstallPrompt(){
    const card = ensureInstallPrompt();
    if(!installPromptEvent || isStandaloneApp() || !isInstallEligibleContext()) return;
    card.style.display = "block";
  }
  function hideInstallPrompt(){
    const card = document.getElementById("pwaInstallCard");
    if(card) card.style.display = "none";
  }
  async function triggerInstallPrompt(){
    if(!installPromptEvent) return;
    hideInstallPrompt();
    const promptEvent = installPromptEvent;
    installPromptEvent = null;
    promptEvent.prompt();
    try{
      const choice = await promptEvent.userChoice;
      if(choice && choice.outcome === "accepted"){
        toast("NEXA se agrego al escritorio.", "success");
      } else {
        try{ localStorage.setItem(PWA_DISMISSED_KEY, String(Date.now())); }catch{}
      }
    }catch{}
  }
  function registerPwa(){
    ensurePwaHead();
    registerAppCache();
    if(!isInstallEligibleContext() || isStandaloneApp()) return;
    window.addEventListener("beforeinstallprompt", (ev)=>{
      ev.preventDefault();
      installPromptEvent = ev;
      const dismissedAt = Number(localStorage.getItem(PWA_DISMISSED_KEY) || 0);
      if(!dismissedAt || (Date.now() - dismissedAt) > 86400000){
        showInstallPrompt();
      }
    });
    window.addEventListener("appinstalled", ()=>{
      installPromptEvent = null;
      hideInstallPrompt();
      try{ localStorage.removeItem(PWA_DISMISSED_KEY); }catch{}
      toast("App instalada correctamente.", "success");
    });
  }
  function ensureUpdatePrompt(){
    if(document.getElementById("appUpdateCard")) return document.getElementById("appUpdateCard");
    const card = document.createElement("div");
    card.id = "appUpdateCard";
    card.className = "appUpdateCard";
    card.style.display = "none";
    card.innerHTML = `
      <div class="appUpdateTitle">Actualizacion disponible</div>
      <div class="appUpdateText">Hay una version nueva de NEXA lista para usar.</div>
      <div class="appUpdateActions">
        <button class="btn primary" id="appUpdateBtn" type="button">Actualizar</button>
        <button class="btn" id="appUpdateClose" type="button">Despues</button>
      </div>
    `;
    document.body.appendChild(card);
    document.getElementById("appUpdateBtn").addEventListener("click", forceAppRefresh);
    document.getElementById("appUpdateClose").addEventListener("click", ()=>{
      if(pendingBuildId){
        try{ localStorage.setItem(UPDATE_DISMISSED_KEY, pendingBuildId); }catch{}
      }
      hideUpdatePrompt();
    });
    return card;
  }
  function showUpdatePrompt(){
    const card = ensureUpdatePrompt();
    card.style.display = "block";
  }
  function hideUpdatePrompt(){
    const card = document.getElementById("appUpdateCard");
    if(card) card.style.display = "none";
  }
  async function forceAppRefresh(){
    const btn = document.getElementById("appUpdateBtn");
    if(btn){
      btn.disabled = true;
      btn.textContent = "Actualizando...";
    }
    hideUpdatePrompt();
    try{
      if("serviceWorker" in navigator){
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(reg => reg.unregister().catch(()=>false)));
      }
      if("caches" in window){
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key).catch(()=>false)));
      }
    }catch{}
    try{ localStorage.removeItem(UPDATE_DISMISSED_KEY); }catch{}
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set("_update", String(Date.now()));
    location.replace(nextUrl.toString());
  }
  function handleBuildInfo(info){
    const buildId = String((info && info.buildId) || "").trim();
    if(!buildId) return;
    if(!currentBuildId){
      currentBuildId = buildId;
      return;
    }
    if(buildId === currentBuildId) return;
    pendingBuildId = buildId;
    const dismissedBuild = (()=>{ try{ return localStorage.getItem(UPDATE_DISMISSED_KEY) || ""; }catch{ return ""; } })();
    if(dismissedBuild === buildId) return;
    showUpdatePrompt();
  }

  // Aviso global de caja/turno abierto al reabrir la app
  const CASH_NOTICE_KEY = "nexa_cash_open_notice";
  async function checkCashOpenNotice(){
    if(isAuthScreen()) return;
    try{
      const r = await fetch("/api/info", { cache: "no-store" });
      if(!r.ok) return;
      const j = await r.json();
      handleBuildInfo(j);
      const cs = j && j.cashStatus ? j.cashStatus : null;
      if(!cs || !cs.openAny) return;
      const key = `${cs.dateKey}|open`;
      if(localStorage.getItem(CASH_NOTICE_KEY) === key) return;
      localStorage.setItem(CASH_NOTICE_KEY, key);
      toast("Aviso: hay un turno/caja abierto al reabrir.", "warn");
    }catch(e){}
  }


  function formatWhen(ts){
    try{ return new Date(ts||Date.now()).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"}); }catch{ return ""; }
  }
  function ensureNotifDock(){
    if(isAuthScreen()) return;
    if(document.getElementById("notifDock")) return;
    const dock = document.createElement("div");
    dock.id = "notifDock";
    dock.className = "notifDock";
    dock.innerHTML = `
      <button class="notifBtn" id="notifBtn" type="button" aria-label="Avisos">
        Avisos <span class="notifBadge" id="notifBadge" style="display:none;">0</span>
      </button>
      <div class="notifPanelMini card" id="notifPanelMini" style="display:none;">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <div style="font-weight:900;">Avisos</div>
          <button class="btn" id="notifClose" type="button">Cerrar</button>
        </div>
        <div class="hr" style="margin-top:10px;"></div>
        <div id="notifListMini" class="mini" style="max-height:40vh; overflow:auto;"></div>
        <div class="row" style="margin-top:10px;">
          <button class="btn" id="notifClear" type="button" style="flex:1;">Limpiar</button>
        </div>
      </div>
    `;
    document.body.appendChild(dock);

    const btn = document.getElementById("notifBtn");
    const panel = document.getElementById("notifPanelMini");
    const badge = document.getElementById("notifBadge");
    const list = document.getElementById("notifListMini");

    function render(){
      const seenAt = getSeenAt();
      const arr = getNotifications();
      const unread = arr.filter(n=>Number(n.at||0) > seenAt).length;
      if(badge){
        badge.style.display = unread ? "" : "none";
        badge.textContent = String(unread);
      }
      if(btn){
        btn.classList.toggle("hot", unread > 0);
      }
      if(list){
        if(!arr.length){
          list.textContent = "Sin avisos.";
        } else {
          list.innerHTML = arr.slice(0,40).map(n=>{
            return `<div class="notifRow ${esc(n.kind||"")}" style="margin:6px 0;">
              <div style="font-weight:800;">${esc(n.text)}</div>
              <div class="small">${esc(formatWhen(n.at))} - ${esc(n.by||"")}</div>
            </div>`;
          }).join("");
        }
      }
    }

    render();

    btn.addEventListener("click", ()=>{
      const open = panel.style.display !== "none";
      panel.style.display = open ? "none" : "block";
      if(!open){
        setSeenAt(Date.now());
        render();
      }
    });
    document.getElementById("notifClose").addEventListener("click", ()=>{
      panel.style.display = "none";
    });
    document.getElementById("notifClear").addEventListener("click", ()=>{
      clearNotifications();
      setSeenAt(Date.now());
      render();
    });

    window.addEventListener("resto:notify", render);
  }

  loadNotifications();
  setTimeout(syncPendingMozoRequestNotifications, 1800);
  setInterval(syncPendingMozoRequestNotifications, 60000);
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", ()=>{
      ensureNotifDock();
      registerPwa();
    });
  }else{
    ensureNotifDock();
    registerPwa();
  }
  window.RestoApp = { connect, onState, onMessage, sendAction, money, byId, esc, toast, getNotifications, clearNotifications, setTheme, getTheme, themes: THEMES.slice() };

  // Chequeo periodico (todas las pantallas)
  setTimeout(checkCashOpenNotice, 1200);
  setInterval(checkCashOpenNotice, 60000);
})();
