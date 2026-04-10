/* NEXA POS Wi‑Fi · v9
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
  const THEME_KEY = "nexa_theme";
  const ACTIVITY_KEY = "nexa_last_active_at";
  const THEMES = ["noir","ember","mint","cobalt","sand"];
  let notifications = [];

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
    const item = {
      id: n.id || (Date.now()+"-"+Math.random().toString(36).slice(2,6)),
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
    hello = { role: role || "anon", name: name || "Anónimo" };
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

  // Aviso global de caja/turno abierto al reabrir la app
  const CASH_NOTICE_KEY = "nexa_cash_open_notice";
  async function checkCashOpenNotice(){
    try{
      const r = await fetch("/api/info", { cache: "no-store" });
      if(!r.ok) return;
      const j = await r.json();
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
              <div class="small">${esc(formatWhen(n.at))} · ${esc(n.by||"")}</div>
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
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", ()=>{
      ensureNotifDock();
    });
  }else{
    ensureNotifDock();
  }
  window.RestoApp = { connect, onState, onMessage, sendAction, money, byId, esc, toast, getNotifications, clearNotifications, setTheme, getTheme, themes: THEMES.slice() };

  // Chequeo periódico (todas las pantallas)
  setTimeout(checkCashOpenNotice, 1200);
  setInterval(checkCashOpenNotice, 60000);
})();
