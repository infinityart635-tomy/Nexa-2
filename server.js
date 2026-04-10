require("dotenv").config({ quiet: true });
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const WebSocket = require("ws");
const QRCode = require("qrcode");
const { getFiscalProvider } = require("./fiscal/provider");
const { buildArcaQrUrl } = require("./fiscal/utils");
const { buildFiscalDocPayload, formatFiscalDocText } = require("./fiscal/payload");
const {
  blobUrlToKey,
  createPostgresStorage,
  mimeToExtension,
  parseDataUrl,
  seedPostgresFromDisk,
} = require("./postgres_storage");
const PACKAGE_JSON = require("./package.json");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const STORAGE_MODE = process.env.DATABASE_URL ? "postgres" : "file";
const APP_VERSION = String(PACKAGE_JSON.version || "0.0.0");
const SERVER_BUILD_ID =
  String(
    process.env.RAILWAY_DEPLOYMENT_ID ||
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.SOURCE_VERSION ||
    `local-${Date.now()}`
  );
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const FISCAL_ATTACH_DIR = path.join(IMAGES_DIR, "fiscal");

fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(FISCAL_ATTACH_DIR, { recursive: true });

const MENU_FILE = path.join(DATA_DIR, "menu.json");
const DB_FILE = path.join(DATA_DIR, "db.json");
let MENU = { currency: "ARS", categories: [] };
let STORAGE = { mode: "file", close: async () => {} };

const DEFAULT_TABLE_LAYOUT = {
  cols: 8,
  baseW: 96,
  baseH: 72,
  gapX: 18,
  gapY: 16,
  startX: 20,
  startY: -120,
};
const LEGACY_TABLE_LAYOUT = {
  cols: 8,
  baseW: 96,
  baseH: 72,
  gapX: 18,
  gapY: 16,
  startX: 20,
  startY: 20,
};

function defaultTableLayout(index, layout = DEFAULT_TABLE_LAYOUT) {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return {
    x: layout.startX + col * (layout.baseW + layout.gapX),
    y: layout.startY + row * (layout.baseH + layout.gapY),
    w: layout.baseW,
    h: layout.baseH,
  };
}

function tablesMatchLayout(tables, layout = DEFAULT_TABLE_LAYOUT) {
  if (!Array.isArray(tables)) return false;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (!t) return false;
    const pos = defaultTableLayout(i, layout);
    if (Number(t.x) !== pos.x || Number(t.y) !== pos.y) return false;
    if (Number(t.w) !== pos.w || Number(t.h) !== pos.h) return false;
    if (t.shape !== "square") return false;
    if (t.locked !== false) return false;
  }
  return true;
}

function applyDefaultTableLayout(tables, layout = DEFAULT_TABLE_LAYOUT) {
  if (!Array.isArray(tables)) return;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (!t) continue;
    const pos = defaultTableLayout(i, layout);
    t.x = pos.x;
    t.y = pos.y;
    t.w = pos.w;
    t.h = pos.h;
    t.shape = "square";
    t.locked = false;
    t.zone = "SalИn";
    t.updatedAt = now();
  }
}

// ------------------ Utils ------------------
function uid() {
  return Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

function now() { return Date.now(); }

function ymd(ts = Date.now()) {
  const d = new Date(ts);
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
  if (cutoffMinutes <= 0) return ymd(ts);
  const d = new Date(ts);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes >= cutoffMinutes) return ymd(ts);
  d.setDate(d.getDate() - 1);
  return ymd(d.getTime());
}

function computeCashStatus(db){
  const dateKey = getBusinessDateKey(db);
  const turns = (db && db.cash && Array.isArray(db.cash.turns)) ? db.cash.turns : [];
  const sessions = (db && db.cash && Array.isArray(db.cash.sessions)) ? db.cash.sessions : [];
  const openTurn = turns.some(t=>t && t.dateKey === dateKey && !t.closedAt && !t.locked);
  const openSession = sessions.some(s=>s && s.dateKey === dateKey && !s.closedAt);
  const open = openTurn || openSession;
  const openAny = turns.some(t=>t && !t.closedAt && !t.locked) || sessions.some(s=>s && !s.closedAt);
  const closures = Array.isArray(db && db.dayClosures) ? db.dayClosures : [];
  const closed = closures.some(c=>c && c.dateKey === dateKey);
  return { dateKey, open, closed, openAny };
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function atomicWriteJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || "item";
}

async function removeStoredImage(url) {
  if (!url || typeof url !== "string") return;
  if (!url.startsWith("/images/")) return;
  if (STORAGE && STORAGE.mode === "postgres") {
    try {
      await STORAGE.deleteBlob(blobUrlToKey(url));
    } catch {}
  }
  const rel = url.replace("/images/", "");
  const abs = path.join(IMAGES_DIR, rel);
  if (!abs.startsWith(IMAGES_DIR)) return;
  try { fs.unlinkSync(abs); } catch {}
}

async function saveProductImage(productId, dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return "";
  const mime = String(parsed.mimeType || "").toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/jpg" && mime !== "image/webp") return "";
  const ext = mimeToExtension(mime);
  if (!ext) return "";
  const safeId = String(productId || "product").replace(/[^a-z0-9_-]/gi, "").slice(0, 48) || "product";
  const filename = `${safeId}_${Date.now()}.${ext}`;
  if (STORAGE && STORAGE.mode === "postgres") {
    await STORAGE.saveBlob(`images/${filename}`, mime, parsed.buffer, { isPrivate: false });
    return `/images/${filename}`;
  }
  const abs = path.join(IMAGES_DIR, filename);
  if (!abs.startsWith(IMAGES_DIR)) return "";
  fs.writeFileSync(abs, parsed.buffer);
  return `/images/${filename}`;
}

async function saveFiscalAttachment(dataUrl, name) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return "";
  const mime = String(parsed.mimeType || "").toLowerCase();
  if (mime !== "application/pdf" && mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/jpg" && mime !== "image/webp") return "";
  const ext = mimeToExtension(mime);
  if (!ext) return "";
  if (parsed.buffer.length > 1500000) return ""; // ~1.5MB
  const safe = String(name || "adjunto").replace(/[^a-z0-9_.-]/gi, "").slice(0, 40) || "adjunto";
  const filename = `${safe}_${Date.now()}_${uid().slice(0, 6)}.${ext}`;
  if (STORAGE && STORAGE.mode === "postgres") {
    await STORAGE.saveBlob(`images/fiscal/${filename}`, mime, parsed.buffer, { isPrivate: true });
    return `/images/fiscal/${filename}`;
  }
  const abs = path.join(FISCAL_ATTACH_DIR, filename);
  if (!abs.startsWith(FISCAL_ATTACH_DIR)) return "";
  fs.writeFileSync(abs, parsed.buffer);
  return `/images/fiscal/${filename}`;
}



// ------------------ Auth (roles + sesiones) ------------------
const restaurantContext = new AsyncLocalStorage();
let ROOT_DB = null;

function parseCookies(req){
  const header = String((req && req.headers && req.headers.cookie) || "");
  const out = {};
  header.split(/;\s*/).forEach(part=>{
    const i = part.indexOf('=');
    if(i<=0) return;
    const k = part.slice(0,i).trim();
    const v = part.slice(i+1).trim();
    if(!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function getBearer(req){
  const h = String((req && req.headers && (req.headers.authorization || req.headers.Authorization)) || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function getAuthToken(req){
  const cookies = parseCookies(req);
  const tok = cookies.nexa_token || getBearer(req);
  return String(tok||"");
}

function roleRank(role){
  role = String(role||"anon");
  if(role === 'admin') return 4;
  if(role === 'mozo') return 3;
  if(role === 'account') return 2;
  if(role === 'cliente') return 1;
  return 0;
}

function hasMinRole(role, minRole){
  return roleRank(role) >= roleRank(minRole);
}

function ensureAuthDefaults(root = ROOT_DB){
  if(!root) return;
  if(!root.auth || typeof root.auth !== "object") root.auth = { salt: uid(), sessionTTLHours: 72 };
  if(!root.auth.salt) root.auth.salt = uid();
  if(root.auth.sessionTTLHours === undefined) root.auth.sessionTTLHours = 72;
  if(!Array.isArray(root.users)) root.users = [];
  if(!Array.isArray(root.sessions)) root.sessions = [];
  if(!Array.isArray(root.restaurants)) root.restaurants = [];
  if(!Array.isArray(root.restaurantMemberships)) root.restaurantMemberships = [];
  if(!root.restaurantData || typeof root.restaurantData !== "object" || Array.isArray(root.restaurantData)) root.restaurantData = {};
}

function runWithRestaurantContext(restaurantId, fn){
  return restaurantContext.run({ restaurantId: String(restaurantId || "") }, fn);
}

function getRestaurantContextId(){
  const store = restaurantContext.getStore();
  return store && store.restaurantId ? String(store.restaurantId) : "";
}

function hashPass(pass, salt){
  return crypto.createHash('sha256').update(String(salt||'') + '|' + String(pass||'')).digest('hex');
}

function normalizeAccountRole(role){
  role = String(role || "").toLowerCase();
  return (role === "admin" || role === "mozo" || role === "account" || role === "cliente") ? role : "";
}

function normalizeRestaurantMemberRole(role){
  role = String(role || "").toLowerCase();
  return (role === "owner" || role === "mozo") ? role : "";
}

function normalizeUserName(value){
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 48);
}

function normalizeAuthUsername(value){
  return String(value || "").trim().replace(/\s+/g, "").slice(0, 32);
}

function authUsernameKey(value){
  return normalizeAuthUsername(value).toLowerCase();
}

function normalizeAuthEmail(value){
  return String(value || "").trim().toLowerCase().slice(0, 80);
}

function authEmailKey(value){
  return normalizeAuthEmail(value);
}

function normalizeAuthIdentifier(value){
  return String(value || "").trim().toLowerCase().slice(0, 80);
}

function normalizeSecurityQuestion(value){
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function normalizeSecurityAnswer(value){
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 120);
}

function sanitizeUser(user){
  if(!user) return null;
  return {
    id: String(user.id || ""),
    name: normalizeUserName(user.name || ""),
    username: normalizeAuthUsername(user.username || ""),
    email: normalizeAuthEmail(user.email || ""),
    createdAt: Number(user.createdAt || 0)
  };
}

function findUserById(userId){
  ensureAuthDefaults();
  return (ROOT_DB.users || []).find(x => x && String(x.id) === String(userId || "")) || null;
}

function findUserByIdentifier(identifier){
  ensureAuthDefaults();
  const key = normalizeAuthIdentifier(identifier);
  if(!key) return null;
  return (ROOT_DB.users || []).find(x => x && (String(x.usernameKey || "") === key || String(x.emailKey || "") === key)) || null;
}

function getRestaurantMetaById(restaurantId){
  ensureAuthDefaults();
  return (ROOT_DB.restaurants || []).find(x => x && String(x.id) === String(restaurantId || "")) || null;
}

function getRestaurantMembership(userId, restaurantId, role, status){
  ensureAuthDefaults();
  return (ROOT_DB.restaurantMemberships || []).find(x => {
    if(!x) return false;
    if(String(x.userId || "") !== String(userId || "")) return false;
    if(String(x.restaurantId || "") !== String(restaurantId || "")) return false;
    if(role && String(x.role || "") !== String(role)) return false;
    if(status && String(x.status || "") !== String(status)) return false;
    return true;
  }) || null;
}

function listMembershipsByUser(userId){
  ensureAuthDefaults();
  return (ROOT_DB.restaurantMemberships || []).filter(x => x && String(x.userId || "") === String(userId || ""));
}

function verifyUserPassword(user, pass){
  ensureAuthDefaults();
  if(!user || !user.passwordHash) return false;
  return String(user.passwordHash) === hashPass(pass, ROOT_DB.auth.salt);
}

function verifySecurityAnswer(user, answer){
  ensureAuthDefaults();
  if(!user || !user.securityAnswerHash) return false;
  const normalized = normalizeSecurityAnswer(answer);
  if(!normalized) return false;
  return String(user.securityAnswerHash) === hashPass(`security:${normalized}`, ROOT_DB.auth.salt);
}

function getDefaultRestaurantId(root = ROOT_DB){
  ensureAuthDefaults(root);
  const first = (root.restaurants || [])[0];
  return first ? String(first.id || "") : "";
}

function getRestaurantOwnerName(restaurantId){
  const meta = getRestaurantMetaById(restaurantId);
  if(!meta || !meta.ownerUserId) return "";
  const owner = findUserById(meta.ownerUserId);
  return owner ? normalizeUserName(owner.name || "") : "";
}

function pruneSessions(){
  ensureAuthDefaults();
  const t = now();
  ROOT_DB.sessions = (ROOT_DB.sessions||[]).filter(s => s && (!s.expiresAt || s.expiresAt > t));
}

function getSessionByToken(token){
  pruneSessions();
  const tok = String(token||"");
  if(!tok) return null;
  const s = (ROOT_DB.sessions||[]).find(x => x && x.token === tok);
  if(!s) return null;
  if(s.expiresAt && s.expiresAt <= now()) return null;
  return s;
}

function normalizeSessionAccess(session){
  if(!session) return null;
  const user = findUserById(session.userId);
  if(!user) return null;

  const restaurantId = String(session.restaurantId || "");
  if(!restaurantId){
    session.role = session.role === "cliente" ? "cliente" : "account";
    session.restaurantRole = "";
    session.restaurantId = "";
    session.name = normalizeUserName(user.name || "");
    session.username = normalizeAuthUsername(user.username || "");
    session.email = normalizeAuthEmail(user.email || "");
    session.branchId = "";
    session.branchName = "";
    return session;
  }

  const membership = getRestaurantMembership(user.id, restaurantId, null, "active");
  if(!membership){
    session.role = "account";
    session.restaurantRole = "";
    session.restaurantId = "";
    session.restaurantName = "";
    session.name = normalizeUserName(user.name || "");
    session.username = normalizeAuthUsername(user.username || "");
    session.email = normalizeAuthEmail(user.email || "");
    session.branchId = "";
    session.branchName = "";
    return session;
  }

  session.restaurantRole = String(membership.role || "");
  session.role = membership.role === "owner" ? "admin" : "mozo";
  const meta = getRestaurantMetaById(restaurantId);
  session.restaurantName = meta ? String(meta.name || "") : "";
  const workspace = getRestaurantWorkspace(restaurantId, true);
  const branches = workspace && workspace.settings && Array.isArray(workspace.settings.branches) ? workspace.settings.branches : [];
  const lastByRestaurant = (user.lastBranchSelections && typeof user.lastBranchSelections === "object" && !Array.isArray(user.lastBranchSelections))
    ? user.lastBranchSelections
    : {};
  let activeBranch = branches.find(x => x && String(x.id || "") === String(session.branchId || "")) || null;
  if (!activeBranch) {
    activeBranch = branches.find(x => x && String(x.id || "") === String(lastByRestaurant[restaurantId] || "")) || null;
  }
  if (!activeBranch && branches.length === 1) activeBranch = branches[0];
  session.branchId = activeBranch ? String(activeBranch.id || "") : "";
  session.branchName = activeBranch ? String(activeBranch.name || "") : "";
  session.name = normalizeUserName(user.name || "");
  session.username = normalizeAuthUsername(user.username || "");
  session.email = normalizeAuthEmail(user.email || "");
  return session;
}

function authFromReq(req){
  const tok = getAuthToken(req);
  const ses = getSessionByToken(tok);
  return normalizeSessionAccess(ses);
}

function setCookie(res, token, maxAgeSec){
  const parts = [
    `nexa_token=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Lax',
    'HttpOnly'
  ];
  if(typeof maxAgeSec === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res){
  res.setHeader('Set-Cookie', 'nexa_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
}

function createSessionForUser(user, opts = {}){
  ensureAuthDefaults();
  const ttlHours = Number(ROOT_DB.auth.sessionTTLHours || 72);
  const ttlMs = Math.max(1, ttlHours) * 3600 * 1000;
  const token = crypto.randomBytes(24).toString("hex");
  const ses = {
    id: uid(),
    token,
    userId: String(user.id || ""),
    role: normalizeAccountRole(opts.role || "account") || "account",
    restaurantRole: "",
    restaurantId: String(opts.restaurantId || ""),
    restaurantName: "",
    branchId: "",
    branchName: "",
    name: normalizeUserName(user.name || ""),
    username: normalizeAuthUsername(user.username || ""),
    email: normalizeAuthEmail(user.email || ""),
    createdAt: now(),
    expiresAt: now() + ttlMs
  };
  normalizeSessionAccess(ses);
  ROOT_DB.sessions.unshift(ses);
  pruneSessions();
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return ses;
}

function setSessionRestaurantAccess(session, restaurantId, accessRole){
  if(!session) return null;
  const role = normalizeRestaurantMemberRole(accessRole);
  const restId = String(restaurantId || "");
  if(!restId || !role){
    session.restaurantId = "";
    session.restaurantRole = "";
    session.role = "account";
    session.restaurantName = "";
    session.branchId = "";
    session.branchName = "";
    return normalizeSessionAccess(session);
  }
  session.restaurantId = restId;
  session.restaurantRole = role;
  return normalizeSessionAccess(session);
}

function requireRole(req, res, minRole){
  const ses = authFromReq(req);
  const role = ses ? ses.role : 'anon';
  if(!hasMinRole(role, minRole)){
    send(res, 401, JSON.stringify({ error: 'unauthorized', need: minRole }), 'application/json; charset=utf-8');
    return null;
  }
  return ses;
}
// ------------------ Network info ------------------
function getLocalIPv4s() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of (nets[name] || [])) {
      if (net.family === "IPv4" && !net.internal) {
        if (!net.address.startsWith("169.254.")) ips.push(net.address);
      }
    }
  }
  return [...new Set(ips)];
}

function scoreIp(ip) {
  if (ip.startsWith("192.168.")) return 3;
  if (ip.startsWith("10.")) return 2;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return 2;
  }
  return 1;
}

function buildUrls(ips) {
  return ips.map(ip => ({ ip, url: `http://${ip}:${PORT}` }))
            .sort((a,b)=>scoreIp(b.ip)-scoreIp(a.ip));
}

function preferredUrl(urls) {
  return urls.length ? urls[0].url : null;
}

// ------------------ Data layer ------------------
function buildSampleMenuCategories() {
  return [
    { id: "entradas", title: "Entradas", hint: "", items: [
      { name: "Empanada de carne", desc: "", price: 0 },
      { name: "Empanada de jamÃ³n y queso", desc: "", price: 0 },
    ]},
    { id: "principales", title: "Platos principales", hint: "", items: [
      { name: "Milanesa napolitana con patatas", desc: "", price: 0 },
      { name: "Bife de chorizo", desc: "", price: 0 },
    ]},
    { id: "bebidas", title: "Bebidas", hint: "", items: [
      { name: "Agua sin gas", desc: "", price: 0 },
      { name: "Coca Cola", desc: "", price: 0 },
    ]},
  ];
}

function normalizeMenuDocument(parsed) {
  if (Array.isArray(parsed)) {
    return { currency: "ARS", categories: parsed };
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.categories)) {
    return { currency: parsed.currency || "ARS", categories: parsed.categories };
  }
  return { currency: "ARS", categories: [] };
}

function loadMenuFromFile() {
  if (!fs.existsSync(MENU_FILE)) {
    // Menú base de ejemplo
    const sample = [
      { id: "entradas", title: "Entradas", hint: "", items: [
        { name: "Empanada de carne", desc: "", price: 0 },
        { name: "Empanada de jamón y queso", desc: "", price: 0 },
      ]},
      { id: "principales", title: "Platos principales", hint: "", items: [
        { name: "Milanesa napolitana con patatas", desc: "", price: 0 },
        { name: "Bife de chorizo", desc: "", price: 0 },
      ]},
      { id: "bebidas", title: "Bebidas", hint: "", items: [
        { name: "Agua sin gas", desc: "", price: 0 },
        { name: "Coca Cola", desc: "", price: 0 },
      ]},
    ];
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteJson(MENU_FILE, sample);
  }

  const parsed = safeJsonParse(fs.readFileSync(MENU_FILE, "utf8"), []);
  // Soporta dos formatos:
  // 1) Array de categorías (formato legacy)
  // 2) Objeto { currency, categories: [...] }
  if (Array.isArray(parsed)) {
    return { currency: "ARS", categories: parsed };
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.categories)) {
    return { currency: parsed.currency || "ARS", categories: parsed.categories };
  }
  return { currency: "ARS", categories: [] };
}

async function loadMenu() {
  if (!STORAGE || STORAGE.mode !== "postgres") {
    return loadMenuFromFile();
  }
  try {
    const stored = await STORAGE.getDocument("menu");
    if (stored !== null && stored !== undefined) {
      const normalized = normalizeMenuDocument(stored);
      await STORAGE.saveDocument("menu", normalized);
      return normalized;
    }
    const initialMenu = fs.existsSync(MENU_FILE)
      ? loadMenuFromFile()
      : { currency: "ARS", categories: buildSampleMenuCategories() };
    await STORAGE.saveDocument("menu", initialMenu);
    return normalizeMenuDocument(initialMenu);
  } catch (e) {
    console.log("⚠️ No pude cargar menu desde PostgreSQL, usando archivo local:", e.message);
    return loadMenuFromFile();
  }
}

function initDbFromMenu(menu) {
  const products = [];
  const seen = new Map();
  for (const cat of (menu.categories || [])) {
    for (let i = 0; i < (cat.items || []).length; i++) {
      const it = cat.items[i];
      const base = slugify(it.name);
      let id = base;
      let n = 2;
      while (seen.has(id)) { id = `${base}-${n++}`; }
      seen.set(id, true);
      products.push({
        id,
        name: String(it.name || "").slice(0, 80),
        nameEn: String(it.name_en || it.nameEn || "").slice(0, 80),
        description: String(it.desc || it.description || "").slice(0, 240),
        descriptionEn: String(it.desc_en || it.descriptionEn || "").slice(0, 240),
        price: Number(it.price || 0),
        categoryId: String(cat.id || slugify(cat.title)),
        categoryTitle: String(cat.title || "Categoría"),
        categoryTitleEn: String(cat.title_en || cat.titleEn || "").slice(0, 80),
        active: true,
        sectorId: "general",
        modifiers: [],

      });
    }
  }

  // 20 mesas por defecto (con layout para plano)
  const tables = [];
  for (let i = 1; i <= 20; i++) {
    const idx = i - 1;
    const pos = defaultTableLayout(idx, DEFAULT_TABLE_LAYOUT);
    tables.push({
      id: `T${i}`,
      name: `Mesa ${i}`,
      status: "libre", // libre | borrador | ocupada | sumando | lista
      ticketId: null,
      received: false,
      shape: "square",
      capacity: 4,
      locked: false,
      links: [],
      // layout en "canvas" virtual (px) para editor tipo Maxirest
      x: pos.x,
      y: pos.y,
      w: pos.w,
      h: pos.h,
      zone: "SalИn",
      updatedAt: now(),
    });
  }
  return {
    version: 8,
    createdAt: now(),
    updatedAt: now(),
settings: {
  restaurantName: "NEXA",
  currency: menu.currency || "ARS",
  taxRate: 0,
  footerText: "Gracias por tu visita",
  kitchen: {
    sectors: [
      { id: "general", name: "General", enabled: true },
      { id: "parrilla", name: "Parrilla", enabled: true },
      { id: "fritura", name: "Fritura", enabled: true },
      { id: "bebidas", name: "Bebidas", enabled: true },
    ]
  },
  printing: {
    // se usa en UI para sugerir impresoras por sector (el navegador no puede auto-seleccionar)
    sectorPrinters: {},
    ticketWidthMm: 80
  },
  fiscal: {
    enabled: false,
    provider: "manual",          // manual | wsfev1
    environment: "homologacion", // homologacion | produccion
    pos: "0001",
    company: {
      cuit: "",
      razonSocial: "",
      domicilio: "",
      ivaCondicion: "Consumidor Final",
      iibb: "",
      inicioActividades: ""
    },
    docTypeByFiscalType: {
      no_fiscal: "TICKET_NO_FISCAL",
      factura_electronica: "FACTURA_C",
      controlador_fiscal: "TICKET_FISCAL",
      manual: "FACTURA_C"
    },
    // códigos AFIP/ARCA (tipoCmp) para QR / WSFE (ajustable desde /admin_fiscal.html)
    tipoCmpByDocType: {
      FACTURA_A: 1,
      FACTURA_B: 6,
      FACTURA_C: 11
    },
    counters: {},
    providerConfig: {
      endpointHomologacion: "https://wsfehomo.arca.gob.ar/fe/wsfev1",
      endpointProduccion: "https://www.arca.gob.ar/fe/wsfev1",
      endpoint: "",
      timeoutMs: 15000,
      certificatePem: "",
      privateKeyPem: "",
      pfxBase64: "",
      passphrase: "",
      bearerToken: "",
      rejectUnauthorized: true
    }
  },
  auth: {
    salt: uid(),
    adminHash: "",
    adminUser: "",
    adminQuestion: "",
    adminAnswerHash: "",
    mozoHash: "",
    mozoUser: "",
    mozoQuestion: "",
    mozoAnswerHash: "",
    sessionTTLHours: 72
  },
  cash: {
    dayCloseCutoffHour: 2
  }
},
    products,
    tables,
    sessions: [],   // sesiones auth (admin/mozo)
    tickets: [],      // abiertos y cerrados
    sales: [],        // ventas cerradas
    fiscalDocs: [],   // documentos fiscales generados (CAE/CAEA/controlador)
    customerRequests: [], // solicitudes de clientes (ej: pedir la cuenta)
    dayClosures: [], // cierres diarios
    periodClosures: [], // cierres por periodo
    cash: {
      openSessionId: null,
      sessions: [],   // {id, dateKey, openedAt, openingCash, closedAt, closingCash, note}
      movements: [],  // {id, dateKey, at, type: in|out, method, amount, note}
      turns: [],      // arqueos por turno
    },
    inventory: {
      ingredients: [
        { id:"carne", name:"Carne", unit:"g", onHand:0, costPerUnit:0, min:0 },
        { id:"queso", name:"Queso", unit:"g", onHand:0, costPerUnit:0, min:0 },
        { id:"pan", name:"Pan", unit:"u", onHand:0, costPerUnit:0, min:0 },
      ],
      recipes: {
        // productId: [{ingredientId, qty}]
      }
    },
    people: {
      employees: [],
      customers: [],
      suppliers: [],
    },
    attendance: [],    // {id, employeeId, type, at, note}
    banks: {
      accounts: [],
      movements: [],   // {id, accountId, at, type, amount, note}
    },
    cajaMayor: {
      movements: [],   // {id, at, type, amount, note}
    },
    purchases: [],     // {id, supplierId, at, items, total, note}
    accounts: {
      customers: [],   // {id, personId, balance}
      suppliers: [],   // {id, personId, balance}
    }
  };
}

function loadDbFromFile(menu) {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const db = initDbFromMenu(menu);
      atomicWriteJson(DB_FILE, db);
      return db;
    }
    const db = safeJsonParse(fs.readFileSync(DB_FILE, "utf8"), null);
    if (!db || typeof db !== "object") throw new Error("DB inválida");
    // migraciones mínimas
    if (!db.version) db.version = 4; // legacy
    if (db.version < 5) db.version = 5;
    if (!db.settings) db.settings = { restaurantName: "RESTO", currency: menu.currency || "ARS", taxRate: 0, footerText: "" };
    if (!Array.isArray(db.products) || db.products.length === 0) db.products = initDbFromMenu(menu).products;
    if (!Array.isArray(db.tables) || db.tables.length === 0) db.tables = initDbFromMenu(menu).tables;

    // asegurar layout de mesas (x,y,w,h,zone)
    for (let i = 0; i < (db.tables || []).length; i++) {
      const t = db.tables[i];
      if (t.x === undefined || t.y === undefined) {
        const pos = defaultTableLayout(i, DEFAULT_TABLE_LAYOUT);
        t.x = pos.x;
        t.y = pos.y;
      }
      if (t.w === undefined) t.w = DEFAULT_TABLE_LAYOUT.baseW;
      if (t.h === undefined) t.h = DEFAULT_TABLE_LAYOUT.baseH;
      if (t.zone === undefined) t.zone = "SalИn";
      if (!t.shape) t.shape = "square";
      if (t.capacity === undefined) t.capacity = 4;
      if (t.locked === undefined) t.locked = false;
      if (!Array.isArray(t.links)) t.links = [];
    }
    const tableIds = new Set((db.tables || []).map(t=>String(t.id)));
    (db.tables || []).forEach(t=>{
      if (!Array.isArray(t.links)) t.links = [];
      t.links = Array.from(new Set(t.links.map(String).filter(id=>id && id !== t.id && tableIds.has(id))));
    });
    let layoutUpgraded = false;
    if (tablesMatchLayout(db.tables, LEGACY_TABLE_LAYOUT)) {
      applyDefaultTableLayout(db.tables, DEFAULT_TABLE_LAYOUT);
      layoutUpgraded = true;
    }
    if (!Array.isArray(db.tickets)) db.tickets = [];
    if (!Array.isArray(db.sales)) db.sales = [];
if (!Array.isArray(db.dayClosures)) db.dayClosures = [];
if (!Array.isArray(db.periodClosures)) db.periodClosures = [];
    if (!db.cash) db.cash = initDbFromMenu(menu).cash;
    if (!Array.isArray(db.cash.turns)) db.cash.turns = [];
    if (!db.inventory) db.inventory = initDbFromMenu(menu).inventory;
    if (!db.people) db.people = initDbFromMenu(menu).people;
    if (!Array.isArray(db.attendance)) db.attendance = [];
    if (!db.banks) db.banks = initDbFromMenu(menu).banks;
    if (!db.cajaMayor) db.cajaMayor = initDbFromMenu(menu).cajaMayor;
    if (!Array.isArray(db.purchases)) db.purchases = [];
    if (!db.accounts) db.accounts = initDbFromMenu(menu).accounts;
// --- NUEVO v8: settings / fiscales / sectores / modificadores ---
const defaults = initDbFromMenu(menu);
// Backfill traducciones del menú si ya hay productos guardados
if (Array.isArray(db.products) && Array.isArray(defaults.products)) {
  const byId = new Map(defaults.products.map(p => [String(p.id), p]));
  db.products.forEach(p => {
    const base = byId.get(String(p.id));
    if (!base) return;
    if (!p.nameEn && base.nameEn) p.nameEn = base.nameEn;
    if (!p.description && base.description) p.description = base.description;
    if (!p.descriptionEn && base.descriptionEn) p.descriptionEn = base.descriptionEn;
    if (!p.categoryTitleEn && base.categoryTitleEn) p.categoryTitleEn = base.categoryTitleEn;
  });
}

// Auth (roles/sesiones)
if (!db.settings.auth) db.settings.auth = defaults.settings.auth;
if (!db.settings.auth.salt) db.settings.auth.salt = defaults.settings.auth.salt || uid();
if (db.settings.auth.adminUser === undefined) db.settings.auth.adminUser = "";
if (db.settings.auth.adminQuestion === undefined) db.settings.auth.adminQuestion = "";
if (db.settings.auth.adminAnswerHash === undefined) db.settings.auth.adminAnswerHash = "";
if (db.settings.auth.mozoUser === undefined) db.settings.auth.mozoUser = "";
if (db.settings.auth.mozoQuestion === undefined) db.settings.auth.mozoQuestion = "";
if (db.settings.auth.mozoAnswerHash === undefined) db.settings.auth.mozoAnswerHash = "";
if (db.settings.auth.sessionTTLHours === undefined) db.settings.auth.sessionTTLHours = 72;
if (!Array.isArray(db.sessions)) db.sessions = [];
// limpiar sesiones expiradas
db.sessions = (db.sessions || []).filter(s => s && (!s.expiresAt || s.expiresAt > now()));

if (!db.settings.kitchen) db.settings.kitchen = defaults.settings.kitchen;
if (!db.settings.kitchen.sectors || !Array.isArray(db.settings.kitchen.sectors) || db.settings.kitchen.sectors.length === 0) {
  db.settings.kitchen.sectors = defaults.settings.kitchen.sectors;
}
if (!db.settings.printing) db.settings.printing = defaults.settings.printing;
if (!db.settings.printing.sectorPrinters) db.settings.printing.sectorPrinters = {};
if (!db.settings.printing.ticketWidthMm) db.settings.printing.ticketWidthMm = defaults.settings.printing.ticketWidthMm;

if (!db.settings.cash) db.settings.cash = defaults.settings.cash;
if (db.settings.cash.dayCloseCutoffHour === undefined) db.settings.cash.dayCloseCutoffHour = defaults.settings.cash.dayCloseCutoffHour;

if (!db.settings.fiscal) db.settings.fiscal = defaults.settings.fiscal;
if (db.settings.fiscal.enabled === undefined) db.settings.fiscal.enabled = false;
if (!db.settings.fiscal.provider) db.settings.fiscal.provider = "manual";
if (!db.settings.fiscal.environment) db.settings.fiscal.environment = "homologacion";
if (!db.settings.fiscal.pos) db.settings.fiscal.pos = "0001";
if (!db.settings.fiscal.company) db.settings.fiscal.company = defaults.settings.fiscal.company;
if (!db.settings.fiscal.docTypeByFiscalType) db.settings.fiscal.docTypeByFiscalType = defaults.settings.fiscal.docTypeByFiscalType;
if (!db.settings.fiscal.docTypeByFiscalType.manual) db.settings.fiscal.docTypeByFiscalType.manual = "FACTURA_C";
    if (!db.settings.fiscal.counters) db.settings.fiscal.counters = {};
    if (!db.settings.fiscal.providerConfig) db.settings.fiscal.providerConfig = defaults.settings.fiscal.providerConfig;

if (!Array.isArray(db.fiscalDocs)) db.fiscalDocs = [];
if (!Array.isArray(db.customerRequests)) db.customerRequests = [];


// Productos: sector + modificadores
for (const p of (db.products || [])) {
  if (!p.sectorId) p.sectorId = "general";
  if (!Array.isArray(p.modifiers)) p.modifiers = [];
  if (p.prodCost === undefined) p.prodCost = 0;
}

// Migración: items con lineId/modificadores (tickets y sales)
const ensureLineItems = (items) => {
  if (!Array.isArray(items)) return [];
  for (const it of items) {
    if (!it.lineId) it.lineId = uid();
    if (it.basePrice === undefined) it.basePrice = Number(it.unitPrice || 0);
    if (!Array.isArray(it.modifiers)) it.modifiers = [];
    if (!it.sectorId) it.sectorId = "general";
    if (!it.discount || typeof it.discount !== "object") it.discount = null;
  }
  return items;
};

for (const t of (db.tickets || [])) {
  t.items = ensureLineItems(t.items);
  if (!t.fiscal) t.fiscal = {};
}
for (const s of (db.sales || [])) {
  s.items = ensureLineItems(s.items);
  if (!s.fiscal) s.fiscal = {};
}

    if (layoutUpgraded) {
      db.updatedAt = now();
      try {
        atomicWriteJson(DB_FILE, db);
      } catch (e) {
        console.log("Error guardando db.json (layout mesas):", e.message);
      }
    }
    db.updatedAt = now();
    return db;
  } catch (e) {
    console.log("⚠️ No pude cargar db.json, recreando:", e.message);
    const db = initDbFromMenu(menu);
    atomicWriteJson(DB_FILE, db);
    return db;
  }
}

const RESTAURANT_SCOPED_KEYS = new Set([
  "settings",
  "products",
  "tables",
  "tickets",
  "sales",
  "fiscalDocs",
  "customerRequests",
  "dayClosures",
  "periodClosures",
  "cash",
  "inventory",
  "people",
  "attendance",
  "banks",
  "cajaMayor",
  "purchases",
  "accounts"
]);

function cloneJson(value, fallback){
  try{ return JSON.parse(JSON.stringify(value)); }
  catch{ return fallback; }
}

function restaurantNameKey(value){
  return String(slugify(value || "") || "").slice(0, 64);
}

function normalizeRestaurantName(value){
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 48);
}

function normalizeBranchName(value){
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 48);
}

function branchNameKey(value){
  return String(slugify(value || "") || "").slice(0, 64);
}

const RESTAURANT_TRASH_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function normalizeRestaurantWorkspaceData(workspace, menu){
  const base = initDbFromMenu(menu);
  const db = cloneJson(workspace && typeof workspace === "object" ? workspace : {}, {});

  db.version = 10;
  db.createdAt = Number(db.createdAt || now());
  db.updatedAt = Number(db.updatedAt || now());
  db.settings = (db.settings && typeof db.settings === "object") ? db.settings : {};
  db.settings.restaurantName = String(db.settings.restaurantName || base.settings.restaurantName || "NEXA").slice(0, 40);
  if (db.settings.ownerDisplayName === undefined) db.settings.ownerDisplayName = "";
  if (db.settings.currency === undefined) db.settings.currency = base.settings.currency;
  if (db.settings.taxRate === undefined) db.settings.taxRate = 0;
  if (db.settings.footerText === undefined) db.settings.footerText = base.settings.footerText;
  if (!Array.isArray(db.settings.menuCategories)) db.settings.menuCategories = Array.isArray(base.settings.menuCategories) ? cloneJson(base.settings.menuCategories, []) : [];
  if (!db.settings.kitchen) db.settings.kitchen = cloneJson(base.settings.kitchen, {});
  if (!db.settings.kitchen.sectors || !Array.isArray(db.settings.kitchen.sectors) || db.settings.kitchen.sectors.length === 0) {
    db.settings.kitchen.sectors = cloneJson(base.settings.kitchen.sectors, []);
  }
  if (!db.settings.printing) db.settings.printing = cloneJson(base.settings.printing, {});
  if (!db.settings.printing.sectorPrinters) db.settings.printing.sectorPrinters = {};
  if (!db.settings.printing.ticketWidthMm) db.settings.printing.ticketWidthMm = base.settings.printing.ticketWidthMm;
  if (!Array.isArray(db.settings.branches)) db.settings.branches = [];
  db.settings.branches = db.settings.branches
    .filter(x => x && typeof x === "object")
    .map(x => ({
      id: String(x.id || uid()),
      name: normalizeBranchName(x.name || "Sucursal"),
      nameKey: branchNameKey(x.name || "Sucursal"),
      createdAt: Number(x.createdAt || now()),
      updatedAt: Number(x.updatedAt || now())
    }));
  if (!db.settings.cash) db.settings.cash = cloneJson(base.settings.cash, { dayCloseCutoffHour: 2 });
  if (db.settings.cash.dayCloseCutoffHour === undefined) db.settings.cash.dayCloseCutoffHour = base.settings.cash.dayCloseCutoffHour;
  if (!db.settings.fiscal) db.settings.fiscal = cloneJson(base.settings.fiscal, {});
  if (db.settings.fiscal.enabled === undefined) db.settings.fiscal.enabled = false;
  if (!db.settings.fiscal.provider) db.settings.fiscal.provider = "manual";
  if (!db.settings.fiscal.environment) db.settings.fiscal.environment = "homologacion";
  if (!db.settings.fiscal.pos) db.settings.fiscal.pos = "0001";
  if (!db.settings.fiscal.company) db.settings.fiscal.company = cloneJson(base.settings.fiscal.company, {});
  if (!db.settings.fiscal.docTypeByFiscalType) db.settings.fiscal.docTypeByFiscalType = cloneJson(base.settings.fiscal.docTypeByFiscalType, {});
  if (!db.settings.fiscal.docTypeByFiscalType.manual) db.settings.fiscal.docTypeByFiscalType.manual = "FACTURA_C";
  if (!db.settings.fiscal.counters) db.settings.fiscal.counters = {};
  if (!db.settings.fiscal.providerConfig) db.settings.fiscal.providerConfig = cloneJson(base.settings.fiscal.providerConfig, {});
  delete db.settings.auth;
  delete db.sessions;

  if (!Array.isArray(db.products) || db.products.length === 0) db.products = cloneJson(base.products, []);
  if (!Array.isArray(db.tables) || db.tables.length === 0) db.tables = cloneJson(base.tables, []);
  if (!Array.isArray(db.tickets)) db.tickets = [];
  if (!Array.isArray(db.sales)) db.sales = [];
  if (!Array.isArray(db.fiscalDocs)) db.fiscalDocs = [];
  if (!Array.isArray(db.customerRequests)) db.customerRequests = [];
  if (!Array.isArray(db.dayClosures)) db.dayClosures = [];
  if (!Array.isArray(db.periodClosures)) db.periodClosures = [];
  if (!db.cash) db.cash = cloneJson(base.cash, {});
  if (!Array.isArray(db.cash.turns)) db.cash.turns = [];
  if (!Array.isArray(db.cash.sessions)) db.cash.sessions = [];
  if (!Array.isArray(db.cash.movements)) db.cash.movements = [];
  if (!db.inventory) db.inventory = cloneJson(base.inventory, {});
  if (!db.people) db.people = cloneJson(base.people, {});
  if (!Array.isArray(db.attendance)) db.attendance = [];
  if (!db.banks) db.banks = cloneJson(base.banks, {});
  if (!db.cajaMayor) db.cajaMayor = cloneJson(base.cajaMayor, {});
  if (!Array.isArray(db.purchases)) db.purchases = [];
  if (!db.accounts) db.accounts = cloneJson(base.accounts, {});

  for (let i = 0; i < (db.tables || []).length; i++) {
    const t = db.tables[i];
    if (!t) continue;
    if (t.x === undefined || t.y === undefined) {
      const pos = defaultTableLayout(i, DEFAULT_TABLE_LAYOUT);
      t.x = pos.x;
      t.y = pos.y;
    }
    if (t.w === undefined) t.w = DEFAULT_TABLE_LAYOUT.baseW;
    if (t.h === undefined) t.h = DEFAULT_TABLE_LAYOUT.baseH;
    if (t.zone === undefined) t.zone = "SalÐ˜n";
    if (!t.shape) t.shape = "square";
    if (t.capacity === undefined) t.capacity = 4;
    if (t.locked === undefined) t.locked = false;
    if (!Array.isArray(t.links)) t.links = [];
  }

  for (const p of (db.products || [])) {
    if (!p.sectorId) p.sectorId = "general";
    if (!Array.isArray(p.modifiers)) p.modifiers = [];
    if (p.prodCost === undefined) p.prodCost = 0;
  }

  const ensureLineItems = (items) => {
    if (!Array.isArray(items)) return [];
    for (const it of items) {
      if (!it.lineId) it.lineId = uid();
      if (it.basePrice === undefined) it.basePrice = Number(it.unitPrice || 0);
      if (!Array.isArray(it.modifiers)) it.modifiers = [];
      if (!it.sectorId) it.sectorId = "general";
      if (!it.discount || typeof it.discount !== "object") it.discount = null;
    }
    return items;
  };

  for (const t of (db.tickets || [])) {
    t.items = ensureLineItems(t.items);
    if (!t.fiscal) t.fiscal = {};
  }
  for (const s of (db.sales || [])) {
    s.items = ensureLineItems(s.items);
    if (!s.fiscal) s.fiscal = {};
  }

  return db;
}

function isRootDbShape(value){
  return !!(value && typeof value === "object" && Array.isArray(value.restaurants) && value.restaurantData && typeof value.restaurantData === "object" && !Array.isArray(value.restaurantData));
}

function wrapLegacyWorkspaceAsRoot(workspace, menu){
  const normalized = normalizeRestaurantWorkspaceData(workspace, menu);
  const restaurantId = uid();
  return {
    version: 10,
    model: "multi-restaurant",
    createdAt: Number(normalized.createdAt || now()),
    updatedAt: Number(normalized.updatedAt || now()),
    auth: {
      salt: String((((workspace || {}).settings || {}).auth || {}).salt || uid()),
      sessionTTLHours: Number((((workspace || {}).settings || {}).auth || {}).sessionTTLHours || 72)
    },
    users: [],
    sessions: [],
    restaurants: [{
      id: restaurantId,
      name: normalizeRestaurantName(normalized.settings.restaurantName || "NEXA"),
      nameKey: restaurantNameKey(normalized.settings.restaurantName || "NEXA"),
      ownerUserId: "",
      importedLegacy: true,
      createdAt: Number(normalized.createdAt || now()),
      updatedAt: Number(normalized.updatedAt || now())
    }],
    restaurantMemberships: [],
    restaurantData: {
      [restaurantId]: normalized
    }
  };
}

function normalizeRootDb(root, menu){
  ensureAuthDefaults(root);
  root.version = 10;
  root.model = "multi-restaurant";
  root.createdAt = Number(root.createdAt || now());
  root.updatedAt = Number(root.updatedAt || now());
  root.users = Array.isArray(root.users) ? root.users : [];
  root.restaurants = Array.isArray(root.restaurants) ? root.restaurants : [];
  root.restaurantMemberships = Array.isArray(root.restaurantMemberships) ? root.restaurantMemberships : [];
  root.sessions = Array.isArray(root.sessions) ? root.sessions : [];
  root.restaurantData = (root.restaurantData && typeof root.restaurantData === "object" && !Array.isArray(root.restaurantData)) ? root.restaurantData : {};

  const normalizedRestaurants = [];
  const seenIds = new Set();
  for (const item of root.restaurants) {
    if (!item) continue;
    const id = String(item.id || uid());
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const name = normalizeRestaurantName(item.name || "NEXA");
    normalizedRestaurants.push({
      id,
      name,
      nameKey: restaurantNameKey(item.name || name),
      ownerUserId: String(item.ownerUserId || ""),
      trashedAt: Number(item.trashedAt || 0),
      importedLegacy: !!item.importedLegacy,
      createdAt: Number(item.createdAt || now()),
      updatedAt: Number(item.updatedAt || now())
    });
    root.restaurantData[id] = normalizeRestaurantWorkspaceData(root.restaurantData[id], menu);
  }
  root.restaurants = normalizedRestaurants;
  if (!root.restaurants.length) {
    return wrapLegacyWorkspaceAsRoot(initDbFromMenu(menu), menu);
  }
  purgeExpiredTrashedRestaurants(root);
  const t = now();
  root.sessions = (root.sessions || []).filter(s => s && (!s.expiresAt || s.expiresAt > t));
  return root;
}

function loadRootDbFromFile(menu){
  try{
    if (!fs.existsSync(DB_FILE)) {
      const root = wrapLegacyWorkspaceAsRoot(initDbFromMenu(menu), menu);
      atomicWriteJson(DB_FILE, root);
      return root;
    }
    const raw = safeJsonParse(fs.readFileSync(DB_FILE, "utf8"), null);
    if (!raw || typeof raw !== "object") throw new Error("DB invÃ¡lida");
    if (isRootDbShape(raw)) return normalizeRootDb(raw, menu);
    return wrapLegacyWorkspaceAsRoot(loadDbFromFile(menu), menu);
  }catch(e){
    console.log("âš ï¸ No pude cargar db.json, recreando root:", e.message);
    const root = wrapLegacyWorkspaceAsRoot(initDbFromMenu(menu), menu);
    atomicWriteJson(DB_FILE, root);
    return root;
  }
}

async function loadRootDb(menu){
  if (!STORAGE || STORAGE.mode !== "postgres") {
    return loadRootDbFromFile(menu);
  }
  try {
    const stored = await STORAGE.getDocument("root_db");
    if (stored && typeof stored === "object") {
      const normalized = isRootDbShape(stored)
        ? normalizeRootDb(stored, menu)
        : wrapLegacyWorkspaceAsRoot(stored, menu);
      await STORAGE.saveDocument("root_db", normalized);
      return normalized;
    }
    const initialRoot = fs.existsSync(DB_FILE)
      ? loadRootDbFromFile(menu)
      : wrapLegacyWorkspaceAsRoot(initDbFromMenu(menu), menu);
    await STORAGE.saveDocument("root_db", initialRoot);
    return initialRoot;
  } catch (e) {
    console.log("⚠️ No pude cargar root desde PostgreSQL, usando archivo local:", e.message);
    return loadRootDbFromFile(menu);
  }
}

function getRestaurantWorkspace(restaurantId, createIfMissing = true){
  ensureAuthDefaults();
  const targetId = String(restaurantId || getRestaurantContextId() || getDefaultRestaurantId(ROOT_DB) || "");
  if(!targetId) return normalizeRestaurantWorkspaceData({}, MENU);
  if(!ROOT_DB.restaurantData[targetId] && createIfMissing){
    ROOT_DB.restaurantData[targetId] = normalizeRestaurantWorkspaceData({}, MENU);
  }
  return ROOT_DB.restaurantData[targetId] || null;
}

function getRestaurantSnapshot(restaurantId){
  return cloneJson(getRestaurantWorkspace(restaurantId, true), {});
}

function createRestaurantDbProxy(){
  return new Proxy({}, {
    get(_target, prop){
      if (prop === "toJSON") return () => getRestaurantSnapshot();
      if (RESTAURANT_SCOPED_KEYS.has(prop)) {
        const ws = getRestaurantWorkspace();
        return ws ? ws[prop] : undefined;
      }
      return ROOT_DB ? ROOT_DB[prop] : undefined;
    },
    set(_target, prop, value){
      if (RESTAURANT_SCOPED_KEYS.has(prop)) {
        const ws = getRestaurantWorkspace();
        if (ws) ws[prop] = value;
        return true;
      }
      if (ROOT_DB) ROOT_DB[prop] = value;
      return true;
    }
  });
}

async function initPersistence() {
  if (STORAGE_MODE !== "postgres") {
    STORAGE = { mode: "file", close: async () => {} };
    return;
  }
  STORAGE = createPostgresStorage();
  await STORAGE.init();
  await seedPostgresFromDisk(STORAGE, {
    menuFile: MENU_FILE,
    dbFile: DB_FILE,
    imagesDir: IMAGES_DIR,
  });
}

async function persistRootDb(root) {
  if (!root) return;
  if (STORAGE && STORAGE.mode === "postgres") {
    await STORAGE.saveDocument("root_db", root);
    return;
  }
  atomicWriteJson(DB_FILE, root);
}

let saveTimer = null;
let saveFlush = Promise.resolve();
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = cloneJson(ROOT_DB, null);
    saveFlush = saveFlush.then(async () => {
      try {
        await persistRootDb(snapshot);
      } catch (e) {
        console.log("Error guardando base:", e.message);
      }
    }).catch(() => {});
    try {
      /* legacy save path handled via persistRootDb */
    } catch (e) {
      console.log("⚠️ Error guardando db.json:", e.message);
    }
  }, 250);
}

// ------------------ Domain operations ------------------
function findTable(tableId) {
  return DB.tables.find(t => t.id === tableId);
}
function tableLabel(tableId){
  if(!tableId) return "";
  const t = findTable(tableId);
  return t ? t.name : String(tableId);
}
function findTicket(ticketId) {
  return DB.tickets.find(t => t.id === ticketId);
}
function getLinkedTableIds(tableId){
  const start = findTable(tableId);
  if (!start) return [];
  const seen = new Set([start.id]);
  const stack = [start];
  while (stack.length) {
    const t = stack.pop();
    const links = Array.isArray(t.links) ? t.links : [];
    for (const id of links) {
      if (seen.has(id)) continue;
      const next = findTable(id);
      if (next) {
        seen.add(next.id);
        stack.push(next);
      }
    }
  }
  return Array.from(seen);
}
function getTablesForTicket(ticket){
  if (!ticket) return [];
  const tables = DB.tables.filter(t => t && t.ticketId === ticket.id);
  if (tables.length) return tables;
  if (ticket.tableId) {
    const t = findTable(ticket.tableId);
    if (t) return [t];
  }
  return [];
}
function releaseTicketTables(ticket){
  const tables = getTablesForTicket(ticket);
  const ids = new Set(tables.map(t=>t.id));
  tables.forEach(table=>{
    table.ticketId = null;
    table.status = "libre";
    table.received = false;
    table.updatedAt = now();
  });
  if (ids.size) {
    DB.tables.forEach(t=>{
      if (!Array.isArray(t.links)) t.links = [];
      t.links = t.links.filter(id => !ids.has(id));
    });
  }
}
function createTicket({ channel, tableId, createdBy }) {
  const t = {
    id: uid(),
    channel,               // salon|mostrador|delivery
    tableId: tableId || null,
    customerName: "",
    customerPhone: "",
    customerAddress: "",
    fiscal: {},
    fiscalDocId: null,
    items: [],             // {lineId,productId,name,qty,basePrice,unitPrice,modifiers,sectorId}
    kitchenStatus: "borrador", // borrador|recibido|en_preparacion|listo|entregado
    status: "abierta",     // abierta|cerrada|anulada
    createdAt: now(),
    updatedAt: now(),
    createdBy: createdBy || "Sistema",
    notes: "",
  };
  DB.tickets.unshift(t);
  if (channel === "salon" && tableId) {
    const tableIds = getLinkedTableIds(tableId);
    const tables = tableIds.map(findTable).filter(Boolean);
    tables.forEach(table=>{
      table.ticketId = t.id;
      // Al abrir una mesa sin productos todavia, la marcamos como "borrador"
      // para evitar que parezca "ocupada" hasta que haya pedido real.
      table.status = "borrador";
      table.received = false;
      table.updatedAt = now();
    });
  }
  DB.updatedAt = now();
  scheduleSave();
  return t;
}

function ensureTicketForTable(tableId, createdBy) {
  const table = findTable(tableId);
  if (!table) return null;
  if (table.ticketId) {
    const existing = findTicket(table.ticketId);
    if (existing && existing.status === "abierta") return existing;
  }
  const groupIds = getLinkedTableIds(tableId);
  for (const id of groupIds) {
    const t = findTable(id);
    if (!t || !t.ticketId) continue;
    const existing = findTicket(t.ticketId);
    if (existing && existing.status === "abierta") {
      const tables = groupIds.map(findTable).filter(Boolean);
      tables.forEach(tb=>{
        tb.ticketId = existing.id;
        tb.status = "borrador";
        tb.received = false;
        tb.updatedAt = now();
      });
      DB.updatedAt = now();
      scheduleSave();
      return existing;
    }
  }
  return createTicket({ channel: "salon", tableId, createdBy });
}

function abandonDraftTicket(ticketId, by = "Sistema") {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;
  if (ticket.kitchenStatus !== "borrador") return;
  if ((ticket.items || []).length > 0) return;

  // libera mesa si aplica
  if (ticket.channel === "salon") {
    releaseTicketTables(ticket);
  }

  ticket.status = "anulada";
  ticket.canceledAt = now();
  ticket.cancelReason = "Borrador descartado";
  ticket.canceledBy = String(by || "Sistema").slice(0, 60);
  ticket.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
}

function cancelTicket(ticketId, by = "Sistema", reason = "Anulada") {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;

  // libera mesa si aplica
  if (ticket.channel === "salon") {
    releaseTicketTables(ticket);
  }

  ticket.status = "anulada";
  ticket.canceledAt = now();
  ticket.cancelReason = String(reason || "Anulada").slice(0, 120);
  ticket.canceledBy = String(by || "Sistema").slice(0, 60);
  ticket.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
}

function sameModifiers(aMods, bMods) {
  const a = Array.isArray(aMods) ? aMods : [];
  const b = Array.isArray(bMods) ? bMods : [];
  if (a.length !== b.length) return false;
  const key = (m) => `${m.groupId||""}:${m.optionId||""}`;
  const as = a.map(key).sort().join("|");
  const bs = b.map(key).sort().join("|");
  return as === bs;
}

function computeItemFromSelections(product, selections) {
  const groups = Array.isArray(product.modifiers) ? product.modifiers : [];
  const sel = (selections && typeof selections === "object") ? selections : {};
  let multiplier = 1;
  let add = 0;
  const mods = [];
  const addProducts = [];

  for (const g of groups) {
    const gid = String(g.id || "");
    const chosen = Array.isArray(sel[gid]) ? sel[gid].map(String) : [];
    const opts = Array.isArray(g.options) ? g.options : [];
    // Si no elige nada y hay defaults, aplica defaults SOLO si no llegó nada desde UI.
    const effective = (chosen.length === 0 && sel[gid] === undefined)
      ? opts.filter(o => o && o.default).map(o => String(o.id))
      : chosen;

    for (const oid of effective) {
      const o = opts.find(x => String(x.id) === String(oid));
      if (!o) continue;
      const price = Number(o.price || 0);
      const mult = (o.multiplier !== undefined) ? Number(o.multiplier) : null;
      if (mult && Number.isFinite(mult) && mult > 0) multiplier = mult;
      if (Number.isFinite(price)) add += price;
      mods.push({
        groupId: gid,
        groupName: String(g.name || gid).slice(0, 60),
        optionId: String(o.id || oid),
        optionName: String(o.name || oid).slice(0, 80),
        price,
        kind: String(o.kind || g.kind || "").slice(0, 24), // size|remove|extra...
      });
      if (Array.isArray(o.addProducts)) {
        for (const ap of o.addProducts) {
          if (!ap) continue;
          const pid = String(ap.productId || "");
          const q = Number(ap.qty || 1);
          if (pid && Number.isFinite(q) && q > 0) addProducts.push({ productId: pid, qty: q });
        }
      }
    }
  }

  const base = Number(product.price || 0);
  const unitPrice = Math.max(0, (base * multiplier) + add);
  return { basePrice: base, unitPrice, modifiers: mods, addProducts };
}

function addItemLine(ticketId, productId, delta, selections = null) {
  return addItemLineInner(ticketId, productId, delta, selections, 0);
}

const ITEM_KITCHEN_STATUSES = new Set(["borrador","recibido","en_preparacion","listo","entregado"]);

function normalizeTicketItems(ticket) {
  if (!ticket || !Array.isArray(ticket.items)) return;
  const fallback = ITEM_KITCHEN_STATUSES.has(ticket.kitchenStatus) ? ticket.kitchenStatus : "borrador";
  for (const it of ticket.items) {
    if (!it.lineId) it.lineId = uid();
    if (!Array.isArray(it.modifiers)) it.modifiers = [];
    if (!it.sectorId) it.sectorId = "general";
    if (it.basePrice === undefined) it.basePrice = Number(it.unitPrice || 0);
    const ks = String(it.kitchenStatus || "");
    it.kitchenStatus = ITEM_KITCHEN_STATUSES.has(ks) ? ks : fallback;
  }
}

function getTicketItemFlags(ticket) {
  const items = (ticket && Array.isArray(ticket.items)) ? ticket.items : [];
  const flags = {
    hasItems: items.length > 0,
    hasNew: false,
    hasReceived: false,
    hasPrep: false,
    hasReady: false,
    hasDelivered: false,
    allDelivered: false,
    allReadyOrDelivered: false,
    hasPending: false,
    hasReadyOrDelivered: false,
  };
  if (!flags.hasItems) return flags;
  for (const it of items) {
    const s = String(it.kitchenStatus || "borrador");
    if (s === "borrador") flags.hasNew = true;
    else if (s === "recibido") flags.hasReceived = true;
    else if (s === "en_preparacion") flags.hasPrep = true;
    else if (s === "listo") flags.hasReady = true;
    else if (s === "entregado") flags.hasDelivered = true;
  }
  flags.allDelivered = items.every(it => String(it.kitchenStatus || "borrador") === "entregado");
  flags.allReadyOrDelivered = items.every(it => {
    const s = String(it.kitchenStatus || "borrador");
    return s === "listo" || s === "entregado";
  });
  flags.hasPending = flags.hasNew || flags.hasReceived || flags.hasPrep;
  flags.hasReadyOrDelivered = flags.hasReady || flags.hasDelivered;
  return flags;
}

function deriveTicketKitchenStatusFromFlags(flags) {
  if (!flags.hasItems) return "borrador";
  if (flags.allDelivered) return "entregado";
  if (flags.allReadyOrDelivered) return "listo";
  if (flags.hasPrep) return "en_preparacion";
  if (flags.hasReceived) return "recibido";
  if (flags.hasNew) return "borrador";
  if (flags.hasReady) return "listo";
  if (flags.hasDelivered) return "entregado";
  return "borrador";
}

function deriveTableStatusFromFlags(flags) {
  if (!flags.hasItems) return "borrador";
  if (flags.allReadyOrDelivered) return "lista";
  if (flags.hasPending && flags.hasReadyOrDelivered) return "sumando";
  return "ocupada";
}

function refreshTicketKitchenAndTables(ticket, prevKitchenStatus) {
  if (!ticket) return;
  const prevKs = String(prevKitchenStatus || ticket.kitchenStatus || "borrador");
  normalizeTicketItems(ticket);
  const flags = getTicketItemFlags(ticket);
  ticket.kitchenStatus = deriveTicketKitchenStatusFromFlags(flags);
  ticket.updatedAt = now();

  if (ticket.channel === "salon" && ticket.tableId) {
    const tables = getTablesForTicket(ticket);
    const hasNotes = String(ticket.notes || "").trim().length > 0;
    if (flags.hasItems) {
      const st = deriveTableStatusFromFlags(flags);
      tables.forEach(table=>{
        table.ticketId = ticket.id;
        table.status = st;
        table.updatedAt = now();
      });
    } else {
      if (prevKs === "borrador" && !hasNotes) {
        releaseTicketTables(ticket);
        ticket.status = "anulada";
        ticket.canceledAt = now();
        ticket.cancelReason = "Vacia";
      } else {
        tables.forEach(table=>{
          table.ticketId = ticket.id;
          table.status = "borrador";
          table.updatedAt = now();
        });
      }
    }
  }

  DB.updatedAt = now();
  scheduleSave();
}

function updateItemsKitchenStatus(ticket, fromSet, toStatus) {
  let changed = false;
  if (!ticket || !Array.isArray(ticket.items)) return changed;
  for (const it of ticket.items) {
    const cur = String(it.kitchenStatus || "borrador");
    if (fromSet.has(cur)) {
      it.kitchenStatus = toStatus;
      changed = true;
    }
  }
  return changed;
}

function addItemLineInner(ticketId, productId, delta, selections = null, depth = 0) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;
  const p = DB.products.find(x => x.id === productId && x.active !== false);
  if (!p) return;

  const d = Number(delta || 1);
  if (!Number.isFinite(d) || d === 0) return;

  if (!Array.isArray(ticket.items)) ticket.items = [];
  const prevKitchenStatus = ticket.kitchenStatus;
  normalizeTicketItems(ticket);

  const computed = computeItemFromSelections(p, selections || {});

  // Reglas (combos): opcionalmente un modificador puede agregar otros productos (addProducts)
  if (depth === 0 && Array.isArray(computed.addProducts) && computed.addProducts.length) {
    for (const ap of computed.addProducts) {
      if (!ap) continue;
      const pid2 = String(ap.productId || "");
      const q2 = Number(ap.qty || 1);
      if (!pid2 || !Number.isFinite(q2) || q2 === 0) continue;
      // aplica misma delta (si suma/resta el item principal, suma/resta sus agregados)
      addItemLineInner(ticketId, pid2, Number(delta || 0) * q2, null, depth + 1);
    }
  }

  // buscar línea existente igual (mismo producto + mismos modificadores)
  const matches = ticket.items.filter(x => x.productId === productId && sameModifiers(x.modifiers, computed.modifiers));
  let existing = null;
  if (d > 0) {
    existing = matches.find(x => String(x.kitchenStatus || "borrador") === "borrador");
  } else {
    existing = matches.find(x => String(x.kitchenStatus || "borrador") === "borrador") || matches[0];
  }

  if (existing) {
    existing.qty = Math.max(0, Math.min(99, (existing.qty || 0) + d));
    existing.unitPrice = computed.unitPrice;
    existing.basePrice = computed.basePrice;
    existing.sectorId = p.sectorId || "general";
    existing.modifiers = computed.modifiers;
  } else if (d > 0) {
    ticket.items.push({
      lineId: uid(),
      productId,
      name: p.name,
      qty: Math.max(1, Math.min(99, d)),
      basePrice: computed.basePrice,
      unitPrice: computed.unitPrice,
      modifiers: computed.modifiers,
      sectorId: p.sectorId || "general",
      kitchenStatus: "borrador",
    });
  }

  ticket.items = ticket.items.filter(x => (x.qty || 0) > 0);
  refreshTicketKitchenAndTables(ticket, prevKitchenStatus);
}

// Compatibilidad: suma/resta simple (sin modificadores)
function addItem(ticketId, productId, delta) {
  return addItemLine(ticketId, productId, delta, null);
}

function changeLineQty(ticketId, lineId, delta) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;
  if (!Array.isArray(ticket.items)) ticket.items = [];
  const prevKitchenStatus = ticket.kitchenStatus;
  normalizeTicketItems(ticket);
  const it = ticket.items.find(x => x.lineId === lineId);
  if (!it) return;
  const d = Number(delta || 0);
  if (!Number.isFinite(d) || d === 0) return;
  const lineStatus = String(it.kitchenStatus || "borrador");
  if (d > 0 && lineStatus !== "borrador") {
    const existing = ticket.items.find(x =>
      x.productId === it.productId &&
      sameModifiers(x.modifiers, it.modifiers) &&
      String(x.kitchenStatus || "borrador") === "borrador"
    );
    if (existing) {
      existing.qty = Math.max(0, Math.min(99, (existing.qty || 0) + d));
    } else {
      ticket.items.push({
        lineId: uid(),
        productId: it.productId,
        name: it.name,
        qty: Math.max(1, Math.min(99, d)),
        basePrice: it.basePrice,
        unitPrice: it.unitPrice,
        modifiers: Array.isArray(it.modifiers) ? it.modifiers : [],
        sectorId: it.sectorId || "general",
        kitchenStatus: "borrador",
      });
    }
    ticket.items = ticket.items.filter(x => (x.qty || 0) > 0);
    refreshTicketKitchenAndTables(ticket, prevKitchenStatus);
    return;
  }
  it.qty = Math.max(0, Math.min(99, (it.qty || 0) + d));
  ticket.items = ticket.items.filter(x => (x.qty || 0) > 0);
  refreshTicketKitchenAndTables(ticket, prevKitchenStatus);
}

function setLineDiscount(ticketId, lineId, discount) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;
  if (!Array.isArray(ticket.items)) ticket.items = [];
  const it = ticket.items.find(x => x.lineId === lineId);
  if (!it) return;
  if (!discount || typeof discount !== "object") {
    it.discount = null;
  } else {
    const type = String(discount.type || "").toLowerCase();
    const value = Number(discount.value || 0);
    if (!Number.isFinite(value) || value <= 0 || (type !== "percent" && type !== "amount")) {
      it.discount = null;
    } else {
      it.discount = { type, value: Math.max(0, value) };
    }
  }
  ticket.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
}

function removeLine(ticketId, lineId) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;
  const prevKitchenStatus = ticket.kitchenStatus;
  ticket.items = (ticket.items || []).filter(x => x.lineId !== lineId);
  refreshTicketKitchenAndTables(ticket, prevKitchenStatus);
}


function setTicketMeta(ticketId, patch) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;
  if (!patch || typeof patch !== "object") return;

  if (typeof patch.customerName === "string") ticket.customerName = patch.customerName.slice(0, 60);
  if (typeof patch.customerPhone === "string") ticket.customerPhone = patch.customerPhone.slice(0, 32);
  if (typeof patch.customerAddress === "string") ticket.customerAddress = patch.customerAddress.slice(0, 120);
  if (typeof patch.notes === "string") ticket.notes = patch.notes.slice(0, 180);
  if (typeof patch.channel === "string" && ["salon", "mostrador", "delivery"].includes(patch.channel)) ticket.channel = patch.channel;

  // NUEVO v8: datos fiscales por ticket (receptor / tipo comprobante)
  if (!ticket.fiscal) ticket.fiscal = {};
  if (typeof patch.fiscalDocType === "string") ticket.fiscal.docType = patch.fiscalDocType.slice(0, 32);
  if (typeof patch.receiverDocType === "string") ticket.fiscal.receiverDocType = patch.receiverDocType.slice(0, 16); // DNI|CUIT|...
  if (typeof patch.receiverDocNumber === "string") ticket.fiscal.receiverDocNumber = patch.receiverDocNumber.slice(0, 16);
  if (typeof patch.receiverName === "string") ticket.fiscal.receiverName = patch.receiverName.slice(0, 80);
  if (typeof patch.receiverIva === "string") ticket.fiscal.receiverIva = patch.receiverIva.slice(0, 40);

  ticket.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
}


function setKitchenStatus(ticketId, status, meta = null) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;
  if (!ITEM_KITCHEN_STATUSES.has(status)) return;
  const prevKitchenStatus = ticket.kitchenStatus;
  normalizeTicketItems(ticket);

  const scope = meta && typeof meta === "object" ? String(meta.scope || "") : "";
  let changed = false;

  if (scope === "pending") {
    if (status === "en_preparacion") changed = updateItemsKitchenStatus(ticket, new Set(["recibido"]), "en_preparacion");
    else if (status === "listo") changed = updateItemsKitchenStatus(ticket, new Set(["recibido","en_preparacion"]), "listo");
    else if (status === "recibido") changed = updateItemsKitchenStatus(ticket, new Set(["en_preparacion"]), "recibido");
  } else if (scope === "ready") {
    if (status === "entregado") changed = updateItemsKitchenStatus(ticket, new Set(["listo"]), "entregado");
    else if (status === "en_preparacion") changed = updateItemsKitchenStatus(ticket, new Set(["listo"]), "en_preparacion");
  } else if (scope === "delivered") {
    if (status === "listo") changed = updateItemsKitchenStatus(ticket, new Set(["entregado"]), "listo");
  }

  if (!changed) {
    if (status === "recibido") changed = updateItemsKitchenStatus(ticket, new Set(["borrador"]), "recibido");
    else if (status === "en_preparacion") changed = updateItemsKitchenStatus(ticket, new Set(["recibido"]), "en_preparacion");
    else if (status === "listo") changed = updateItemsKitchenStatus(ticket, new Set(["recibido","en_preparacion"]), "listo");
    else if (status === "entregado") changed = updateItemsKitchenStatus(ticket, new Set(["listo"]), "entregado");
  }

  if (changed) {
    refreshTicketKitchenAndTables(ticket, prevKitchenStatus);
  }
}

function sendNewItemsToKitchen(ticketId) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return 0;
  const prevKitchenStatus = ticket.kitchenStatus;
  normalizeTicketItems(ticket);
  let moved = 0;
  for (const it of ticket.items) {
    if (String(it.kitchenStatus || "borrador") === "borrador") {
      it.kitchenStatus = "recibido";
      moved += Number(it.qty || 0);
    }
  }
  if (moved > 0) refreshTicketKitchenAndTables(ticket, prevKitchenStatus);
  return moved;
}

function ticketDiscountAmount(ticket, subtotal) {
  const base = Number.isFinite(subtotal) ? subtotal : 0;
  const d = (ticket && ticket.discount && typeof ticket.discount === "object") ? ticket.discount : null;
  if (!d) return 0;
  const type = String(d.type || "").toLowerCase();
  const raw = Number(d.value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (type === "percent") {
    const pct = Math.min(100, Math.max(0, raw));
    return Math.min(base, base * (pct / 100));
  }
  if (type === "amount") {
    return Math.min(base, Math.max(0, raw));
  }
  return 0;
}

function ticketTotal(ticket) {
  const subtotal = (ticket.items || []).reduce((a, it) => {
    const unit = Number(it.unitPrice || 0);
    const qty = Number(it.qty || 0);
    if (!Number.isFinite(unit) || !Number.isFinite(qty) || qty <= 0) return a;
    const lineSubtotal = unit * qty;
    const d = it.discount;
    let lineDiscount = 0;
    if (d && typeof d === "object") {
      const type = String(d.type || "").toLowerCase();
      const raw = Number(d.value || 0);
      if (Number.isFinite(raw) && raw > 0) {
        if (type === "percent") lineDiscount = Math.min(lineSubtotal, lineSubtotal * (Math.min(100, raw) / 100));
        if (type === "amount") lineDiscount = Math.min(lineSubtotal, raw);
      }
    }
    return a + Math.max(0, lineSubtotal - lineDiscount);
  }, 0);
  const discount = ticketDiscountAmount(ticket, subtotal);
  return Math.max(0, subtotal - discount);
}

function setTicketDiscount(ticketId, discount) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;
  if (!discount || typeof discount !== "object") {
    delete ticket.discount;
  } else {
    const type = String(discount.type || "").toLowerCase();
    const value = Number(discount.value || 0);
    if (!Number.isFinite(value) || value <= 0 || (type !== "percent" && type !== "amount")) {
      delete ticket.discount;
    } else {
      ticket.discount = { type, value: Math.max(0, value) };
    }
  }
  ticket.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
}

// ------------------ Costes (coste de producción) ------------------
function computeRecipeCost(productId) {
  const recipes = (DB.inventory && DB.inventory.recipes) ? DB.inventory.recipes : {};
  const rec = recipes[String(productId || "")];
  if (!Array.isArray(rec) || rec.length === 0) return 0;
  const ingIndex = new Map(((DB.inventory && DB.inventory.ingredients) || []).map(i => [i.id, i]));
  let cost = 0;
  for (const r of rec) {
    if (!r) continue;
    const ing = ingIndex.get(String(r.ingredientId || ""));
    if (!ing) continue;
    const qty = Number(r.qty || 0);
    const cpu = Number(ing.costPerUnit || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(cpu) || cpu <= 0) continue;
    cost += qty * cpu;
  }
  return Math.max(0, cost);
}

function computeProductCost(productId) {
  const pid = String(productId || "");
  if (!pid) return 0;
  const recipeCost = computeRecipeCost(pid);
  if (recipeCost > 0) return recipeCost;
  const p = (DB.products || []).find(x => x && x.id === pid);
  return Math.max(0, Number((p && p.prodCost) || 0));
}

function computeItemsCost(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let sum = 0;
  for (const it of items) {
    const qty = Number(it.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    sum += computeProductCost(it.productId) * qty;
  }
  return Math.max(0, sum);
}


function recordCashMovement({ dateKey, type, method, amount, note }) {
  DB.cash.movements.unshift({
    id: uid(),
    dateKey,
    at: now(),
    type,           // in|out
    method: method || "efectivo",
    amount: Number(amount || 0),
    note: String(note || "").slice(0, 120),
  });
}

function recordCajaMayorMovement({ dateKey, type, amount, note, by }) {
  if (!DB.cajaMayor) DB.cajaMayor = { movements: [] };
  if (!Array.isArray(DB.cajaMayor.movements)) DB.cajaMayor.movements = [];
  DB.cajaMayor.movements.unshift({
    id: uid(),
    dateKey,
    at: now(),
    type, // in|out
    amount: Number(amount || 0),
    note: String(note || "").slice(0, 120),
    by: String(by || "").slice(0, 40)
  });
}

function getOpenCashTurn(dateKey){
  const key = String(dateKey || ymd());
  if (!DB.cash || !Array.isArray(DB.cash.turns)) return null;
  return DB.cash.turns.find(t => t && t.dateKey === key && !t.closedAt) || null;
}

function getAnyOpenCashTurn(){
  if (!DB.cash || !Array.isArray(DB.cash.turns)) return null;
  return DB.cash.turns.find(t => t && !t.closedAt && !t.locked) || null;
}

function getOpenCashSession(dateKey){
  const key = String(dateKey || ymd());
  if (!DB.cash || !Array.isArray(DB.cash.sessions)) return null;
  return DB.cash.sessions.find(s => s && s.dateKey === key && !s.closedAt) || null;
}

function getAnyOpenCashSession(){
  if (!DB.cash || !Array.isArray(DB.cash.sessions)) return null;
  return DB.cash.sessions.find(s => s && !s.closedAt) || null;
}

function recordCashTransfer(payload = {}, by = "Sistema"){
  const dateKey = String(payload.dateKey || ymd());
  const dir = String(payload.direction || "toMayor");
  const amount = sumNumber(payload.amount);
  if (amount <= 0) return;
  const note = String(payload.note || "").slice(0, 120);
  const openTurn = getOpenCashTurn(dateKey);
  if (dir === "toMayor") {
    recordCashMovement({ dateKey, type: "out", method: "caja_mayor", amount, note });
    recordCajaMayorMovement({ dateKey, type: "in", amount, note, by });
    if (openTurn) {
      if (!openTurn.exits) openTurn.exits = {};
      if (!Array.isArray(openTurn.exits.transfersOut)) openTurn.exits.transfersOut = [];
      openTurn.exits.transfersOut.push({ amount, note, at: now() });
    }
  } else {
    recordCashMovement({ dateKey, type: "in", method: "caja_mayor", amount, note });
    recordCajaMayorMovement({ dateKey, type: "out", amount, note, by });
    if (openTurn) {
      if (!openTurn.entries) openTurn.entries = {};
      if (!Array.isArray(openTurn.entries.transfersIn)) openTurn.entries.transfersIn = [];
      openTurn.entries.transfersIn.push({ amount, note, at: now() });
    }
  }
  DB.updatedAt = now();
  scheduleSave();
}

function getDayBlockMessage(kind){
  const k = String(kind || "");
  if (k.startsWith("ticket:") || k.startsWith("table:")) {
    return "Primero abri el dia en Caja/Cierre para usar mesas y comandas.";
  }
  if (k.startsWith("cash:turn")) {
    return "Primero abri el dia en Caja/Cierre para abrir el turno.";
  }
  if (k.startsWith("cash:")) {
    return "Primero abri el dia en Caja/Cierre para operar caja.";
  }
  return "Primero abri el dia en Caja/Cierre para poder operar.";
}

function sumNumber(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }

function calcDenomsTotal(denoms){
  if(!denoms || typeof denoms !== "object") return 0;
  return Object.keys(denoms).reduce((a,k)=>a + (Number(k||0) * Number(denoms[k]||0)), 0);
}

function calcTurnTotals(turn){
  const entries = turn.entries || {};
  const nonCash = Array.isArray(turn.nonCash) ? turn.nonCash : [];
  const exits = turn.exits || {};
  const transfersIn = Array.isArray(entries.transfersIn) ? entries.transfersIn : [];
  const transfersOut = Array.isArray(exits.transfersOut) ? exits.transfersOut : [];
  const transfersInTotal = transfersIn.reduce((a,x)=>a + sumNumber(x.amount), 0);
  const transfersOutTotal = transfersOut.reduce((a,x)=>a + sumNumber(x.amount), 0);
  const nonCashTotal = nonCash.reduce((a,x)=>a + sumNumber(x.amount), 0);
  const totalEntries = sumNumber(entries.billingZ) + sumNumber(entries.billingB) + sumNumber(entries.aportes) + nonCashTotal + transfersInTotal - sumNumber(entries.anulados);
  const totalExits =
    (Array.isArray(exits.providers)? exits.providers.reduce((a,x)=>a + sumNumber(x.amount),0):0) +
    (Array.isArray(exits.expenses)? exits.expenses.reduce((a,x)=>a + sumNumber(x.amount),0):0) +
    (Array.isArray(exits.withdrawals)? exits.withdrawals.reduce((a,x)=>a + sumNumber(x.amount),0):0) +
    (Array.isArray(exits.extraPay)? exits.extraPay.reduce((a,x)=>a + sumNumber(x.amount),0):0) +
    (Array.isArray(exits.advances)? exits.advances.reduce((a,x)=>a + sumNumber(x.amount),0):0) +
    (Array.isArray(exits.others)? exits.others.reduce((a,x)=>a + sumNumber(x.amount),0):0) +
    transfersOutTotal;
  const saldoContable = sumNumber(turn.openingTotal) + totalEntries - totalExits;
  const saldoFisico = sumNumber(turn.closingTotal);
  const diferencia = saldoFisico - saldoContable;
  return { totalEntries, totalExits, saldoContable, saldoFisico, diferencia, nonCashTotal };
}

function openCashTurn(payload = {}, by = "Sistema"){
  if (!DB.cash) DB.cash = { openSessionId: null, sessions: [], movements: [], turns: [] };
  if (!Array.isArray(DB.cash.sessions)) DB.cash.sessions = [];
  if (!Array.isArray(DB.cash.turns)) DB.cash.turns = [];
  const dateKey = String(payload.dateKey || ymd());
  const shift = (String(payload.shift || "dia").toLowerCase() === "noche") ? "noche" : "dia";
  const cashier = String(payload.cashier || "").slice(0, 60);
  const existingOpen = DB.cash.turns.find(t => t && t.dateKey === dateKey && !t.closedAt);
  const openingDenoms = payload.openingDenoms && typeof payload.openingDenoms === "object" ? payload.openingDenoms : {};
  const openingTotal = calcDenomsTotal(openingDenoms);
  if (!getOpenCashSession(dateKey)) {
    const openAmount = existingOpen ? Number(existingOpen.openingTotal || openingTotal || 0) : openingTotal;
    cashOpenForDate(dateKey, openAmount, existingOpen ? "Desde turno existente" : "Desde apertura de turno");
  }
  if (existingOpen) return;
  const turn = {
    id: uid(),
    dateKey,
    shift,
    cashier,
    openedAt: now(),
    openedBy: String(by || "").slice(0, 40),
    openingDenoms,
    openingTotal,
    entries: {
      billingZ: 0,
      billingB: 0,
      aportes: 0,
      anulados: 0,
      transfersIn: []
    },
    nonCash: [],
    exits: {
      providers: [],
      expenses: [],
      withdrawals: [],
      extraPay: [],
      advances: [],
      others: [],
      transfersOut: []
    },
    closingDenoms: {},
    closingTotal: 0,
    totals: {},
    closedAt: null,
    closedBy: "",
    locked: false
  };
  DB.cash.turns.unshift(turn);
  DB.updatedAt = now();
  scheduleSave();
}

function updateCashTurn(payload = {}){
  const id = String(payload.id || "");
  const t = (DB.cash && Array.isArray(DB.cash.turns)) ? DB.cash.turns.find(x => x && x.id === id) : null;
  if (!t || t.closedAt) return;
  if (payload.entries && typeof payload.entries === "object") {
    t.entries = {
      billingZ: sumNumber(payload.entries.billingZ),
      billingB: sumNumber(payload.entries.billingB),
      aportes: sumNumber(payload.entries.aportes),
      anulados: sumNumber(payload.entries.anulados),
      transfersIn: Array.isArray(payload.entries.transfersIn)
        ? payload.entries.transfersIn.map(x=>({
            amount: sumNumber(x.amount),
            note: String(x.note||"").slice(0, 120),
            at: Number(x.at || now())
          })).slice(0, 400)
        : (t.entries && Array.isArray(t.entries.transfersIn) ? t.entries.transfersIn : [])
    };
  }
  if (Array.isArray(payload.nonCash)) {
    t.nonCash = payload.nonCash.map(x=>({
      method: String(x.method||"").slice(0, 40),
      amount: sumNumber(x.amount),
      note: String(x.note||"").slice(0, 80)
    })).slice(0, 200);
  }
  if (payload.exits && typeof payload.exits === "object") {
    const normList = (arr)=>Array.isArray(arr)?arr.map(x=>({
      name: String(x.name||"").slice(0, 80),
      doc: String(x.doc||"").slice(0, 80),
      amount: sumNumber(x.amount),
      note: String(x.note||"").slice(0, 120)
    })).slice(0, 200):[];
    t.exits = {
      providers: normList(payload.exits.providers),
      expenses: normList(payload.exits.expenses),
      withdrawals: normList(payload.exits.withdrawals),
      extraPay: normList(payload.exits.extraPay),
      advances: normList(payload.exits.advances),
      others: normList(payload.exits.others),
      transfersOut: Array.isArray(payload.exits.transfersOut)
        ? payload.exits.transfersOut.map(x=>({
            amount: sumNumber(x.amount),
            note: String(x.note||"").slice(0, 120),
            at: Number(x.at || now())
          })).slice(0, 400)
        : (t.exits && Array.isArray(t.exits.transfersOut) ? t.exits.transfersOut : [])
    };
  }
  if (payload.openingDenoms && typeof payload.openingDenoms === "object") {
    t.openingDenoms = payload.openingDenoms;
    t.openingTotal = calcDenomsTotal(t.openingDenoms);
  }
  if (payload.closingDenoms && typeof payload.closingDenoms === "object") {
    t.closingDenoms = payload.closingDenoms;
    t.closingTotal = calcDenomsTotal(t.closingDenoms);
  }
  if (payload.cashier !== undefined) t.cashier = String(payload.cashier||"").slice(0, 60);
  DB.updatedAt = now();
  scheduleSave();
}

function closeCashTurn(payload = {}, by = "Sistema"){
  const id = String(payload.id || "");
  let t = (DB.cash && Array.isArray(DB.cash.turns)) ? DB.cash.turns.find(x => x && x.id === id) : null;
  if (!t) {
    const dateKey = String(payload.dateKey || ymd());
    t = (DB.cash && Array.isArray(DB.cash.turns)) ? DB.cash.turns.find(x => x && x.dateKey === dateKey && !x.closedAt) : null;
  }
  if (!t || t.closedAt) return;
  if (payload.closingDenoms && typeof payload.closingDenoms === "object") {
    t.closingDenoms = payload.closingDenoms;
    t.closingTotal = calcDenomsTotal(t.closingDenoms);
  }
  t.totals = calcTurnTotals(t);
  t.closedAt = now();
  t.closedBy = String(by || "").slice(0, 40);
  t.locked = true;
  DB.updatedAt = now();
  scheduleSave();

  const hasClosingCount = t.closingDenoms && Object.keys(t.closingDenoms).length > 0;
  if (hasClosingCount && canCloseDayForKey(t.dateKey)) {
    closeDay({
      dateKey: t.dateKey,
      closingCash: Number.isFinite(t.closingTotal) ? t.closingTotal : 0,
      note: "Cierre automatico por turno",
      closedBy: t.closedBy || by
    });
  }
}

// ------------------ Fiscal (ARCA/Controladores) ------------------
function normalizePos(pos) {
  const s = String(pos || "0001").replace(/\D/g, "");
  return s.padStart(4, "0").slice(-4);
}

function nextFiscalNumber(pos, docType) {
  const p = normalizePos(pos);
  const k = `${p}:${String(docType || "DOC").toUpperCase()}`;
  const cur = Number((DB.settings.fiscal && DB.settings.fiscal.counters && DB.settings.fiscal.counters[k]) || 0);
  const next = Math.max(0, cur) + 1;
  if (!DB.settings.fiscal.counters) DB.settings.fiscal.counters = {};
  DB.settings.fiscal.counters[k] = next;
  return next;
}

  function createFiscalDocForSale(sale, ticket) {
    const fiscal = DB.settings.fiscal || {};
    const fiscalType = String(sale.fiscalType || "no_fiscal");
    if (!fiscal.enabled || fiscalType === "no_fiscal") return null;

  const docType = String((ticket && ticket.fiscal && ticket.fiscal.docType) || (fiscal.docTypeByFiscalType && fiscal.docTypeByFiscalType[fiscalType]) || "FACTURA_C");
  const pos = normalizePos(fiscal.pos);
  const number = nextFiscalNumber(pos, docType);

  const receiverDocType = (ticket && ticket.fiscal && ticket.fiscal.receiverDocType) ? String(ticket.fiscal.receiverDocType) : "DNI";
  const receiverDocNumber = (ticket && ticket.fiscal && ticket.fiscal.receiverDocNumber) ? String(ticket.fiscal.receiverDocNumber) : "";
  const receiverName = (ticket && ticket.fiscal && ticket.fiscal.receiverName) ? String(ticket.fiscal.receiverName) : (ticket.customerName || "");
  const receiverIva = (ticket && ticket.fiscal && ticket.fiscal.receiverIva) ? String(ticket.fiscal.receiverIva) : "";

  const doc = {
    id: uid(),
    saleId: sale.id,
    at: now(),
    issueDate: ymd(),
    status: "pendiente", // pendiente|emitido|anulado
    provider: String(fiscal.provider || "manual"),
    environment: String(fiscal.environment || "homologacion"),
    fiscalType,
    docType,
    pos,
    number,
    cae: "",
    caeDue: "",
    total: Number(sale.total || 0),
    currency: String(DB.settings.currency || "ARS"),
    company: { ...(fiscal.company || {}) },
    receiverDocType,
    receiverDocNumber,
    receiverName,
    receiverIva,
    observations: [],
    qrUrl: "",
  };

  DB.fiscalDocs.unshift(doc);
  scheduleSave();
    emitFiscalDocumentAsync(doc, sale, ticket);
    return doc;
  }

  function createFiscalDocFromSale(sale, opts = {}) {
    if (!sale || !sale.id) return null;
    const fiscal = DB.settings.fiscal || {};
    const fiscalType = String(sale.fiscalType || "no_fiscal");
    const includeAll = opts.includeAll !== false;
    if (!includeAll && fiscalType === "no_fiscal") return null;

    const receiver = sale.receiver || {};
    const docType = String(receiver.docType
      || (fiscal.docTypeByFiscalType && fiscal.docTypeByFiscalType[fiscalType])
      || (fiscal.docTypeByFiscalType && fiscal.docTypeByFiscalType.manual)
      || "FACTURA_C");
    const pos = normalizePos(fiscal.pos);
    const number = nextFiscalNumber(pos, docType);

    const receiverDocType = receiver.receiverDocType ? String(receiver.receiverDocType) : "";
    const receiverDocNumber = receiver.receiverDocNumber ? String(receiver.receiverDocNumber) : "";
    const receiverName = receiver.receiverName ? String(receiver.receiverName) : (sale.customerName || "");
    const receiverIva = receiver.receiverIva ? String(receiver.receiverIva) : "";

    const doc = {
      id: uid(),
      saleId: sale.id,
      at: now(),
      issueDate: sale.dateKey || ymd(sale.at),
      status: "pendiente",
      provider: "manual",
      environment: "manual",
      fiscalType: (fiscalType === "no_fiscal") ? "manual" : fiscalType,
      docType,
      pos,
      number,
      cae: "",
      caeDue: "",
      total: Number(sale.total || 0),
      currency: String(DB.settings.currency || "ARS"),
      company: { ...(fiscal.company || {}) },
      receiverDocType,
      receiverDocNumber,
      receiverName,
      receiverIva,
      observations: [],
      qrUrl: "",
    };

    DB.fiscalDocs.unshift(doc);
    scheduleSave();
    return doc;
  }

function ensureFiscalDocForSale(saleId, opts = {}) {
  const id = String(saleId || "");
  if (!id) return null;
  const sale = (DB.sales || []).find(s => String(s.id || "") === id);
  if (!sale) return null;
  const existing = (DB.fiscalDocs || []).find(d => String(d.saleId || "") === id);
  if (existing) return existing;
  const doc = createFiscalDocFromSale(sale, opts);
  if (doc) {
    sale.fiscalDocId = doc.id;
    sale.fiscal = { docId: doc.id, docType: doc.docType, pos: doc.pos, number: doc.number, status: doc.status };
    DB.updatedAt = now();
    scheduleSave();
  }
  return doc;
}

async function appendFiscalAttachment(doc, attachment) {
  if (!doc || !attachment) return;
  const data = String(attachment.data || "");
  const url = await saveFiscalAttachment(data, attachment.name);
  if (!url) return;
  if (!Array.isArray(doc.attachments)) doc.attachments = [];
  const item = {
    id: uid(),
    name: String(attachment.name || "adjunto").slice(0, 120),
    type: String(attachment.type || "").slice(0, 80),
    url,
    at: now(),
  };
  doc.attachments.push(item);
  while (doc.attachments.length > 6) {
    const removed = doc.attachments.shift();
    if (removed && removed.url) await removeStoredImage(removed.url);
  }
}

  function generateFiscalDocsFromSales(opts = {}) {
    const sales = Array.isArray(DB.sales) ? DB.sales.slice() : [];
    const existing = new Set((DB.fiscalDocs || []).map(d => String(d.saleId || "")));
    const includeAll = opts.includeAll !== false;
    // oldest first for numbering
    sales.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
    let created = 0;
    sales.forEach(sale => {
      if (!sale || !sale.id) return;
      if (existing.has(String(sale.id))) return;
      const doc = createFiscalDocFromSale(sale, { includeAll });
      if (doc) {
        existing.add(String(sale.id));
        sale.fiscalDocId = doc.id;
        sale.fiscal = { docId: doc.id, docType: doc.docType, pos: doc.pos, number: doc.number, status: doc.status };
        created += 1;
      }
    });
    if (created) {
      DB.updatedAt = now();
      scheduleSave();
    }
    return created;
  }

async function markFiscalDocIssued(docId, patch = {}) {
  const doc = (DB.fiscalDocs || []).find(d => d.id === docId);
  if (!doc) return;
  if (typeof patch.docType === "string") doc.docType = patch.docType.slice(0, 32);
  if (patch.pos !== undefined) doc.pos = normalizePos(patch.pos);
  if (patch.number !== undefined) {
    const num = Number(patch.number);
    if (Number.isFinite(num) && num > 0) doc.number = Math.floor(num);
  }
  if (typeof patch.cae === "string") doc.cae = patch.cae.replace(/\D/g, "").slice(0, 14);
  if (typeof patch.caeDue === "string") doc.caeDue = patch.caeDue.slice(0, 10);
  if (typeof patch.status === "string") doc.status = patch.status.slice(0, 16);

  if (patch.observations) {
    const list = Array.isArray(patch.observations) ? patch.observations : [patch.observations];
    list.forEach(value => appendFiscalObservation(doc, value));
  }

  if (patch.providerResponse && typeof patch.providerResponse === "object") {
    const resp = {};
    if (patch.providerResponse.statusCode !== undefined) resp.statusCode = Number(patch.providerResponse.statusCode) || 0;
    if (patch.providerResponse.body) resp.body = String(patch.providerResponse.body).slice(0, 400);
    if (patch.providerResponse.error) resp.error = String(patch.providerResponse.error).slice(0, 400);
    doc.providerResponse = resp;
  }

  if (patch.attachment) await appendFiscalAttachment(doc, patch.attachment);
  if (Array.isArray(patch.attachments)) {
    for (const attachment of patch.attachments) {
      await appendFiscalAttachment(doc, attachment);
    }
  }

  doc.qrUrl = buildArcaQrUrl(doc);
  doc.updatedAt = now();

  // reflejar en sale/ticket
  const sale = (DB.sales || []).find(s => s.id === doc.saleId);
  if (sale) {
    sale.fiscalDocId = doc.id;
    sale.fiscal = { docId: doc.id, docType: doc.docType, pos: doc.pos, number: doc.number, cae: doc.cae, caeDue: doc.caeDue, status: doc.status };
  }
  const ticket = (DB.tickets || []).find(t => t.id === (sale ? sale.ticketId : ""));
  if (ticket) ticket.fiscalDocId = doc.id;

  DB.updatedAt = now();
  scheduleSave();
}

function appendFiscalObservation(doc, value) {
  if (!doc) return;
  if (!Array.isArray(doc.observations)) doc.observations = [];
  const text = String(value || "").trim();
  if (!text) return;
  doc.observations.push(text.slice(0, 240));
  while (doc.observations.length > 12) doc.observations.shift();
}

function emitFiscalDocumentAsync(doc, sale, ticket) {
  const fiscal = (DB.settings && DB.settings.fiscal) ? DB.settings.fiscal : {};
  const provider = getFiscalProvider(fiscal);
  if (!provider || typeof provider.emitFiscalDoc !== "function") return;
  provider.emitFiscalDoc({ doc, sale, ticket, fiscal })
    .then(result => {
      if (!result) return;
      const patch = {
        status: result.status,
        cae: result.cae,
        caeDue: result.caeDue,
        observations: result.observations,
        providerResponse: result.providerResponse,
      };
      Promise.resolve(markFiscalDocIssued(doc.id, patch))
        .then(() => {
          if (typeof broadcastState === "function") broadcastState();
        })
        .catch(err => {
          updateFiscalDocWithError(doc, err);
        });
    })
    .catch(err => {
      updateFiscalDocWithError(doc, err);
    });
}

function updateFiscalDocWithError(doc, err) {
  if (!doc) return;
  const message = err && err.message ? String(err.message).trim() : "Error en proveedor fiscal";
  appendFiscalObservation(doc, message);
  doc.status = "error";
  doc.providerResponse = { error: message };
  doc.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
  if (typeof broadcastState === "function") broadcastState();
}

function closeTicket(ticketId, payload = {}) {
  const ticket = findTicket(ticketId);
  if (!ticket || ticket.status !== "abierta") return;

  const subtotal = (ticket.items || []).reduce((a, it) => {
    const unit = Number(it.unitPrice || 0);
    const qty = Number(it.qty || 0);
    if (!Number.isFinite(unit) || !Number.isFinite(qty) || qty <= 0) return a;
    const lineSubtotal = unit * qty;
    const d = it.discount;
    let lineDiscount = 0;
    if (d && typeof d === "object") {
      const type = String(d.type || "").toLowerCase();
      const raw = Number(d.value || 0);
      if (Number.isFinite(raw) && raw > 0) {
        if (type === "percent") lineDiscount = Math.min(lineSubtotal, lineSubtotal * (Math.min(100, raw) / 100));
        if (type === "amount") lineDiscount = Math.min(lineSubtotal, raw);
      }
    }
    return a + Math.max(0, lineSubtotal - lineDiscount);
  }, 0);
  const discountAmount = ticketDiscountAmount(ticket, subtotal);
  const total = Math.max(0, subtotal - discountAmount);
  const dateKey = ymd();
  const cost = computeItemsCost(ticket.items || []);
  const profit = total - cost;

  const paymentMethod = String(payload.paymentMethod || "efectivo");
  const fiscalType = String(payload.fiscalType || "no_fiscal"); // no_fiscal|factura_electronica|controlador_fiscal
  const paid = Number(payload.paid ?? total);
  if (!Number.isFinite(paid) || paid + 0.00001 < total) return null;
  const change = Math.max(0, paid - total);

  // registra venta
  const sale = {
    id: uid(),
    dateKey,
    at: now(),
    ticketId: ticket.id,
    channel: ticket.channel,
    tableId: ticket.tableId,
    items: (ticket.items || []).map(x => ({ ...x })),
    subtotal,
    lineDiscounts: (ticket.items || []).map(it => ({
      lineId: it.lineId || "",
      discount: it.discount || null
    })),
    discount: ticket.discount ? { ...ticket.discount } : null,
    discountAmount,
    total,
    cost,
    profit,
    paymentMethod,
    fiscalType,
    paid,
    change,
    customerName: ticket.customerName || "",
    customerPhone: ticket.customerPhone || "",
    customerAddress: ticket.customerAddress || "",
    fiscal: {},
    fiscalDocId: null,
    receiver: ticket.fiscal ? { ...ticket.fiscal } : {},
  };
  DB.sales.unshift(sale);

  // movimientos de caja/banco
  if (paymentMethod === "efectivo") {
    recordCashMovement({ dateKey, type: "in", method: "efectivo", amount: total, note: `Venta ${sale.id}` });
  } else if (paymentMethod === "mercadopago") {
    recordCashMovement({ dateKey, type: "in", method: "mercadopago", amount: total, note: `Venta ${sale.id}` });
  } else if (paymentMethod === "transferencia") {
    recordCashMovement({ dateKey, type: "in", method: "transferencia", amount: total, note: `Venta ${sale.id}` });
  } else {
    recordCashMovement({ dateKey, type: "in", method: paymentMethod, amount: total, note: `Venta ${sale.id}` });
  }

  // stock por recetas (si hay recetas definidas)
  const recipes = DB.inventory.recipes || {};
  const ingIndex = new Map((DB.inventory.ingredients || []).map(i => [i.id, i]));
  for (const it of (ticket.items || [])) {
    const rec = recipes[it.productId];
    if (!Array.isArray(rec)) continue;
    for (const r of rec) {
      const ing = ingIndex.get(r.ingredientId);
      if (!ing) continue;
      const qty = Number(r.qty || 0) * Number(it.qty || 0);
      if (Number.isFinite(qty) && qty > 0) ing.onHand = Number(ing.onHand || 0) - qty;
    }
  }

  // NUEVO v8: documento fiscal (modo fiscal real)
  const fiscal = DB.settings.fiscal || {};
  if (fiscal && fiscal.enabled && fiscalType !== "no_fiscal") {
    const doc = createFiscalDocForSale(sale, ticket);
    if (doc) {
      sale.fiscalDocId = doc.id;
      sale.fiscal = { docId: doc.id, docType: doc.docType, pos: doc.pos, number: doc.number, status: doc.status };
      ticket.fiscalDocId = doc.id;
    }
  }

  normalizeTicketItems(ticket);
  for (const it of (ticket.items || [])) {
    it.kitchenStatus = "entregado";
  }
  ticket.status = "cerrada";
  ticket.kitchenStatus = "entregado";
  ticket.closedAt = now();
  ticket.paymentMethod = paymentMethod;
  ticket.fiscalType = fiscalType;
  ticket.updatedAt = now();

  // libera mesa y conexiones temporales
  if (ticket.channel === "salon") {
    releaseTicketTables(ticket);
  }

  DB.updatedAt = now();
  scheduleSave();
}


function setTableReceived(tableId, received) {
  const table = findTable(tableId);
  if (!table) return;
  table.received = !!received;
  table.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
  return sale;
}

function cashOpenForDate(dateKey, openingCash = 0, note = "") {
  if (!DB.cash) DB.cash = { openSessionId: null, sessions: [], movements: [], turns: [] };
  if (!Array.isArray(DB.cash.sessions)) DB.cash.sessions = [];
  const key = String(dateKey || ymd());
  const existing = DB.cash.sessions.find(s => s.dateKey === key && !s.closedAt);
  if (existing) {
    DB.cash.openSessionId = existing.id;
    DB.updatedAt = now();
    scheduleSave();
    return;
  }
  const ses = {
    id: uid(),
    dateKey: key,
    openedAt: now(),
    openingCash: Number(openingCash || 0),
    closedAt: null,
    closingCash: null,
    note: String(note || "").slice(0, 120),
  };
  DB.cash.sessions.unshift(ses);
  DB.cash.openSessionId = ses.id;
  DB.updatedAt = now();
  scheduleSave();
}

function getDayCloseCutoffMinutes() {
  const hour = Number(DB.settings && DB.settings.cash && DB.settings.cash.dayCloseCutoffHour);
  const safeHour = Number.isFinite(hour) ? Math.max(0, Math.min(23.99, hour)) : 2;
  return Math.round(safeHour * 60);
}

function getBusinessDateKey(ts = Date.now()) {
  const cutoffMinutes = getDayCloseCutoffMinutes();
  if (cutoffMinutes <= 0) return ymd(ts);
  const d = new Date(ts);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const base = ymd(ts);
  return minutes <= cutoffMinutes ? dateKeyAddDays(base, -1) : base;
}

function canAutoCloseDay(dateKey, ts = Date.now()) {
  const key = String(dateKey || "");
  if (!key) return false;
  const businessKey = getBusinessDateKey(ts);
  if (key !== businessKey) return false;
  const closures = Array.isArray(DB.dayClosures) ? DB.dayClosures : [];
  if (closures.some(c => c && c.dateKey === key)) return false;
  const openTurns = (DB.cash && Array.isArray(DB.cash.turns))
    ? DB.cash.turns.some(t => t && t.dateKey === key && !t.closedAt && !t.locked)
    : false;
  return !openTurns;
}

function canCloseDayForKey(dateKey) {
  const key = String(dateKey || "");
  if (!key) return false;
  const closures = Array.isArray(DB.dayClosures) ? DB.dayClosures : [];
  if (closures.some(c => c && c.dateKey === key)) return false;
  const openTurns = (DB.cash && Array.isArray(DB.cash.turns))
    ? DB.cash.turns.some(t => t && t.dateKey === key && !t.closedAt && !t.locked)
    : false;
  return !openTurns;
}

function cashOpen(openingCash = 0, note = "") {
  cashOpenForDate(ymd(), openingCash, note);
}

function cashClose(closingCash = 0, note = "", dateKeyOverride = "") {
  const dateKey = String(dateKeyOverride || ymd());
  const ses = DB.cash.sessions.find(s => s.dateKey === dateKey && !s.closedAt);
  if (!ses) return;
  ses.closedAt = now();
  ses.closingCash = Number(closingCash || 0);
  ses.note = String(note || ses.note || "").slice(0, 120);
  DB.cash.openSessionId = null;
  DB.updatedAt = now();
  scheduleSave();
}

function updateCashSession(payload = {}) {
  const dateKey = String(payload.dateKey || ymd());
  const ses = DB.cash.sessions.find(s => s.dateKey === dateKey && !s.closedAt);
  if (!ses) return;
  if (payload.openingCash !== undefined) ses.openingCash = Number(payload.openingCash || 0);
  if (payload.note !== undefined) ses.note = String(payload.note || ses.note || "").slice(0, 120);
  DB.updatedAt = now();
  scheduleSave();
}

function setIngredient(ingredientId, patch) {
  const ing = (DB.inventory.ingredients || []).find(x => x.id === ingredientId);
  if (!ing) return;
  if (typeof patch.name === "string") ing.name = patch.name.slice(0, 60);
  if (typeof patch.unit === "string") ing.unit = patch.unit.slice(0, 16);
  if (patch.onHand !== undefined) ing.onHand = Number(patch.onHand || 0);
  if (patch.costPerUnit !== undefined) ing.costPerUnit = Number(patch.costPerUnit || 0);
  if (patch.min !== undefined) ing.min = Number(patch.min || 0);
  DB.updatedAt = now();
  scheduleSave();
}

function addIngredient(payload) {
  const id = slugify(payload.name || "") || uid();
  if ((DB.inventory.ingredients || []).some(x => x.id === id)) return;
  DB.inventory.ingredients.unshift({
    id,
    name: String(payload.name || "Ingrediente").slice(0, 60),
    unit: String(payload.unit || "u").slice(0, 16),
    onHand: Number(payload.onHand || 0),
    costPerUnit: Number(payload.costPerUnit || 0),
    min: Number(payload.min || 0),
  });
  DB.updatedAt = now();
  scheduleSave();
}

function setRecipe(productId, recipeArr) {
  if (!DB.inventory.recipes) DB.inventory.recipes = {};
  if (!Array.isArray(recipeArr)) return;
  // normaliza
  const cleaned = recipeArr
    .map(x => ({ ingredientId: String(x.ingredientId || ""), qty: Number(x.qty || 0) }))
    .filter(x => x.ingredientId && Number.isFinite(x.qty) && x.qty > 0)
    .slice(0, 40);
  DB.inventory.recipes[productId] = cleaned;
  DB.updatedAt = now();
  scheduleSave();
}



function sanitizeModifiers(groups) {
  if (!Array.isArray(groups)) return [];
  const out = [];
  let gi = 0;
  for (const g of groups.slice(0, 30)) {
    if (!g) continue;
    const name = String(g.name || "").trim().slice(0, 60);
    if (!name) continue;
    const id = String(g.id || slugify(name) || ("g" + gi++)).slice(0, 32);
    const mode = (String(g.mode || "multi") === "single") ? "single" : "multi";
    const required = !!g.required;
    const min = Math.max(0, Math.min(99, Number.isFinite(Number(g.min)) ? Number(g.min) : (required ? 1 : 0)));
    const max = Math.max(min, Math.min(99, Number.isFinite(Number(g.max)) ? Number(g.max) : (mode === "single" ? 1 : 99)));
    const kind = String(g.kind || "").slice(0, 24);

    const options = [];
    let oi = 0;
    for (const o of (Array.isArray(g.options) ? g.options : []).slice(0, 60)) {
      if (!o) continue;
      const on = String(o.name || "").trim().slice(0, 80);
      if (!on) continue;
      const oid = String(o.id || slugify(on) || ("o" + oi++)).slice(0, 32);
      const price = Number.isFinite(Number(o.price)) ? Number(o.price) : 0;
      const cost = Number.isFinite(Number(o.cost)) ? Number(o.cost) : 0;
      const multiplier = (o.multiplier !== undefined && Number.isFinite(Number(o.multiplier))) ? Number(o.multiplier) : undefined;
      const def = !!o.default;
      const okind = String(o.kind || "").slice(0, 24);
      const note = String(o.note || "").slice(0, 120);
      const addProducts = Array.isArray(o.addProducts) ? o.addProducts.slice(0, 10).map(ap=>({productId:String(ap.productId||""), qty:Number(ap.qty||1)})).filter(ap=>ap.productId && Number.isFinite(ap.qty) && ap.qty>0 && ap.qty<=99) : undefined;
      options.push({ id: oid, name: on, price, cost, multiplier, default: def, kind: okind, addProducts, note });
    }

    out.push({ id, name, mode, required, min, max, kind, options });
  }
  return out;
}

function setProductSector(productId, sectorId) {
  const p = (DB.products || []).find(x => x.id === String(productId));
  if (!p) return;
  p.sectorId = String(sectorId || "general").trim() || "general";
  DB.updatedAt = now();
  scheduleSave();
}

function setProductModifiers(productId, modifiers) {
  const p = (DB.products || []).find(x => x.id === String(productId));
  if (!p) return;
  p.modifiers = sanitizeModifiers(modifiers);
  DB.updatedAt = now();
  scheduleSave();
}

function normalizeHexColor(val) {
  const s = String(val || "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s) || /^#[0-9a-f]{6}$/.test(s)) return s;
  return "";
}

function updateSettings(patch = {}) {
  if (!patch || typeof patch !== "object") return;

  if (!DB.settings) DB.settings = {};
  if (patch.restaurantName !== undefined) DB.settings.restaurantName = String(patch.restaurantName || "NEXA").slice(0, 40);
  if (patch.footerText !== undefined) DB.settings.footerText = String(patch.footerText || "").slice(0, 120);

  if (Array.isArray(patch.menuCategories)) {
    const cats = [];
    for (const c of patch.menuCategories.slice(0, 200)) {
      if (!c) continue;
      const title = String(c.title || "").trim().slice(0, 48);
      const id = String(c.id || slugify(title)).slice(0, 24);
      if (!title || !id) continue;
      const color = normalizeHexColor(c.color);
      const order = Number.isFinite(Number(c.order)) ? Number(c.order) : cats.length;
      cats.push({ id, title, color, order });
    }
    DB.settings.menuCategories = cats;
  }

  // cocina (sectores)
  if (patch.kitchen && typeof patch.kitchen === "object") {
    if (!DB.settings.kitchen) DB.settings.kitchen = { sectors: [] };
    if (Array.isArray(patch.kitchen.sectors)) {
      const sectors = [];
      for (const s of patch.kitchen.sectors.slice(0, 30)) {
        if (!s) continue;
        const name = String(s.name || "").trim().slice(0, 40);
        if (!name) continue;
        const id = String(s.id || slugify(name)).slice(0, 24) || "general";
        sectors.push({ id, name, enabled: (s.enabled === undefined) ? true : !!s.enabled });
      }
      if (!sectors.some(x => x.id === "general")) sectors.unshift({ id: "general", name: "General", enabled: true });
      DB.settings.kitchen.sectors = sectors;
    }
  }

  // impresión (sugerencias por sector)
  if (patch.printing && typeof patch.printing === "object") {
    if (!DB.settings.printing) DB.settings.printing = { sectorPrinters: {} };
    if (patch.printing.sectorPrinters && typeof patch.printing.sectorPrinters === "object") {
      DB.settings.printing.sectorPrinters = { ...(DB.settings.printing.sectorPrinters || {}), ...(patch.printing.sectorPrinters || {}) };
    }
    if (patch.printing.ticketWidthMm !== undefined) {
      const w = Number(patch.printing.ticketWidthMm);
      DB.settings.printing.ticketWidthMm = (w === 58 || w === 80) ? w : (DB.settings.printing.ticketWidthMm || 80);
    }
  }

  if (patch.cash && typeof patch.cash === "object") {
    if (!DB.settings.cash) DB.settings.cash = { dayCloseCutoffHour: 2 };
    if (patch.cash.dayCloseCutoffHour !== undefined) {
      const hour = Number(patch.cash.dayCloseCutoffHour);
      if (Number.isFinite(hour)) {
        DB.settings.cash.dayCloseCutoffHour = Math.max(0, Math.min(23.99, hour));
      }
    }
  }

  if (Array.isArray(patch.menuCategories)) {
    const cats = [];
    const seen = new Set();
    patch.menuCategories.slice(0, 80).forEach((c, idx) => {
      if (!c) return;
      const title = String(c.title || "").trim().slice(0, 48);
      if (!title) return;
      const id = String(c.id || slugify(title)).trim().slice(0, 24) || slugify(title);
      if (!id || seen.has(id)) return;
      seen.add(id);
      const color = normalizeHexColor(c.color);
      const order = Number.isFinite(Number(c.order)) ? Number(c.order) : idx;
      cats.push({ id, title, color, order });
    });
    DB.settings.menuCategories = cats;
  }

  // fiscal
  if (patch.fiscal && typeof patch.fiscal === "object") {
    if (!DB.settings.fiscal) DB.settings.fiscal = {};
    const f = DB.settings.fiscal;
    if (patch.fiscal.enabled !== undefined) f.enabled = !!patch.fiscal.enabled;
    if (patch.fiscal.provider !== undefined) f.provider = String(patch.fiscal.provider || "manual").slice(0, 16);
    if (patch.fiscal.environment !== undefined) f.environment = String(patch.fiscal.environment || "homologacion").slice(0, 16);
    if (patch.fiscal.pos !== undefined) f.pos = normalizePos(patch.fiscal.pos);
    if (patch.fiscal.company && typeof patch.fiscal.company === "object") {
      if (!f.company) f.company = {};
      const c = patch.fiscal.company;
      if (c.cuit !== undefined) f.company.cuit = String(c.cuit || "").slice(0, 13);
      if (c.razonSocial !== undefined) f.company.razonSocial = String(c.razonSocial || "").slice(0, 80);
      if (c.domicilio !== undefined) f.company.domicilio = String(c.domicilio || "").slice(0, 120);
      if (c.ivaCondicion !== undefined) f.company.ivaCondicion = String(c.ivaCondicion || "").slice(0, 40);
      if (c.iibb !== undefined) f.company.iibb = String(c.iibb || "").slice(0, 32);
      if (c.inicioActividades !== undefined) f.company.inicioActividades = String(c.inicioActividades || "").slice(0, 10);
    }
    if (patch.fiscal.docTypeByFiscalType && typeof patch.fiscal.docTypeByFiscalType === "object") {
      f.docTypeByFiscalType = { ...(f.docTypeByFiscalType || {}), ...(patch.fiscal.docTypeByFiscalType || {}) };
    }
    if (patch.fiscal.tipoCmpByDocType && typeof patch.fiscal.tipoCmpByDocType === "object") {
      f.tipoCmpByDocType = { ...(f.tipoCmpByDocType || {}), ...(patch.fiscal.tipoCmpByDocType || {}) };
    }
    if (patch.fiscal.counters && typeof patch.fiscal.counters === "object") {
      f.counters = { ...(f.counters || {}), ...(patch.fiscal.counters || {}) };
    }
    if (patch.fiscal.providerConfig && typeof patch.fiscal.providerConfig === "object") {
      if (!f.providerConfig) f.providerConfig = {};
      const cfg = patch.fiscal.providerConfig;
      if (cfg.endpointHomologacion !== undefined) f.providerConfig.endpointHomologacion = String(cfg.endpointHomologacion || "").slice(0, 250);
      if (cfg.endpointProduccion !== undefined) f.providerConfig.endpointProduccion = String(cfg.endpointProduccion || "").slice(0, 250);
      if (cfg.endpoint !== undefined) f.providerConfig.endpoint = String(cfg.endpoint || "").slice(0, 250);
      if (cfg.timeoutMs !== undefined) {
        const timeout = Number(cfg.timeoutMs);
        f.providerConfig.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : f.providerConfig.timeoutMs || 15000;
      }
      if (cfg.bearerToken !== undefined) f.providerConfig.bearerToken = String(cfg.bearerToken || "").slice(0, 250);
      if (cfg.certificatePem !== undefined) f.providerConfig.certificatePem = String(cfg.certificatePem || "").slice(0, 12000);
      if (cfg.privateKeyPem !== undefined) f.providerConfig.privateKeyPem = String(cfg.privateKeyPem || "").slice(0, 12000);
      if (cfg.pfxBase64 !== undefined) f.providerConfig.pfxBase64 = String(cfg.pfxBase64 || "").slice(0, 12000);
      if (cfg.passphrase !== undefined) f.providerConfig.passphrase = String(cfg.passphrase || "").slice(0, 120);
      if (cfg.rejectUnauthorized !== undefined) f.providerConfig.rejectUnauthorized = !!cfg.rejectUnauthorized;
    }
  }

  DB.updatedAt = now();
  scheduleSave();
}


async function upsertProduct(payload = {}) {
  const name = String(payload.name || "").trim().slice(0, 80);
  if (!name) return;

  const price = Number(payload.price || 0);
  const prodCost = Number(payload.prodCost ?? payload.productionCost ?? 0);
  const active = (payload.active === undefined) ? true : !!payload.active;

  const categoryTitle = String(payload.categoryTitle || payload.category || "Otros").trim().slice(0, 48) || "Otros";
  const categoryId = String(payload.categoryId || slugify(categoryTitle));
  const description = String(payload.description || "").slice(0, 240);
  const sku = String(payload.sku || "").slice(0, 64);
  const barcode = String(payload.barcode || "").slice(0, 64);
  const unit = String(payload.unit || "").slice(0, 32);
  const taxRate = Number(payload.taxRate || 0);
  const stockMin = Number(payload.stockMin || 0);
  const stockMax = Number(payload.stockMax || 0);
  const showStock = payload.showStock === undefined ? undefined : !!payload.showStock;
  const imageUrl = String(payload.imageUrl || "").slice(0, 20000);
  const imageData = payload.imageData;
  const notes = String(payload.notes || "").slice(0, 240);
  const tags = Array.isArray(payload.tags) ? payload.tags.map(x=>String(x||"").trim()).filter(Boolean).slice(0, 20) : [];

  // update
  if (payload.productId) {
    const p = (DB.products || []).find(x => x.id === String(payload.productId));
    if (!p) return;
    p.name = name;
    p.price = Number.isFinite(price) ? price : 0;
    if (payload.prodCost !== undefined || payload.productionCost !== undefined) p.prodCost = Number.isFinite(prodCost) ? prodCost : 0;
    p.active = active;
    p.categoryTitle = categoryTitle;
    p.categoryId = categoryId;
    if (payload.sectorId !== undefined) p.sectorId = String(payload.sectorId || "general");
    if (payload.modifiers !== undefined) p.modifiers = sanitizeModifiers(payload.modifiers);
    if (payload.description !== undefined) p.description = description;
    if (payload.sku !== undefined) p.sku = sku;
    if (payload.barcode !== undefined) p.barcode = barcode;
    if (payload.unit !== undefined) p.unit = unit;
    if (payload.taxRate !== undefined) p.taxRate = Number.isFinite(taxRate) ? taxRate : 0;
    if (payload.stockMin !== undefined) p.stockMin = Number.isFinite(stockMin) ? stockMin : 0;
    if (payload.stockMax !== undefined) p.stockMax = Number.isFinite(stockMax) ? stockMax : 0;
    if (payload.showStock !== undefined) p.showStock = !!showStock;
    if (payload.imageData !== undefined) {
      if (!imageData) {
        await removeStoredImage(p.imageUrl);
        p.imageUrl = "";
      } else {
        const nextUrl = await saveProductImage(p.id, imageData);
        if (nextUrl) {
          await removeStoredImage(p.imageUrl);
          p.imageUrl = nextUrl;
        }
      }
    } else if (payload.imageUrl !== undefined) {
      p.imageUrl = imageUrl;
    }
    if (payload.notes !== undefined) p.notes = notes;
    if (payload.tags !== undefined) p.tags = tags;
    DB.updatedAt = now();
    scheduleSave();
    return;
  }

  // create
  const base = slugify(name);
  let id = base;
  let n = 2;
  while ((DB.products || []).some(x => x.id === id)) id = `${base}-${n++}`;
  const newProduct = {
    id,
    name,
    price: Number.isFinite(price) ? price : 0,
    prodCost: Number.isFinite(prodCost) ? prodCost : 0,
    active,
    categoryTitle,
    categoryId,
    sectorId: String(payload.sectorId || payload.sectorId || "general"),
    description,
    sku,
    barcode,
    unit,
    taxRate: Number.isFinite(taxRate) ? taxRate : 0,
    stockMin: Number.isFinite(stockMin) ? stockMin : 0,
    stockMax: Number.isFinite(stockMax) ? stockMax : 0,
    showStock: !!showStock,
    imageUrl,
    notes,
    tags,
    modifiers: Array.isArray(payload.modifiers) ? sanitizeModifiers(payload.modifiers) : [],
  };
  if (imageData) {
    const nextUrl = await saveProductImage(id, imageData);
    if (nextUrl) newProduct.imageUrl = nextUrl;
  }
  DB.products.unshift(newProduct);
  DB.updatedAt = now();
  scheduleSave();
}

async function deleteProduct(productId) {
  const id = String(productId || "");
  if (!id) return;
  const prod = (DB.products || []).find(x => x && x.id === id);
  if (prod && prod.imageUrl) await removeStoredImage(String(prod.imageUrl));
  DB.products = (DB.products || []).filter(x => x && x.id !== id);
  if (DB.inventory && DB.inventory.recipes && Object.prototype.hasOwnProperty.call(DB.inventory.recipes, id)) {
    delete DB.inventory.recipes[id];
  }
  DB.updatedAt = now();
  scheduleSave();
}

function renameProductId(fromId, toId) {
  const from = String(fromId || "");
  const to = String(toId || "");
  if (!from || !to || from === to) return;
  if ((DB.products || []).some(p => p && p.id === to)) return;
  const p = (DB.products || []).find(x => x && x.id === from);
  if (!p) return;
  p.id = to;

  // actualizar recetas por producto
  if (DB.inventory && DB.inventory.recipes && Object.prototype.hasOwnProperty.call(DB.inventory.recipes, from)) {
    DB.inventory.recipes[to] = DB.inventory.recipes[from];
    delete DB.inventory.recipes[from];
  }

  // actualizar items en tickets / ventas / compras
  for (const t of (DB.tickets || [])) {
    for (const it of (t.items || [])) {
      if (it.productId === from) it.productId = to;
    }
  }
  for (const s of (DB.sales || [])) {
    for (const it of (s.items || [])) {
      if (it.productId === from) it.productId = to;
    }
  }
  for (const pch of (DB.purchases || [])) {
    for (const it of (pch.items || [])) {
      if (it.productId === from) it.productId = to;
    }
  }

  // actualizar combos/modificadores que apunten a productId
  for (const prod of (DB.products || [])) {
    for (const g of (prod.modifiers || [])) {
      for (const o of (g.options || [])) {
        if (Array.isArray(o.addProducts)) {
          for (const ap of o.addProducts) {
            if (ap && ap.productId === from) ap.productId = to;
          }
        }
      }
    }
  }

  DB.updatedAt = now();
  scheduleSave();
}

function setTableLayout(tableId, patch = {}) {
  const t = findTable(String(tableId || ""));
  if (!t) return;
  if (patch.locked !== undefined) t.locked = !!patch.locked;
  const allowMove = !t.locked || patch.locked === false;
  if (patch.x !== undefined && allowMove) t.x = Number(patch.x || 0);
  if (patch.y !== undefined && allowMove) t.y = Number(patch.y || 0);
  if (patch.w !== undefined) t.w = Math.max(30, Number(patch.w || 0));
  if (patch.h !== undefined) t.h = Math.max(30, Number(patch.h || 0));
  if (patch.zone !== undefined) t.zone = String(patch.zone || "SalИn").slice(0, 32);
  if (patch.shape !== undefined) t.shape = (String(patch.shape) === "round") ? "round" : "square";
  if (patch.capacity !== undefined) t.capacity = Math.max(1, Math.min(20, Number(patch.capacity || 0)));
  t.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
}

function addTableLink(fromId, toId) {
  const a = findTable(String(fromId || ""));
  const b = findTable(String(toId || ""));
  if (!a || !b) return;
  if (a.id === b.id) return;
  if (a.ticketId || b.ticketId) return;
  if (!Array.isArray(a.links)) a.links = [];
  if (!Array.isArray(b.links)) b.links = [];
  if (!a.links.includes(b.id)) a.links.push(b.id);
  if (!b.links.includes(a.id)) b.links.push(a.id);
  a.updatedAt = now();
  b.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
}

function resetTablesLayout() {
  applyDefaultTableLayout(DB.tables, DEFAULT_TABLE_LAYOUT);
  DB.updatedAt = now();
  scheduleSave();
}

function addSupplier(payload = {}) {
  const name = String(payload.name || "").trim().slice(0, 60);
  if (!name) return null;

  DB.people = DB.people || { employees: [], customers: [], suppliers: [] };
  DB.people.suppliers = DB.people.suppliers || [];

  const base = slugify(name);
  let id = base || uid();
  let n = 2;
  while (DB.people.suppliers.some(s => s.id === id)) id = `${base}-${n++}`;

  const sup = {
    id,
    name,
    phone: String(payload.phone || "").trim().slice(0, 32),
    note: String(payload.note || "").trim().slice(0, 120),
    active: true,
    createdAt: now(),
  };
  DB.people.suppliers.unshift(sup);

  DB.accounts = DB.accounts || { customers: [], suppliers: [] };
  DB.accounts.suppliers = DB.accounts.suppliers || [];
  if (!DB.accounts.suppliers.some(a => a.personId === sup.id)) {
    DB.accounts.suppliers.unshift({ id: uid(), personId: sup.id, balance: 0 });
  }

  DB.updatedAt = now();
  scheduleSave();
  return sup;
}

function getSupplierAccount(supplierId) {
  DB.accounts = DB.accounts || { customers: [], suppliers: [] };
  DB.accounts.suppliers = DB.accounts.suppliers || [];
  let acc = DB.accounts.suppliers.find(a => a.personId === supplierId);
  if (!acc) {
    acc = { id: uid(), personId: supplierId, balance: 0 };
    DB.accounts.suppliers.unshift(acc);
  }
  return acc;
}

function createPurchase(payload = {}) {
  const supplierId = String(payload.supplierId || "");
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return;

  const cleaned = items.map(it => ({
    ingredientId: String(it.ingredientId || ""),
    qty: Number(it.qty || 0),
    unitCost: Number(it.unitCost || 0),
  })).filter(it => it.ingredientId && Number.isFinite(it.qty) && it.qty > 0)
    .slice(0, 80);

  if (!cleaned.length) return;

  const ingIndex = new Map((DB.inventory.ingredients || []).map(i => [i.id, i]));
  let total = 0;
  for (const it of cleaned) {
    total += it.qty * (Number.isFinite(it.unitCost) ? it.unitCost : 0);
    const ing = ingIndex.get(it.ingredientId);
    if (!ing) continue;
    const oldOnHand = Number(ing.onHand || 0);
    const oldCost = Number(ing.costPerUnit || 0);
    const addQty = Number(it.qty || 0);
    const newOnHand = oldOnHand + addQty;
    ing.onHand = newOnHand;
    if (Number.isFinite(it.unitCost) && it.unitCost > 0) {
      // costo promedio ponderado simple
      const newCost = newOnHand > 0 ? ((oldCost * oldOnHand) + (it.unitCost * addQty)) / newOnHand : it.unitCost;
      ing.costPerUnit = Number(newCost);
    }
  }

  const purchase = {
    id: uid(),
    at: now(),
    dateKey: ymd(),
    supplierId,
    items: cleaned,
    total,
    note: String(payload.note || "").trim().slice(0, 160),
  };
  DB.purchases = Array.isArray(DB.purchases) ? DB.purchases : [];
  DB.purchases.unshift(purchase);

  // cuenta corriente proveedor
  if (supplierId) {
    const acc = getSupplierAccount(supplierId);
    acc.balance = Number(acc.balance || 0) + total;
  }

  DB.updatedAt = now();
  scheduleSave();
}

function supplierPayment(payload = {}) {
  const supplierId = String(payload.supplierId || "");
  const amount = Number(payload.amount || 0);
  if (!supplierId || !Number.isFinite(amount) || amount <= 0) return;

  const acc = getSupplierAccount(supplierId);
  acc.balance = Number(acc.balance || 0) - amount;

  // registra movimiento (caja mayor por defecto)
  DB.cajaMayor = DB.cajaMayor || { movements: [] };
  DB.cajaMayor.movements = DB.cajaMayor.movements || [];
  DB.cajaMayor.movements.unshift({
    id: uid(),
    at: now(),
    type: "out",
    amount,
    note: String(payload.note || "Pago a proveedor").slice(0, 120),
    supplierId,
  });

  DB.updatedAt = now();
  scheduleSave();
}


// ------------------ Tables / attendance / day closing ------------------
function setTablesCount(newCount) {
  newCount = Math.max(1, Math.min(200, Math.floor(Number(newCount || 0))));
  const used = DB.tables.filter(t => t.ticketId || t.status !== "libre");
  if (newCount < used.length) return; // no achicamos por debajo de mesas en uso

  const current = DB.tables.length;
  if (newCount === current) return;

  if (newCount > current) {
    for (let i = current + 1; i <= newCount; i++) {
      const pos = defaultTableLayout(i - 1, DEFAULT_TABLE_LAYOUT);
      DB.tables.push({
        id: `T${i}`,
        name: `Mesa ${i}`,
        status: "libre",
        ticketId: null,
        received: false,
        shape: "square",
        capacity: 4,
        locked: false,
        links: [],
        x: pos.x,
        y: pos.y,
        w: pos.w,
        h: pos.h,
        zone: "SalИn",
        updatedAt: now(),
      });
    }
  } else {
    // quitar solo si están libres y sin ticket
    DB.tables = DB.tables.slice(0, newCount);
  }
  const tableIds = new Set(DB.tables.map(t=>String(t.id)));
  DB.tables.forEach(t=>{
    if (!Array.isArray(t.links)) t.links = [];
    t.links = Array.from(new Set(t.links.map(String).filter(id=>id && id !== t.id && tableIds.has(id))));
  });
  DB.updatedAt = now();
  scheduleSave();
}

function renameTable(tableId, name) {
  const t = findTable(tableId);
  if (!t) return;
  const clean = String(name || "").trim().slice(0, 24);
  if (!clean) return;
  t.name = clean;
  t.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
}

function reorderTables(orderIds = []) {
  const ids = orderIds.map(String);
  if (!ids.length) return;
  const map = new Map(DB.tables.map(t => [t.id, t]));
  const next = [];
  for (const id of ids) {
    const t = map.get(id);
    if (t) next.push(t);
    map.delete(id);
  }
  for (const t of DB.tables) {
    if (map.has(t.id)) next.push(t);
  }
  DB.tables = next;
  DB.updatedAt = now();
  scheduleSave();
}

function moveTicketToTable(ticketId, toTableId) {
  const ticket = findTicket(ticketId);
  const to = findTable(toTableId);
  if (!ticket || ticket.status !== "abierta") return;
  if (ticket.channel !== "salon") return;
  if (!to || to.ticketId || to.status !== "libre") return;

  const from = findTable(ticket.tableId);
  if (!from) return;

  // mover
  to.ticketId = ticket.id;
  to.status = (from.status && from.status !== "libre") ? from.status : "ocupada";
  to.received = from.received;
  to.updatedAt = now();

  from.ticketId = null;
  from.status = "libre";
  from.received = false;
  from.updatedAt = now();

  ticket.tableId = to.id;
  ticket.updatedAt = now();

  DB.updatedAt = now();
  scheduleSave();
}

function ensureEmployeeByName(name) {
  const clean = String(name || "").trim().slice(0, 28);
  if (!clean) return null;
  DB.people = DB.people || { employees: [], customers: [], suppliers: [] };
  DB.people.employees = DB.people.employees || [];

  const existing = DB.people.employees.find(e => (e.name || "").toLowerCase() === clean.toLowerCase());
  if (existing) return existing;

  const base = slugify(clean) || "empleado";
  let id = base;
  let n = 2;
  while (DB.people.employees.some(e => e.id === id)) id = `${base}-${n++}`;

  const emp = { id, name: clean, role: "mozo", active: true, createdAt: now() };
  DB.people.employees.unshift(emp);
  DB.updatedAt = now();
  scheduleSave();
  return emp;
}

function recordAttendance(employeeId, type = "in", note = "") {
  DB.attendance = Array.isArray(DB.attendance) ? DB.attendance : [];
  const dateKey = ymd();
  DB.attendance.unshift({
    id: uid(),
    dateKey,
    at: now(),
    employeeId: String(employeeId || ""),
    type: (String(type) === "out") ? "out" : "in",
    note: String(note || "").slice(0, 120),
  });
  DB.updatedAt = now();
  scheduleSave();
}

function getAttendanceStatus(employeeId) {
  const last = (DB.attendance || []).find(a => a.employeeId === employeeId);
  if (!last) return "out";
  return last.type === "in" ? "in" : "out";
}

function computeDayReport(dateKey) {
  dateKey = String(dateKey || ymd());
  const sales = (DB.sales || []).filter(s => s.dateKey === dateKey);
  const productsById = new Map((DB.products || []).map(p => [p.id, p]));
  const byChannel = {};
  const byPayment = {};
  const byFiscal = {};
  const itemAgg = new Map(); // productId -> {qty,total}

  let total = 0;
  let cost = 0;
  let profit = 0;
  for (const s of sales) {
    const st = Number(s.total || 0);
    total += st;

    const sc = (s.cost !== undefined) ? Number(s.cost || 0) : computeItemsCost(s.items || []);
    cost += sc;
    const sp = (s.profit !== undefined) ? Number(s.profit || 0) : (st - sc);
    profit += sp;

    const ch = String(s.channel || "otro");
    byChannel[ch] = (byChannel[ch] || 0) + st;

    const pm = String(s.paymentMethod || "otro");
    byPayment[pm] = (byPayment[pm] || 0) + st;

    const ft = String(s.fiscalType || "no_fiscal");
    byFiscal[ft] = (byFiscal[ft] || 0) + st;

    for (const it of (s.items || [])) {
      const pid = String(it.productId || "");
      const qty = Number(it.qty || 0);
      const unit = Number(it.unitPrice || 0);
      if (!pid || !Number.isFinite(qty) || qty <= 0) continue;
      const prev = itemAgg.get(pid) || { qty: 0, total: 0 };
      prev.qty += qty;
      prev.total += qty * unit;
      itemAgg.set(pid, prev);
    }
  }

  const topProducts = Array.from(itemAgg.entries())
    .map(([productId, v]) => {
      const p = productsById.get(productId);
      return { productId, name: p ? p.name : productId, qty: v.qty, total: v.total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  const mov = (DB.cash && Array.isArray(DB.cash.movements)) ? DB.cash.movements.filter(m => m.dateKey === dateKey) : [];
  let cashIn = 0, cashOut = 0;
  const byCashMethod = {};
  for (const m of mov) {
    const amt = Number(m.amount || 0);
    const sign = (m.type === "in") ? 1 : -1;
    const method = String(m.method || "efectivo");
    byCashMethod[method] = (byCashMethod[method] || 0) + sign * amt;
    if (method === "efectivo") {
      if (sign > 0) cashIn += amt;
      else cashOut += amt;
    }
  }
  const expectedCash = cashIn - cashOut;

  const sessions = (DB.cash && Array.isArray(DB.cash.sessions)) ? DB.cash.sessions.filter(s => s.dateKey === dateKey) : [];
  const lastSession = sessions.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0] || null;

  const closure = (DB.dayClosures || []).find(c => c.dateKey === dateKey) || null;
  const closingCash = closure ? Number(closure.closingCash || 0) : (lastSession && lastSession.closedAt ? Number(lastSession.closingCash || 0) : null);
  const diff = (closingCash === null || closingCash === undefined) ? null : (closingCash - expectedCash);

  const openTickets = (DB.tickets || []).filter(t => t.status === "abierta");
  const openTables = (DB.tables || []).filter(t => t.status !== "libre");

  return {
    dateKey,
    updatedAt: now(),
    totals: {
      salesCount: sales.length,
      total,
      cost,
      profit,
      marginPct: total > 0 ? (profit / total) : 0,
      byChannel,
      byPayment,
      byFiscal,
    },
    topProducts,
    cash: {
      expectedCash,
      byMethodNet: byCashMethod,
      session: lastSession,
      closingCash,
      difference: diff,
    },
    open: {
      tickets: openTickets.length,
      tables: openTables.length,
    },
    closure,
  };
}


// ------------------ Estadísticas (semana/mes) ------------------
function dateKeyToMs(dateKey){
  const s = String(dateKey||ymd());
  const d = new Date(s + 'T00:00:00');
  return d.getTime();
}

function msToDateKey(ms){
  return ymd(ms);
}

function dateKeyAddDays(dateKey, days){
  return msToDateKey(dateKeyToMs(dateKey) + (Number(days||0) * 86400000));
}

function dateKeyRange(fromKey, toKey){
  const out=[];
  const start = dateKeyToMs(fromKey);
  const end = dateKeyToMs(toKey);
  if(!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for(let t=start; t<=end; t += 86400000){
    out.push(msToDateKey(t));
  }
  return out;
}

function computeStatsRange(fromKey, toKey){
  fromKey = String(fromKey||ymd());
  toKey = String(toKey||ymd());
  const days = dateKeyRange(fromKey, toKey);
  const sales = (DB.sales || []).filter(s => {
    const k = String(s.dateKey || '');
    return k && k >= fromKey && k <= toKey;
  });

  const byDay = {};
  for (const k of days) byDay[k] = { dateKey: k, salesCount: 0, total: 0, cost: 0, profit: 0 };

  const byPayment = {};
  const byChannel = {};
  const byFiscal = {};
  const itemAgg = new Map();

  let total = 0, cost = 0, profit = 0;
  for (const s of sales) {
    const st = Number(s.total || 0);
    const sc = (s.cost !== undefined) ? Number(s.cost || 0) : computeItemsCost(s.items || []);
    const sp = (s.profit !== undefined) ? Number(s.profit || 0) : (st - sc);

    total += st; cost += sc; profit += sp;

    const k = String(s.dateKey || '');
    const d = byDay[k] || (byDay[k] = { dateKey: k, salesCount: 0, total: 0, cost: 0, profit: 0 });
    d.salesCount += 1;
    d.total += st;
    d.cost += sc;
    d.profit += sp;

    const pm = String(s.paymentMethod || 'otro');
    byPayment[pm] = (byPayment[pm] || 0) + st;

    const ch = String(s.channel || 'otro');
    byChannel[ch] = (byChannel[ch] || 0) + st;

    const ft = String(s.fiscalType || 'no_fiscal');
    byFiscal[ft] = (byFiscal[ft] || 0) + st;

    for (const it of (s.items || [])) {
      const pid = String(it.productId || '');
      const qty = Number(it.qty || 0);
      const unit = Number(it.unitPrice || 0);
      if (!pid || !Number.isFinite(qty) || qty <= 0) continue;
      const revenue = qty * unit;
      const icost = computeProductCost(pid) * qty;
      const prev = itemAgg.get(pid) || { qty: 0, revenue: 0, cost: 0, profit: 0 };
      prev.qty += qty;
      prev.revenue += revenue;
      prev.cost += icost;
      prev.profit += (revenue - icost);
      itemAgg.set(pid, prev);
    }
  }

  const productsById = new Map((DB.products || []).map(p => [p.id, p]));
  const topProducts = Array.from(itemAgg.entries()).map(([productId, v])=>{
    const p = productsById.get(productId);
    return { productId, name: p ? p.name : productId, qty: v.qty, revenue: v.revenue, cost: v.cost, profit: v.profit };
  }).sort((a,b)=>b.revenue-a.revenue).slice(0, 18);

  const topProfitProducts = Array.from(itemAgg.entries()).map(([productId, v])=>{
    const p = productsById.get(productId);
    return { productId, name: p ? p.name : productId, qty: v.qty, revenue: v.revenue, cost: v.cost, profit: v.profit };
  }).sort((a,b)=>b.profit-a.profit).slice(0, 18);

  const series = days.map(k=>byDay[k] || { dateKey:k, salesCount:0, total:0, cost:0, profit:0 });

  return {
    fromKey, toKey,
    updatedAt: now(),
    totals: {
      salesCount: sales.length,
      total,
      cost,
      profit,
      marginPct: total > 0 ? (profit / total) : 0,
      avgTicket: sales.length ? (total / sales.length) : 0,
      byPayment,
      byChannel,
      byFiscal,
    },
    series,
    topProducts,
    topProfitProducts,
  };
}

function closeDay({ dateKey, closingCash = 0, note = "", closedBy = "" } = {}) {
  const dateKeySafe = String(dateKey || ymd());
  DB.dayClosures = Array.isArray(DB.dayClosures) ? DB.dayClosures : [];
  if (DB.dayClosures.some(c => c.dateKey === dateKeySafe)) return; // ya cerrado

  const reportBefore = computeDayReport(dateKeySafe);
  const expected = Number(reportBefore.cash.expectedCash || 0);
  const counted = Number(closingCash || 0);
  const diff = counted - expected;

  // cierra caja si hay sesión abierta
  const openSes = DB.cash && Array.isArray(DB.cash.sessions) ? DB.cash.sessions.find(s => s.dateKey === dateKeySafe && !s.closedAt) : null;
  if (openSes) cashClose(counted, note || "Cierre del día", dateKeySafe);

  // ajuste por diferencia (queda registrado)
  if (Number.isFinite(diff) && Math.abs(diff) >= 0.01) {
    const noteSafe = String(note || "").trim();
    const detail = noteSafe ? ` - ${noteSafe}` : "";
    recordCashMovement({
      dateKey: dateKeySafe,
      type: diff > 0 ? "in" : "out",
      method: "efectivo",
      amount: Math.abs(diff),
      note: `Ajuste cierre del día (${diff > 0 ? "sobrante" : "faltante"})${detail}`,
    });
  }

  const closure = {
    id: uid(),
    dateKey: dateKeySafe,
    at: now(),
    closingCash: counted,
    expectedCash: expected,
    difference: diff,
    note: String(note || "").slice(0, 160),
    closedBy: String(closedBy || "").slice(0, 28),
    report: reportBefore,
  };
  DB.dayClosures.unshift(closure);
  DB.settings = DB.settings || {};
  DB.settings.lastCloseDateKey = dateKeySafe;

  DB.updatedAt = now();
  scheduleSave();
}

function closePeriod({ fromKey, toKey, label = "", note = "", closedBy = "" } = {}) {
  const fromSafe = String(fromKey || ymd());
  const toSafe = String(toKey || ymd());
  DB.periodClosures = Array.isArray(DB.periodClosures) ? DB.periodClosures : [];
  const report = computeStatsRange(fromSafe, toSafe);
  const closure = {
    id: uid(),
    fromKey: fromSafe,
    toKey: toSafe,
    label: String(label || "").slice(0, 80),
    note: String(note || "").slice(0, 160),
    at: now(),
    by: String(closedBy || "").slice(0, 40),
    report,
    adjustments: [],
  };
  DB.periodClosures.unshift(closure);
  DB.updatedAt = now();
  scheduleSave();
  return closure;
}

function addPeriodAdjustment({ closureId, amount = 0, type = "out", note = "", by = "" } = {}) {
  DB.periodClosures = Array.isArray(DB.periodClosures) ? DB.periodClosures : [];
  const c = DB.periodClosures.find(x => x && x.id === closureId);
  if (!c) return null;
  if (!Array.isArray(c.adjustments)) c.adjustments = [];
  const adj = {
    id: uid(),
    at: now(),
    type: (String(type) === "in") ? "in" : "out",
    amount: Math.abs(Number(amount || 0)),
    note: String(note || "").slice(0, 160),
    by: String(by || "").slice(0, 40),
  };
  c.adjustments.unshift(adj);
  c.updatedAt = now();
  DB.updatedAt = now();
  scheduleSave();
  return adj;
}

function demoGenerateSales({ count = 25 } = {}) {
  const dateKey = ymd();
  const products = (DB.products || []).filter(p => p.active !== false);
  if (!products.length) return;

  const payMethods = ["efectivo", "mercadopago", "transferencia"];
  const channels = ["salon", "mostrador", "delivery"];
  const fiscals = ["no_fiscal", "factura_electronica", "controlador_fiscal"];

  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

  for (let i = 0; i < Math.max(1, Math.min(250, Number(count || 0))); i++) {
    const itemsN = rint(1, 4);
    const items = [];
    for (let k = 0; k < itemsN; k++) {
      const p = rand(products);
      const qty = rint(1, 2);
      items.push({ productId: p.id, name: p.name, qty, unitPrice: p.price });
    }
    const total = items.reduce((a, it) => a + Number(it.qty || 0) * Number(it.unitPrice || 0), 0);
    const sale = {
      id: uid(),
      dateKey,
      at: now() - rint(0, 10 * 60 * 60 * 1000), // dentro del día
      ticketId: "demo-" + uid(),
      channel: rand(channels),
      tableId: null,
      items,
      total,
      paymentMethod: rand(payMethods),
      fiscalType: rand(fiscals),
      paid: total,
      change: 0,
      customerName: "",
      customerPhone: "",
      demo: true,
    };
    DB.sales.unshift(sale);
    recordCashMovement({
      dateKey,
      type: "in",
      method: sale.paymentMethod,
      amount: total,
      note: `Venta ${sale.id}`,
    });
  }
  DB.updatedAt = now();
  scheduleSave();
}

// ------------------ In-memory state ------------------
const DB = createRestaurantDbProxy();

function buildRestaurantView(meta, userId){
  if(!meta) return null;
  const membership = userId ? ((ROOT_DB.restaurantMemberships || []).find(x => x && String(x.userId || "") === String(userId) && String(x.restaurantId || "") === String(meta.id || "")) || null) : null;
  const pendingMozoCount = (ROOT_DB.restaurantMemberships || []).filter(x => x && String(x.restaurantId || "") === String(meta.id || "") && String(x.role || "") === "mozo" && String(x.status || "") === "pending").length;
  const workspace = getRestaurantWorkspace(meta.id, true);
  const branches = workspace && workspace.settings && Array.isArray(workspace.settings.branches) ? workspace.settings.branches : [];
  return {
    id: String(meta.id || ""),
    name: String(meta.name || ""),
    ownerName: getRestaurantOwnerName(meta.id),
    branchCount: branches.length,
    trashedAt: Number(meta.trashedAt || 0),
    membership: membership ? {
      id: String(membership.id || ""),
      role: String(membership.role || ""),
      status: String(membership.status || "")
    } : null,
    pendingMozoCount
  };
}

function listRestaurantBranches(restaurantId){
  const workspace = getRestaurantWorkspace(restaurantId, true);
  const branches = workspace && workspace.settings && Array.isArray(workspace.settings.branches) ? workspace.settings.branches : [];
  return branches.map(x => ({
    id: String(x.id || ""),
    name: String(x.name || ""),
    nameKey: String(x.nameKey || ""),
    createdAt: Number(x.createdAt || 0),
    updatedAt: Number(x.updatedAt || 0)
  }));
}

function createBranchForRestaurant(userId, restaurantId, name){
  const meta = getRestaurantMetaById(restaurantId);
  if(!meta || String(meta.ownerUserId || "") !== String(userId || "")) return { error: "unauthorized" };
  const clean = normalizeBranchName(name);
  if(!clean) return { error: "missing_branch_name" };
  const workspace = getRestaurantWorkspace(restaurantId, true);
  workspace.settings = workspace.settings || {};
  workspace.settings.branches = Array.isArray(workspace.settings.branches) ? workspace.settings.branches : [];
  const key = branchNameKey(clean);
  if (workspace.settings.branches.some(x => x && String(x.nameKey || "") === key)) return { error: "branch_name_taken" };
  const branch = { id: uid(), name: clean, nameKey: key, createdAt: now(), updatedAt: now() };
  workspace.settings.branches.unshift(branch);
  workspace.updatedAt = now();
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { ok: true, branch };
}

function selectRestaurantBranchForSession(session, userId, restaurantId, branchId){
  if(!session) return { error: "unauthorized" };
  if(!canEnterRestaurantAs(userId, restaurantId, session.role === "admin" ? "admin" : "mozo")) return { error: "forbidden" };
  const user = findUserById(userId);
  if(!user) return { error: "unauthorized" };
  const branches = listRestaurantBranches(restaurantId);
  const branch = branches.find(x => x && String(x.id || "") === String(branchId || ""));
  if(!branch) return { error: "branch_not_found" };
  session.restaurantId = String(restaurantId || "");
  session.branchId = String(branch.id || "");
  session.branchName = String(branch.name || "");
  user.lastBranchSelections = (user.lastBranchSelections && typeof user.lastBranchSelections === "object" && !Array.isArray(user.lastBranchSelections))
    ? user.lastBranchSelections
    : {};
  user.lastBranchSelections[String(restaurantId || "")] = String(branch.id || "");
  user.updatedAt = now();
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { ok: true, branch, session: normalizeSessionAccess(session) };
}

function listOwnedRestaurants(userId){
  return (ROOT_DB.restaurants || [])
    .filter(x => x && !Number(x.trashedAt || 0) && String(x.ownerUserId || "") === String(userId || ""))
    .map(x => buildRestaurantView(x, userId));
}

function listTrashedRestaurants(userId){
  return (ROOT_DB.restaurants || [])
    .filter(x => x && Number(x.trashedAt || 0) && String(x.ownerUserId || "") === String(userId || ""))
    .sort((a,b)=>(Number(b.trashedAt || 0) - Number(a.trashedAt || 0)))
    .map(x => buildRestaurantView(x, userId));
}

function permanentlyDeleteRestaurant(restaurantId){
  const restaurantIdSafe = String(restaurantId || "");
  if(!restaurantIdSafe) return;
  ROOT_DB.restaurants = (ROOT_DB.restaurants || []).filter(x => x && String(x.id || "") !== restaurantIdSafe);
  ROOT_DB.restaurantMemberships = (ROOT_DB.restaurantMemberships || []).filter(x => x && String(x.restaurantId || "") !== restaurantIdSafe);
  if (ROOT_DB.restaurantData && typeof ROOT_DB.restaurantData === "object") delete ROOT_DB.restaurantData[restaurantIdSafe];
  ROOT_DB.sessions = (ROOT_DB.sessions || []).map((session) => {
    if (!session || String(session.restaurantId || "") !== restaurantIdSafe) return session;
    session.restaurantId = "";
    session.restaurantRole = "";
    session.restaurantName = "";
    session.branchId = "";
    session.branchName = "";
    session.role = "account";
    return normalizeSessionAccess(session);
  });
}

function purgeExpiredTrashedRestaurants(root = ROOT_DB){
  if(!root || !Array.isArray(root.restaurants)) return false;
  const expiredIds = root.restaurants
    .filter(x => x && Number(x.trashedAt || 0) && (Number(x.trashedAt || 0) + RESTAURANT_TRASH_TTL_MS) <= now())
    .map(x => String(x.id || ""));
  if(!expiredIds.length) return false;
  expiredIds.forEach((id) => permanentlyDeleteRestaurant(id));
  root.updatedAt = now();
  return true;
}

function listMozoRestaurants(userId){
  const memberships = (ROOT_DB.restaurantMemberships || []).filter(x => x && String(x.userId || "") === String(userId || "") && String(x.role || "") === "mozo");
  return memberships.map(m => buildRestaurantView(getRestaurantMetaById(m.restaurantId), userId)).filter(Boolean);
}

function listPendingOwnerRequests(userId){
  const ownedIds = new Set((ROOT_DB.restaurants || []).filter(x => x && !Number(x.trashedAt || 0) && String(x.ownerUserId || "") === String(userId || "")).map(x => String(x.id || "")));
  return (ROOT_DB.restaurantMemberships || [])
    .filter(x => x && ownedIds.has(String(x.restaurantId || "")) && String(x.role || "") === "mozo" && String(x.status || "") === "pending")
    .map(m => {
      const user = findUserById(m.userId);
      const restaurant = getRestaurantMetaById(m.restaurantId);
      return {
        id: String(m.id || ""),
        restaurantId: String(m.restaurantId || ""),
        restaurantName: restaurant ? String(restaurant.name || "") : "",
        requestedAt: Number(m.createdAt || 0),
        user: sanitizeUser(user)
      };
    });
}

function createUserAccount(payload = {}){
  ensureAuthDefaults();
  const name = normalizeUserName(payload.name || "");
  const username = normalizeAuthUsername(payload.username || "");
  const email = normalizeAuthEmail(payload.email || "");
  const password = String(payload.password || "");
  const securityQuestion = normalizeSecurityQuestion(payload.securityQuestion || "");
  const securityAnswer = normalizeSecurityAnswer(payload.securityAnswer || "");
  if(!name) return { error: "missing_name" };
  if(!username) return { error: "missing_username" };
  if(!email) return { error: "missing_email" };
  if(!password || password.length < 4) return { error: "weak_password" };
  if(!securityQuestion) return { error: "missing_security_question" };
  if(!securityAnswer) return { error: "missing_security_answer" };
  const usernameKey = authUsernameKey(username);
  const emailKey = authEmailKey(email);
  if((ROOT_DB.users || []).some(x => x && String(x.usernameKey || "") === usernameKey)) return { error: "username_taken" };
  if((ROOT_DB.users || []).some(x => x && String(x.emailKey || "") === emailKey)) return { error: "email_taken" };
  const user = {
    id: uid(),
    name,
    username,
    usernameKey,
    email,
    emailKey,
    passwordHash: hashPass(password, ROOT_DB.auth.salt),
    securityQuestion,
    securityAnswerHash: hashPass(`security:${securityAnswer}`, ROOT_DB.auth.salt),
    createdAt: now(),
    active: true
  };
  ROOT_DB.users.unshift(user);
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { user };
}

function findClaimableLegacyRestaurant(){
  return (ROOT_DB.restaurants || []).find(x => x && x.importedLegacy && !x.ownerUserId);
}

function createRestaurantForUser(user, name){
  ensureAuthDefaults();
  if(!user) return { error: "unauthorized" };
  const clean = normalizeRestaurantName(name);
  if(!clean) return { error: "missing_restaurant_name" };
  const key = restaurantNameKey(clean);
  if((ROOT_DB.restaurants || []).some(x => x && String(x.nameKey || "") === key)) return { error: "restaurant_name_taken" };

  let meta = findClaimableLegacyRestaurant();
  if(meta){
    meta.name = clean;
    meta.nameKey = key;
    meta.ownerUserId = String(user.id || "");
    meta.importedLegacy = false;
    meta.updatedAt = now();
  } else {
    meta = {
      id: uid(),
      name: clean,
      nameKey: key,
      ownerUserId: String(user.id || ""),
      importedLegacy: false,
      createdAt: now(),
      updatedAt: now()
    };
    ROOT_DB.restaurants.unshift(meta);
    const workspace = normalizeRestaurantWorkspaceData({}, MENU);
    workspace.settings.restaurantName = clean;
    workspace.settings.ownerDisplayName = normalizeUserName(user.name || "");
    ROOT_DB.restaurantData[meta.id] = workspace;
  }

  const workspace = getRestaurantWorkspace(meta.id, true);
  workspace.settings.restaurantName = clean;
  workspace.settings.ownerDisplayName = normalizeUserName(user.name || "");
  let membership = getRestaurantMembership(user.id, meta.id, "owner", null);
  if(!membership){
    membership = {
      id: uid(),
      restaurantId: meta.id,
      userId: String(user.id || ""),
      role: "owner",
      status: "active",
      createdAt: now(),
      updatedAt: now()
    };
    ROOT_DB.restaurantMemberships.unshift(membership);
  } else {
    membership.status = "active";
    membership.updatedAt = now();
  }

  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { restaurant: buildRestaurantView(meta, user.id) };
}

function requestMozoAccess(user, restaurantId){
  if(!user) return { error: "unauthorized" };
  const meta = getRestaurantMetaById(restaurantId);
  if(!meta) return { error: "restaurant_not_found" };
  if(String(meta.ownerUserId || "") === String(user.id || "")) return { error: "already_owner" };
  const existing = getRestaurantMembership(user.id, meta.id, "mozo", null);
  if(existing){
    if(existing.status === "active") return { error: "already_member" };
    if(existing.status === "pending") return { error: "request_pending" };
    existing.status = "pending";
    existing.updatedAt = now();
    ROOT_DB.updatedAt = now();
    scheduleSave();
    return { membership: existing };
  }
  const membership = {
    id: uid(),
    restaurantId: meta.id,
    userId: String(user.id || ""),
    role: "mozo",
    status: "pending",
    createdAt: now(),
    updatedAt: now()
  };
  ROOT_DB.restaurantMemberships.unshift(membership);
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { membership };
}

function decideMozoRequest(ownerUserId, membershipId, approve){
  const membership = (ROOT_DB.restaurantMemberships || []).find(x => x && String(x.id || "") === String(membershipId || ""));
  if(!membership) return { error: "request_not_found" };
  const meta = getRestaurantMetaById(membership.restaurantId);
  if(!meta || String(meta.ownerUserId || "") !== String(ownerUserId || "")) return { error: "unauthorized" };
  if(String(membership.role || "") !== "mozo" || String(membership.status || "") !== "pending") return { error: "invalid_request" };
  if(approve){
    membership.status = "active";
    membership.updatedAt = now();
  } else {
    ROOT_DB.restaurantMemberships = (ROOT_DB.restaurantMemberships || []).filter(x => String((x && x.id) || "") !== String(membershipId || ""));
  }
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { ok: true };
}

function canEnterRestaurantAs(userId, restaurantId, role){
  const accessRole = normalizeAccountRole(role);
  const meta = getRestaurantMetaById(restaurantId);
  if(!meta || Number(meta.trashedAt || 0)) return false;
  if(accessRole === "admin"){
    return !!(meta && String(meta.ownerUserId || "") === String(userId || ""));
  }
  if(accessRole === "mozo"){
    const membership = getRestaurantMembership(userId, restaurantId, "mozo", "active");
    return !!membership;
  }
  return false;
}

function setRestaurantAccessForSession(session, userId, restaurantId, role){
  if(!session) return { error: "unauthorized" };
  if(!canEnterRestaurantAs(userId, restaurantId, role)) return { error: "forbidden" };
  const targetRole = role === "admin" ? "owner" : "mozo";
  setSessionRestaurantAccess(session, restaurantId, targetRole);
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { ok: true, session };
}

function searchRestaurantsForUser(query, userId){
  const q = normalizeRestaurantName(query).toLowerCase();
  return (ROOT_DB.restaurants || [])
    .filter(x => x && !Number(x.trashedAt || 0) && (!q || String(x.name || "").toLowerCase().includes(q)))
    .slice(0, 50)
    .map(x => buildRestaurantView(x, userId));
}

function trashRestaurantForUser(userId, restaurantId, confirmName){
  const meta = getRestaurantMetaById(restaurantId);
  if(!meta || String(meta.ownerUserId || "") !== String(userId || "")) return { error: "unauthorized" };
  if(Number(meta.trashedAt || 0)) return { error: "restaurant_already_trashed" };
  const expected = normalizeRestaurantName(meta.name || "");
  const typed = normalizeRestaurantName(confirmName || "");
  if(!typed) return { error: "missing_restaurant_confirmation" };
  if(expected !== typed) return { error: "restaurant_confirmation_mismatch" };
  meta.trashedAt = now();
  meta.updatedAt = now();
  ROOT_DB.updatedAt = now();
  ROOT_DB.restaurantMemberships = (ROOT_DB.restaurantMemberships || []).filter(x => x && String(x.restaurantId || "") !== String(restaurantId || ""));
  (ROOT_DB.sessions || []).forEach((session) => {
    if (!session || String(session.restaurantId || "") !== String(restaurantId || "")) return;
    session.restaurantId = "";
    session.restaurantRole = "";
    session.restaurantName = "";
    session.branchId = "";
    session.branchName = "";
    session.role = "account";
    normalizeSessionAccess(session);
  });
  scheduleSave();
  return { ok: true, restaurant: buildRestaurantView(meta, userId) };
}

function restoreRestaurantForUser(userId, restaurantId){
  const meta = getRestaurantMetaById(restaurantId);
  if(!meta || String(meta.ownerUserId || "") !== String(userId || "")) return { error: "unauthorized" };
  if(!Number(meta.trashedAt || 0)) return { error: "restaurant_not_trashed" };
  meta.trashedAt = 0;
  meta.updatedAt = now();
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { ok: true, restaurant: buildRestaurantView(meta, userId) };
}

function permanentlyDeleteRestaurantForUser(userId, restaurantId){
  const meta = getRestaurantMetaById(restaurantId);
  if(!meta || String(meta.ownerUserId || "") !== String(userId || "")) return { error: "unauthorized" };
  if(!Number(meta.trashedAt || 0)) return { error: "restaurant_not_trashed" };
  permanentlyDeleteRestaurant(restaurantId);
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return { ok: true };
}

function publicMenuPayload(){
  const categories = {};
  function upsertCategory(id, title, opts = {}) {
    const key = String(id || "").trim();
    if (!key) return;
    if (!categories[key]) {
      categories[key] = {
        id: key,
        title: String(title || key),
        titleEn: "",
        order: 0,
        color: ""
      };
    }
    if (opts.forceTitle && title) categories[key].title = String(title);
    if (title && (!categories[key].title || categories[key].title === key)) categories[key].title = String(title);
    if (opts.titleEn && !categories[key].titleEn) categories[key].titleEn = String(opts.titleEn);
    if (opts.color && !categories[key].color) categories[key].color = String(opts.color);
    if (opts.order !== undefined && Number.isFinite(Number(opts.order))) categories[key].order = Number(opts.order);
  }

  const settingsCats = (DB.settings && Array.isArray(DB.settings.menuCategories)) ? DB.settings.menuCategories : [];
  settingsCats.forEach((c, idx) => {
    if (!c || !c.id) return;
    upsertCategory(c.id, c.title || c.id, { color: c.color, order: Number.isFinite(Number(c.order)) ? Number(c.order) : idx, forceTitle: true });
  });

  for (const c of (MENU.categories || [])) {
    if (!c || !c.id) continue;
    upsertCategory(c.id, c.title || c.id, { titleEn: (c.title_en || c.titleEn || ""), order: Number(c.order || 0) });
  }

  const products = (DB.products || [])
    .filter(p => p && p.active !== false)
    .map(p => ({
      id: String(p.id),
      name: String(p.name || p.id),
      nameEn: String(p.nameEn || ""),
      description: String(p.description || ""),
      descriptionEn: String(p.descriptionEn || ""),
      price: Number(p.price || 0),
      imageUrl: String(p.imageUrl || ""),
      categoryId: String(p.categoryId || "otros"),
      categoryTitle: String(p.categoryTitle || "")
    }))
    .sort((a,b)=> (Number(categories[a.categoryId]?.order||999) - Number(categories[b.categoryId]?.order||999)) || a.name.localeCompare(b.name));

  products.forEach(p => {
    const title = p.categoryTitle || p.categoryId || "otros";
    upsertCategory(p.categoryId || slugify(title), title, {});
  });

  const cashStatus = computeCashStatus(DB);

  return {
    restaurantName: (DB.settings && DB.settings.restaurantName) || "NEXA",
    currency: (DB.settings && DB.settings.currency) || "ARS",
    categories: Object.values(categories).sort((a,b)=>(a.order-b.order)||a.title.localeCompare(b.title)),
    products,
    cashStatus,
    serverTime: now(),
  };
}


// ------------------ HTTP server ------------------
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".webmanifest") return "application/manifest+json; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function send(res, code, body, type="text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

function handleApi(req, res, url) {
  if (url.pathname === "/api/info") {
    const ips = getLocalIPv4s();
    const urls = buildUrls(ips);
    const pref = preferredUrl(urls);
    return send(res, 200, JSON.stringify({
      port: PORT,
      ips,
      preferred: pref,
      urls: urls.map(x => x.url),
      serverTime: Date.now(),
      app: "resto-pos-wifi",
      version: APP_VERSION,
      buildId: SERVER_BUILD_ID
    }), "application/json; charset=utf-8");
  }

  if (url.pathname === "/api/menu") {
    return send(res, 200, JSON.stringify(MENU), "application/json; charset=utf-8");
  }


if (url.pathname === "/api/public/menu") {
  // Menú público: solo lo necesario para clientes (sin caja/ventas/etc.)
  return send(res, 200, JSON.stringify(publicMenuPayload()), "application/json; charset=utf-8");
}


if (url.pathname === "/api/auth/status") {
  ensureAuthDefaults();
  return send(res, 200, JSON.stringify({
    ok: true,
    hasUsers: Array.isArray(ROOT_DB.users) && ROOT_DB.users.length > 0,
    userCount: Array.isArray(ROOT_DB.users) ? ROOT_DB.users.length : 0,
    restaurantCount: Array.isArray(ROOT_DB.restaurants) ? ROOT_DB.restaurants.length : 0,
    sessionTTLHours: Number((ROOT_DB.auth && ROOT_DB.auth.sessionTTLHours) || 72),
  }), "application/json; charset=utf-8");
}

if (url.pathname === "/api/auth/me") {
  const ses = authFromReq(req);
  const user = ses ? findUserById(ses.userId) : null;
  return send(res, 200, JSON.stringify({
    ok: true,
    role: ses ? String(ses.role||"cliente") : "cliente",
    authenticated: !!ses,
    userId: ses ? String(ses.userId || "") : "",
    username: ses ? String(ses.username||"") : "",
    email: ses ? String(ses.email||"") : "",
    name: ses ? String(ses.name||"") : "",
    restaurantId: ses ? String(ses.restaurantId||"") : "",
    restaurantName: ses ? String(ses.restaurantName||"") : "",
    restaurantRole: ses ? String(ses.restaurantRole||"") : "",
    branchId: ses ? String(ses.branchId||"") : "",
    branchName: ses ? String(ses.branchName||"") : "",
    user: sanitizeUser(user),
    expiresAt: ses ? Number(ses.expiresAt||0) : 0
  }), "application/json; charset=utf-8");
}

if (url.pathname === "/api/auth/profile") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  const user = findUserById(ses.userId);
  return send(res, 200, JSON.stringify({
    ok: true,
    user: sanitizeUser(user),
    securityQuestion: user ? String(user.securityQuestion || "") : "",
    ownedRestaurants: listOwnedRestaurants(ses.userId),
    trashedRestaurants: listTrashedRestaurants(ses.userId),
    mozoRestaurants: listMozoRestaurants(ses.userId),
    pendingRequests: listPendingOwnerRequests(ses.userId)
  }), "application/json; charset=utf-8");
}

if (url.pathname === "/api/cash/status") {
  const ses = requireRole(req, res, "mozo");
  if(!ses) return;
  const cashStatus = computeCashStatus(DB);
  const turns = (DB.cash && Array.isArray(DB.cash.turns)) ? DB.cash.turns : [];
  const sessions = (DB.cash && Array.isArray(DB.cash.sessions)) ? DB.cash.sessions : [];
  return send(res, 200, JSON.stringify({
    ok: true,
    cashStatus,
    turnCount: turns.length,
    sessionCount: sessions.length,
  }), "application/json; charset=utf-8");
}

if (url.pathname === "/api/auth/register" && req.method === "POST") {
  ensureAuthDefaults();
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const result = createUserAccount({
      name: data.name,
      username: data.username,
      email: data.email,
      password: data.password,
      securityQuestion: data.securityQuestion,
      securityAnswer: data.securityAnswer
    });
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    const ses = createSessionForUser(result.user, { role: "account" });
    setCookie(res, ses.token, Math.floor(Math.max(1, Number(ROOT_DB.auth.sessionTTLHours || 72)) * 3600));
    return send(res, 200, JSON.stringify({ ok: true, user: sanitizeUser(result.user), role: ses.role }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/auth/login" && req.method === "POST") {
  ensureAuthDefaults();
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const identifier = normalizeAuthIdentifier(data.identifier || data.username || data.email || "");
    const password = String(data.password || "");
    if (!identifier) return send(res, 400, JSON.stringify({ error: "missing_identifier" }), "application/json; charset=utf-8");
    if (!password) return send(res, 400, JSON.stringify({ error: "missing_password" }), "application/json; charset=utf-8");
    const user = findUserByIdentifier(identifier);
    if (!user || user.active === false || !verifyUserPassword(user, password)) {
      return send(res, 401, JSON.stringify({ error: "invalid_credentials" }), "application/json; charset=utf-8");
    }
    const ses = createSessionForUser(user, { role: "account" });
    setCookie(res, ses.token, Math.floor(Math.max(1, Number(ROOT_DB.auth.sessionTTLHours || 72)) * 3600));
    return send(res, 200, JSON.stringify({
      ok: true,
      role: ses.role,
      user: sanitizeUser(user),
      ownedRestaurants: listOwnedRestaurants(user.id),
      mozoRestaurants: listMozoRestaurants(user.id),
      pendingRequests: listPendingOwnerRequests(user.id),
      expiresAt: ses.expiresAt
    }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/auth/logout") {
  ensureAuthDefaults();
  const tok = getAuthToken(req);
  if (tok) ROOT_DB.sessions = (ROOT_DB.sessions || []).filter(s => s && String(s.token || "") !== String(tok));
  ROOT_DB.updatedAt = now();
  scheduleSave();
  clearCookie(res);
  return send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
}

if (url.pathname === "/api/auth/setPassword" && req.method === "POST") {
  ensureAuthDefaults();
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const ses = requireRole(req, res, "account");
    if (!ses) return;
    const user = findUserById(ses.userId);
    if (!user) return send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json; charset=utf-8");
    const newPassword = String(data.newPassword || "");
    const currentPassword = String(data.currentPassword || "");
    const username = normalizeAuthUsername(data.username === undefined ? user.username : data.username);
    const email = normalizeAuthEmail(data.email === undefined ? user.email : data.email);
    const name = normalizeUserName(data.name === undefined ? user.name : data.name);
    const securityQuestion = normalizeSecurityQuestion(data.securityQuestion || "");
    const securityAnswer = String(data.securityAnswer || "");
    const hasNameInput = Object.prototype.hasOwnProperty.call(data, "name");
    const hasUsernameInput = Object.prototype.hasOwnProperty.call(data, "username");
    const hasEmailInput = Object.prototype.hasOwnProperty.call(data, "email");
    const hasQuestionInput = Object.prototype.hasOwnProperty.call(data, "securityQuestion") && !!securityQuestion;
    const hasAnswerInput = Object.prototype.hasOwnProperty.call(data, "securityAnswer");
    if (newPassword && newPassword.length < 4) return send(res, 400, JSON.stringify({ error: "weak_password" }), "application/json; charset=utf-8");
    if (newPassword && !verifyUserPassword(user, currentPassword)) return send(res, 401, JSON.stringify({ error: "invalid_current_password" }), "application/json; charset=utf-8");
    if (hasNameInput && !name) return send(res, 400, JSON.stringify({ error: "missing_name" }), "application/json; charset=utf-8");
    if (hasUsernameInput && !username) return send(res, 400, JSON.stringify({ error: "missing_username" }), "application/json; charset=utf-8");
    if (hasEmailInput && !email) return send(res, 400, JSON.stringify({ error: "missing_email" }), "application/json; charset=utf-8");
    if (hasAnswerInput && !normalizeSecurityAnswer(securityAnswer)) return send(res, 400, JSON.stringify({ error: "missing_security_answer" }), "application/json; charset=utf-8");
    if (hasQuestionInput && !hasAnswerInput) return send(res, 400, JSON.stringify({ error: "missing_security_answer" }), "application/json; charset=utf-8");
    if (hasUsernameInput) {
      const key = authUsernameKey(username);
      if ((ROOT_DB.users || []).some(x => x && String(x.id || "") !== String(user.id || "") && String(x.usernameKey || "") === key)) {
        return send(res, 409, JSON.stringify({ error: "username_taken" }), "application/json; charset=utf-8");
      }
    }
    if (hasEmailInput) {
      const key = authEmailKey(email);
      if ((ROOT_DB.users || []).some(x => x && String(x.id || "") !== String(user.id || "") && String(x.emailKey || "") === key)) {
        return send(res, 409, JSON.stringify({ error: "email_taken" }), "application/json; charset=utf-8");
      }
    }
    if (!newPassword && !hasNameInput && !hasUsernameInput && !hasEmailInput && !hasQuestionInput && !hasAnswerInput) {
      return send(res, 400, JSON.stringify({ error: "nothing_to_update" }), "application/json; charset=utf-8");
    }

    if (hasNameInput) {
      user.name = name;
      (ROOT_DB.restaurants || []).forEach((meta) => {
        if (!meta || String(meta.ownerUserId || "") !== String(user.id || "")) return;
        const workspace = getRestaurantWorkspace(meta.id, true);
        if (workspace && workspace.settings) workspace.settings.ownerDisplayName = name;
      });
    }
    if (hasUsernameInput) {
      user.username = username;
      user.usernameKey = authUsernameKey(username);
    }
    if (hasEmailInput) {
      user.email = email;
      user.emailKey = authEmailKey(email);
    }
    if (hasQuestionInput) user.securityQuestion = securityQuestion;
    if (hasAnswerInput) user.securityAnswerHash = hashPass(`security:${normalizeSecurityAnswer(securityAnswer)}`, ROOT_DB.auth.salt);
    if (newPassword) user.passwordHash = hashPass(newPassword, ROOT_DB.auth.salt);
    user.updatedAt = now();
    ROOT_DB.updatedAt = now();
    scheduleSave();
    return send(res, 200, JSON.stringify({ ok: true, user: sanitizeUser(user) }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/auth/recoveryQuestion" && req.method === "POST") {
  ensureAuthDefaults();
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const identifier = normalizeAuthIdentifier(data.identifier || data.username || data.email || "");
    const user = findUserByIdentifier(identifier);
    if (!user || user.active === false) return send(res, 404, JSON.stringify({ error: "account_not_found" }), "application/json; charset=utf-8");
    if (!user.securityQuestion || !user.securityAnswerHash) return send(res, 409, JSON.stringify({ error: "recovery_not_configured" }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({ ok: true, question: user.securityQuestion }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/auth/recover" && req.method === "POST") {
  ensureAuthDefaults();
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const identifier = normalizeAuthIdentifier(data.identifier || data.username || data.email || "");
    const securityAnswer = String(data.securityAnswer || "");
    const newPassword = String(data.newPassword || "");
    if (!newPassword || newPassword.length < 4) return send(res, 400, JSON.stringify({ error: "weak_password" }), "application/json; charset=utf-8");
    const user = findUserByIdentifier(identifier);
    if (!user || user.active === false) return send(res, 404, JSON.stringify({ error: "account_not_found" }), "application/json; charset=utf-8");
    if (!user.securityQuestion || !user.securityAnswerHash) return send(res, 409, JSON.stringify({ error: "recovery_not_configured" }), "application/json; charset=utf-8");
    if (!verifySecurityAnswer(user, securityAnswer)) return send(res, 401, JSON.stringify({ error: "invalid_security_answer" }), "application/json; charset=utf-8");
    user.passwordHash = hashPass(newPassword, ROOT_DB.auth.salt);
    user.updatedAt = now();
    ROOT_DB.updatedAt = now();
    scheduleSave();
    return send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/auth/verifySecurity" && req.method === "POST") {
  ensureAuthDefaults();
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const ses = requireRole(req, res, "account");
    if (!ses) return;
    const user = findUserById(ses.userId);
    const securityAnswer = String(data.securityAnswer || "");
    if (!user) return send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json; charset=utf-8");
    if (!user.securityQuestion || !user.securityAnswerHash) return send(res, 409, JSON.stringify({ error: "recovery_not_configured" }), "application/json; charset=utf-8");
    if (!verifySecurityAnswer(user, securityAnswer)) return send(res, 401, JSON.stringify({ error: "invalid_security_answer" }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/create" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const user = findUserById(ses.userId);
    const data = safeJsonParse(body, {});
    const result = createRestaurantForUser(user, data.name || data.restaurantName || "");
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({ ok: true, restaurant: result.restaurant }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/trash" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const result = trashRestaurantForUser(ses.userId, data.restaurantId, data.confirmName || data.name || "");
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({
      ok: true,
      restaurant: result.restaurant,
      ownedRestaurants: listOwnedRestaurants(ses.userId),
      trashedRestaurants: listTrashedRestaurants(ses.userId)
    }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/restore" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const result = restoreRestaurantForUser(ses.userId, data.restaurantId);
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({
      ok: true,
      restaurant: result.restaurant,
      ownedRestaurants: listOwnedRestaurants(ses.userId),
      trashedRestaurants: listTrashedRestaurants(ses.userId)
    }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/deletePermanent" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const result = permanentlyDeleteRestaurantForUser(ses.userId, data.restaurantId);
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({
      ok: true,
      ownedRestaurants: listOwnedRestaurants(ses.userId),
      trashedRestaurants: listTrashedRestaurants(ses.userId)
    }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/search") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  const q = url.searchParams.get("q") || "";
  return send(res, 200, JSON.stringify({ ok: true, restaurants: searchRestaurantsForUser(q, ses.userId) }), "application/json; charset=utf-8");
}

if (url.pathname === "/api/restaurants/branches") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  const restaurantId = String(url.searchParams.get("restaurantId") || "");
  if (!restaurantId || !canEnterRestaurantAs(ses.userId, restaurantId, "admin") && !canEnterRestaurantAs(ses.userId, restaurantId, "mozo")) {
    return send(res, 403, JSON.stringify({ error: "forbidden" }), "application/json; charset=utf-8");
  }
  const branches = listRestaurantBranches(restaurantId);
  const selectedBranchId = String(ses.branchId || "");
  return send(res, 200, JSON.stringify({ ok: true, branches, selectedBranchId }), "application/json; charset=utf-8");
}

if (url.pathname === "/api/restaurants/branches/create" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const result = createBranchForRestaurant(ses.userId, data.restaurantId, data.name || data.branchName || "");
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({ ok: true, branch: result.branch, branches: listRestaurantBranches(data.restaurantId) }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/branches/select" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const result = selectRestaurantBranchForSession(ses, ses.userId, data.restaurantId, data.branchId);
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({ ok: true, branch: result.branch, branchId: result.session.branchId, branchName: result.session.branchName }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/requestMozo" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const user = findUserById(ses.userId);
    const data = safeJsonParse(body, {});
    const result = requestMozoAccess(user, data.restaurantId);
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({ ok: true, membership: result.membership, restaurants: searchRestaurantsForUser("", ses.userId) }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/requestDecision" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const result = decideMozoRequest(ses.userId, data.requestId || data.membershipId, !!data.approve);
    if (result.error) return send(res, 400, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({ ok: true, pendingRequests: listPendingOwnerRequests(ses.userId) }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/enter" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const role = normalizeAccountRole(data.role || "admin");
    if (role !== "admin" && role !== "mozo") return send(res, 400, JSON.stringify({ error: "bad_role" }), "application/json; charset=utf-8");
    const result = setRestaurantAccessForSession(ses, ses.userId, data.restaurantId, role);
    if (result.error) return send(res, 403, JSON.stringify({ error: result.error }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({
      ok: true,
      role: result.session.role,
      restaurantId: result.session.restaurantId,
      restaurantName: result.session.restaurantName,
      restaurantRole: result.session.restaurantRole,
      branchId: result.session.branchId || "",
      branchName: result.session.branchName || ""
    }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/restaurants/leave" && req.method === "POST") {
  const ses = requireRole(req, res, "account");
  if (!ses) return;
  setSessionRestaurantAccess(ses, "", "");
  ROOT_DB.updatedAt = now();
  scheduleSave();
  return send(res, 200, JSON.stringify({ ok: true, role: ses.role }), "application/json; charset=utf-8");
}
if (url.pathname === "/api/customer/requestBill" && req.method === "POST") {
  // Cliente solicita "la cuenta" desde el menú público. No requiere login.
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 100_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const table = String(data.table || data.mesa || data.where || "").slice(0, 40);
    const name = String(data.name || "").slice(0, 40);
    const reqObj = {
      id: uid(),
      type: "bill",
      at: now(),
      table,
      name,
      ip: String((req.socket && req.socket.remoteAddress) || "").slice(0, 80),
      ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 120),
      status: "new"
    };
    DB.customerRequests = Array.isArray(DB.customerRequests) ? DB.customerRequests : [];
    DB.customerRequests.unshift(reqObj);
    DB.customerRequests = DB.customerRequests.slice(0, 200);
    DB.updatedAt = now();
    scheduleSave();
      // Aviso a personal
      broadcastMinRole("mozo", { type: "customer:request", request: reqObj });
      const who = name ? ` (${name})` : "";
      const rawMesa = table ? tableLabel(table) : "";
      const mesa = rawMesa ? (rawMesa.toLowerCase().includes("mesa") ? rawMesa : `Mesa ${rawMesa}`) : "Mesa";
      notify(`${mesa} pide la cuenta${who}`, "info", { table, name, requestId: reqObj.id }, "Cliente");
      return send(res, 200, JSON.stringify({ ok: true, id: reqObj.id }), "application/json; charset=utf-8");
    });
    return;
  }

if (url.pathname === "/api/customer/requests") {
  const ses = requireRole(req, res, "mozo");
  if (!ses) return;
  const list = Array.isArray(DB.customerRequests) ? DB.customerRequests.slice(0, 100) : [];
  return send(res, 200, JSON.stringify(list), "application/json; charset=utf-8");
}

if (url.pathname === "/api/customer/resolve" && req.method === "POST") {
  const ses = requireRole(req, res, "mozo");
  if (!ses) return;
  let body = "";
  req.on("data", c => { body += c.toString(); if (body.length > 50_000) req.destroy(); });
  req.on("end", () => {
    const data = safeJsonParse(body, {});
    const id = String(data.id || "");
    DB.customerRequests = Array.isArray(DB.customerRequests) ? DB.customerRequests : [];
    const r = DB.customerRequests.find(x => x && x.id === id);
    if (r) r.status = "done";
    DB.updatedAt = now();
    scheduleSave();
    return send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
  });
  return;
}

if (url.pathname === "/api/stats") {
  const ses = requireRole(req, res, "admin");
  if (!ses) return;
  const preset = String(url.searchParams.get("preset") || "month");
  const today = ymd();
  let fromKey = today, toKey = today;
  if (preset === "week") {
    const end = new Date(today + 'T00:00:00').getTime();
    const start = end - 6*86400000;
    fromKey = ymd(start);
    toKey = today;
  } else if (preset === "month") {
    const d = new Date(today + 'T00:00:00');
    const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const last = new Date(d.getFullYear(), d.getMonth()+1, 0).getTime();
    fromKey = ymd(first);
    toKey = ymd(last);
  } else if (preset === "all") {
    const sales = (DB.sales || []);
    if (sales.length) {
      let min = null;
      for (const s of sales) {
        const k = String(s.dateKey || "");
        if (!k) continue;
        if (min === null || k < min) min = k;
      }
      fromKey = min || today;
      toKey = today;
    } else {
      fromKey = today;
      toKey = today;
    }
  } else if (preset === "month_prev") {
    const d = new Date(today + 'T00:00:00');
    const first = new Date(d.getFullYear(), d.getMonth()-1, 1).getTime();
    const last = new Date(d.getFullYear(), d.getMonth(), 0).getTime();
    fromKey = ymd(first);
    toKey = ymd(last);
  } else if (preset === "range") {
    fromKey = String(url.searchParams.get("from") || today);
    toKey = String(url.searchParams.get("to") || today);
  }

  const out = computeStatsRange(fromKey, toKey);
  return send(res, 200, JSON.stringify(out), "application/json; charset=utf-8");
}

  if (url.pathname === "/api/state") {
    const ses = requireRole(req, res, "mozo");
    if (!ses) return;
    return send(res, 200, JSON.stringify(DB), "application/json; charset=utf-8");
  }

  if (url.pathname === "/api/dayReport") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
    const dateKey = String(url.searchParams.get("date") || ymd());
    const report = computeDayReport(dateKey);
    return send(res, 200, JSON.stringify({ ...report, settings: DB.settings || {} }), "application/json; charset=utf-8");
  }

  if (url.pathname === "/api/dayClosures") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
    const dateKey = String(url.searchParams.get("date") || "");
    const list = Array.isArray(DB.dayClosures) ? DB.dayClosures : [];
    const filtered = dateKey ? list.filter(c => c.dateKey === dateKey) : list.slice(0, 30);
    return send(res, 200, JSON.stringify(filtered), "application/json; charset=utf-8");
  }

  if (url.pathname === "/api/periodClosures") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
    const list = Array.isArray(DB.periodClosures) ? DB.periodClosures : [];
    return send(res, 200, JSON.stringify(list), "application/json; charset=utf-8");
  }

  if (url.pathname === "/api/periodClosure") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
    const id = String(url.searchParams.get("id") || "");
    const item = (DB.periodClosures || []).find(c => c.id === id);
    if (!item) return send(res, 404, JSON.stringify({ error: "not_found" }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({ ...item, settings: DB.settings || {} }), "application/json; charset=utf-8");
  }


if (url.pathname === "/api/settings") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
  return send(res, 200, JSON.stringify(DB.settings || {}), "application/json; charset=utf-8");
}

if (url.pathname === "/api/fiscalDoc") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
  const id = String(url.searchParams.get("id") || "");
  const doc = (DB.fiscalDocs || []).find(d => d.id === id);
  if (!doc) return send(res, 404, JSON.stringify({ error: "not_found" }), "application/json; charset=utf-8");
  const sale = (DB.sales || []).find(s => s.id === doc.saleId);
  const ticket = sale ? (DB.tickets || []).find(t => t.id === sale.ticketId) : null;
  const payload = buildFiscalDocPayload(doc, sale || null, ticket || null);
  const summary = {
    payload,
    text: formatFiscalDocText(payload),
    json: JSON.stringify(payload, null, 2),
  };
  if (!doc.qrUrl) doc.qrUrl = buildArcaQrUrl(doc);

  if (doc.qrUrl) {
    return QRCode.toDataURL(doc.qrUrl, { margin: 1, width: 220 }, (err, dataUrl) => {
      const qr = (err ? "" : dataUrl);
      return send(res, 200, JSON.stringify({ settings: DB.settings, doc, sale: sale || null, qr, summary }), "application/json; charset=utf-8");
    });
  }

  return send(res, 200, JSON.stringify({ settings: DB.settings, doc, sale: sale || null, qr: "", summary }), "application/json; charset=utf-8");
}

if (url.pathname === "/api/arcaQrSvg") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
  const id = String(url.searchParams.get("id") || "");
  const doc = (DB.fiscalDocs || []).find(d => d.id === id);
  if (!doc) return send(res, 404, "Not found");
  if (!doc.qrUrl) doc.qrUrl = buildArcaQrUrl(doc);
  if (!doc.qrUrl) return send(res, 400, "Missing QR data");
  QRCode.toString(doc.qrUrl, { type: "svg", margin: 1, width: 220 }, (err, svg) => {
    if (err) return send(res, 500, "QR error");
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
    res.end(svg);
  });
  return;
}


if (url.pathname === "/api/fiscalDocs") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
  const list = Array.isArray(DB.fiscalDocs) ? DB.fiscalDocs.slice(0, 200) : [];
  return send(res, 200, JSON.stringify(list), "application/json; charset=utf-8");
}


  if (url.pathname === "/api/ticket") {
    const ses = requireRole(req, res, "mozo");
    if (!ses) return;
    const id = String(url.searchParams.get("id") || "");
    const ticket = DB.tickets.find(t => t.id === id);
    if (!ticket) return send(res, 404, JSON.stringify({ error: "not_found" }), "application/json; charset=utf-8");
    return send(res, 200, JSON.stringify({
      settings: DB.settings,
      ticket,
      total: ticketTotal(ticket),
      dateKey: ymd(),
    }), "application/json; charset=utf-8");
  }
  if (url.pathname === "/api/exportDb") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="db-${ymd()}.json"`,
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(DB, null, 2));
    return;
  }

  if (url.pathname === "/api/importDb" && req.method === "POST") {
    const ses = requireRole(req, res, "admin");
    if (!ses) return;
    let body = "";
    req.on("data", (c) => { body += c.toString(); if (body.length > 5_000_000) req.destroy(); });
    req.on("end", () => {
      const incoming = safeJsonParse(body, null);
      if (!incoming || typeof incoming !== "object") return send(res, 400, JSON.stringify({ error: "invalid_json" }), "application/json; charset=utf-8");

      // normalización mínima (mantener compatibilidad)
      const menu = MENU;
      const base = initDbFromMenu(menu);
      const merged = { ...base, ...incoming };

      // asegurar arrays/objetos
      merged.settings = merged.settings || base.settings;
      merged.products = Array.isArray(merged.products) ? merged.products : base.products;
      merged.tables = Array.isArray(merged.tables) ? merged.tables : base.tables;
      merged.tickets = Array.isArray(merged.tickets) ? merged.tickets : [];
      merged.sales = Array.isArray(merged.sales) ? merged.sales : [];
      merged.dayClosures = Array.isArray(merged.dayClosures) ? merged.dayClosures : [];
      merged.periodClosures = Array.isArray(merged.periodClosures) ? merged.periodClosures : [];
      merged.cash = merged.cash || base.cash;
      merged.inventory = merged.inventory || base.inventory;
      merged.people = merged.people || base.people;
      merged.attendance = Array.isArray(merged.attendance) ? merged.attendance : [];
      merged.banks = merged.banks || base.banks;
      merged.cajaMayor = merged.cajaMayor || base.cajaMayor;
      merged.purchases = Array.isArray(merged.purchases) ? merged.purchases : [];
      merged.accounts = merged.accounts || base.accounts;
      // Auth
      merged.sessions = Array.isArray(merged.sessions) ? merged.sessions : [];
      merged.settings.auth = merged.settings.auth || base.settings.auth;
      if (!merged.settings.auth.salt) merged.settings.auth.salt = base.settings.auth.salt || uid();
      if (merged.settings.auth.sessionTTLHours === undefined) merged.settings.auth.sessionTTLHours = 72;

      // asegurar layout mesas
      for (let i = 0; i < (merged.tables || []).length; i++) {
        const t = merged.tables[i];
        if (t.x === undefined || t.y === undefined) {
          t.x = 20 + (i % 5) * (120 + 24);
          t.y = 20 + Math.floor(i / 5) * (80 + 22);
        }
        if (t.w === undefined) t.w = 120;
        if (t.h === undefined) t.h = 80;
        if (t.zone === undefined) t.zone = "Salón";
      }

      merged.version = 9;
      merged.updatedAt = now();
      const restaurantId = String(ses.restaurantId || getDefaultRestaurantId(ROOT_DB) || "");
      if (!restaurantId) return send(res, 400, JSON.stringify({ error: "missing_restaurant" }), "application/json; charset=utf-8");
      ROOT_DB.restaurantData[restaurantId] = normalizeRestaurantWorkspaceData(merged, MENU);
      ROOT_DB.updatedAt = now();
      scheduleSave();
      broadcastState();
      return send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    });
    return;
  }



  if (url.pathname === "/qr.png") {
    const u = String(url.searchParams.get("u") || "");
    if (!u) return send(res, 400, "Missing ?u=");
    QRCode.toBuffer(u, { margin: 1, width: 220 }, (err, buf) => {
      if (err) return send(res, 500, "QR error");
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(buf);
    });
    return;
  }

  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requestSession = authFromReq(req);

  // API
  const handled = runWithRestaurantContext(requestSession && requestSession.restaurantId, () => handleApi(req, res, url));
  if (handled !== false) return;

  // Static
  let filePath = url.pathname;
  if (filePath === "/") filePath = "/login.html";
  filePath = filePath.replace(/\.\./g, "");
  let abs = "";
  if (filePath.startsWith("/images/")) {
    abs = path.join(IMAGES_DIR, filePath.replace("/images/", ""));
    if (!abs.startsWith(IMAGES_DIR)) return send(res, 403, "Forbidden");
  } else {
    abs = path.join(PUBLIC_DIR, filePath);
    if (!abs.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  }

/* auth gate static */
function roleForPath(fp) {
  if (fp.startsWith("/images/fiscal/")) return "admin";
  if (fp.startsWith("/images/")) return null;
  // Admin
  if (fp === "/index.html" || fp === "/panel.html" || fp === "/pro.html" || fp === "/admin_stats.html") return "admin";
  if (fp.startsWith("/admin_")) return "admin";

  // Configuración: si no hay admin creado, permitimos setup; si no, admin.
  if (fp === "/config.html") return "admin";
  if (fp === "/profile.html") return "account";

  // Personal
  if (fp === "/mozo.html") return "mozo";
  if (fp === "/cocina.html" || fp === "/salon_pc.html" || fp === "/print.html" || fp === "/print_fiscal.html") return "admin";
  return null; // público
}

const needRole = roleForPath(filePath);
if (needRole) {
  const ses = authFromReq(req);
  const role = ses ? String(ses.role || "anon") : "anon";
  if (!hasMinRole(role, needRole)) {
    const next = encodeURIComponent(filePath + (url.search || ""));
    res.writeHead(302, { "Location": `/login.html?role=${needRole}&next=${next}` });
    res.end();
    return;
  }
}

  if (filePath.startsWith("/images/") && STORAGE && STORAGE.mode === "postgres") {
    STORAGE.getBlob(blobUrlToKey(filePath))
      .then(blob => {
        if (!blob) {
          return fs.stat(abs, (err, st) => {
            if (err || !st.isFile()) {
              return send(res, 404, "Not found");
            }
            res.writeHead(200, { "Content-Type": contentType(abs), "Cache-Control": "no-store" });
            fs.createReadStream(abs).pipe(res);
          });
        }
        res.writeHead(200, { "Content-Type": blob.mimeType || contentType(filePath), "Cache-Control": "no-store" });
        res.end(blob.data);
      })
      .catch(err => {
        console.log("Error sirviendo imagen:", err && err.message ? err.message : err);
        send(res, 500, "Internal server error");
      });
    return;
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, "Not found");
    }
    res.writeHead(200, { "Content-Type": contentType(abs), "Cache-Control": "no-store" });
    fs.createReadStream(abs).pipe(res);
  });
});

// ------------------ WebSocket ------------------
const wss = new WebSocket.Server({ server });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function broadcastMinRole(minRole, payload){
  const msg = JSON.stringify(payload);
  const restaurantId = getRestaurantContextId();
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (!hasMinRole(client.role, minRole)) return;
    if (restaurantId && String(client.restaurantId || "") !== restaurantId) return;
    client.send(msg);
  });
}

function sendWsState(ws){
  runWithRestaurantContext(ws && ws.restaurantId, () => {
    if (hasMinRole(ws.role, "mozo")) {
      ws.send(JSON.stringify({ type: "state", db: DB }));
    } else {
      ws.send(JSON.stringify({ type: "public", menu: publicMenuPayload() }));
    }
  });
}

function broadcastState() {
  const restaurantId = getRestaurantContextId();
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (restaurantId && String(client.restaurantId || "") !== restaurantId) return;
    runWithRestaurantContext(client.restaurantId, () => {
      const payload = hasMinRole(client.role, "mozo")
        ? { type: "state", db: DB }
        : { type: "public", menu: publicMenuPayload() };
      client.send(JSON.stringify(payload));
    });
  });
}

function notify(text, kind, data, by){
  const payload = {
    type: "notify",
    id: uid(),
    text: String(text || "").slice(0, 200),
    kind: String(kind || "info"),
    data: data || {},
    by: String(by || "").slice(0, 40),
    at: now()
  };
  broadcastMinRole("mozo", payload);
}



function requiredRoleForAction(kind) {
  const k = String(kind || "");
  if (k.startsWith("ticket:") || k.startsWith("table:")) return "mozo";
  if (k.startsWith("attendance:")) return "mozo";
  if (k.startsWith("notify:")) return "mozo";
  if (k.startsWith("cash:") || k.startsWith("settings:") || k.startsWith("inventory:") || k.startsWith("tables:") || k.startsWith("products:") || k.startsWith("people:") || k.startsWith("purchases:") || k.startsWith("accounts:") || k.startsWith("fiscal:") || k.startsWith("day:") || k.startsWith("demo:")) return "admin";
  return "admin";
}
async function applyAction(kind, payload, ws) {
  const by = (ws && ws.name) ? ws.name : "Sistema";
  const dayOpen = !!(getOpenCashTurn(getBusinessDateKey(DB)) || getOpenCashSession(getBusinessDateKey(DB)) || getAnyOpenCashTurn() || getAnyOpenCashSession());
  const allowWhenClosed = kind === "cash:open" || kind === "cash:turnClose" || kind === "cash:turnOpen" || String(kind || "").startsWith("attendance:");
  if (!dayOpen && !allowWhenClosed) {
    notify(getDayBlockMessage(kind), "warn", { action: kind, reason: "day_closed" }, by);
    return;
  }
  switch (kind) {
    case "ticket:ensureForTable": {
      const tableId = String(payload.tableId || "");
      const t = ensureTicketForTable(tableId, by);
      if (t) broadcastState();
      return;
    }
    case "ticket:addToTable": {
      const tableId = String(payload.tableId || "");
      const productId = String(payload.productId || "");
      const delta = Number(payload.delta || 1);
      const t = ensureTicketForTable(tableId, by);
      if (t) addItem(t.id, productId, delta);
      broadcastState();
      return;
    }
    case "ticket:addToTableEx": {
      const tableId = String(payload.tableId || "");
      const productId = String(payload.productId || "");
      const qty = Number(payload.delta ?? payload.qty ?? 1);
      const selections = payload.selections || {};
      const t = ensureTicketForTable(tableId, by);
      if (t) addItemLine(t.id, productId, qty, selections);
      broadcastState();
      return;
    }
    case "ticket:abandonDraft": {
      abandonDraftTicket(String(payload.ticketId || ""), by);
      broadcastState();
      return;
    }
    case "ticket:cancel": {
      cancelTicket(String(payload.ticketId || ""), by, payload && payload.reason);
      broadcastState();
      return;
    }
    case "ticket:create": {
      const channel = String(payload.channel || "mostrador");
      const tableId = payload.tableId ? String(payload.tableId) : null;
      createTicket({ channel, tableId, createdBy: by });
      const place = tableId ? tableLabel(tableId) : channel;
      const msg = tableId ? `Nueva comanda en ${place}` : `Nueva comanda ${place}`;
      notify(msg, "info", { action: "ticket:create", channel, tableId }, by);
      broadcastState();
      return;
    }
    case "ticket:addItem": {
      addItem(String(payload.ticketId || ""), String(payload.productId || ""), Number(payload.delta || 1));
      broadcastState();
      return;
    }
case "ticket:addItemEx": {
  addItemLine(String(payload.ticketId || ""), String(payload.productId || ""), Number(payload.delta ?? payload.qty ?? 1), payload.selections || {});
  broadcastState();
  return;
}
case "ticket:lineQty": {
  changeLineQty(String(payload.ticketId || ""), String(payload.lineId || ""), Number(payload.delta || 0));
  broadcastState();
  return;
}
    case "ticket:removeLine": {
      removeLine(String(payload.ticketId || ""), String(payload.lineId || ""));
      broadcastState();
      return;
    }
    case "ticket:setLineDiscount": {
      setLineDiscount(String(payload.ticketId || ""), String(payload.lineId || ""), payload && payload.discount);
      broadcastState();
      return;
    }
    case "ticket:setMeta": {
      setTicketMeta(String(payload.ticketId || ""), payload || {});
      broadcastState();
      return;
    }
    case "ticket:setDiscount": {
      setTicketDiscount(String(payload.ticketId || ""), payload && payload.discount);
      broadcastState();
      return;
    }
    case "ticket:sendToKitchen": {
      const ticketId = String(payload.ticketId || "");
      const moved = sendNewItemsToKitchen(ticketId);
      const t = findTicket(ticketId);
      if (moved > 0 && t && t.tableId) setTableReceived(String(t.tableId), true);
      if (moved > 0) {
        const place = t && t.tableId ? tableLabel(t.tableId) : "";
        const msg = place ? `Pedido a cocina ${place}` : "Pedido enviado a cocina";
        notify(msg, "info", { action: "ticket:sendToKitchen", ticketId: t ? t.id : null }, by);
      }
      broadcastState();
      return;
    }
    case "ticket:setKitchenStatus": {
      setKitchenStatus(String(payload.ticketId || ""), String(payload.status || ""), payload || {});
      broadcastState();
      return;
    }
    case "ticket:close": {
      const ticketId = String(payload.ticketId || "");
      const sale = closeTicket(ticketId, payload || {});
      if (!sale) {
        notify("Importe insuficiente para cerrar la cuenta", "warn", { action: "ticket:close:blocked", ticketId }, by);
        broadcastState();
        return;
      }
      const t = findTicket(ticketId);
      const place = t && t.tableId ? tableLabel(t.tableId) : "";
      const msg = place ? `Cuenta cerrada ${place}` : "Cuenta cerrada";
      notify(msg, "info", { action: "ticket:close", ticketId: t ? t.id : null }, by);
      broadcastState();
      return;
    }
    case "table:setReceived": {
      setTableReceived(String(payload.tableId || ""), !!payload.received);
      broadcastState();
      return;
    }
    case "cash:open": {
      cashOpenForDate(payload.dateKey || ymd(), Number(payload.openingCash || 0), String(payload.note || ""));
      broadcastState();
      return;
    }
    case "cash:close": {
      cashClose(Number(payload.closingCash || 0), String(payload.note || ""));
      broadcastState();
      return;
    }
    case "cash:sessionUpdate": {
      updateCashSession(payload || {});
      broadcastState();
      return;
    }
    case "cash:turnOpen": {
      openCashTurn(payload || {}, by);
      broadcastState();
      return;
    }
    case "cash:turnUpdate": {
      updateCashTurn(payload || {});
      broadcastState();
      return;
    }
    case "cash:turnClose": {
      closeCashTurn(payload || {}, by);
      broadcastState();
      return;
    }
    case "cash:movement": {
      const dateKey = ymd();
      const openTurn = getOpenCashTurn(dateKey);
      if (!openTurn) {
        notify("No hay turno abierto. Abri el turno para registrar movimientos.", "warn", { action: "cash:movement" }, by);
        return;
      }
      recordCashMovement({
        dateKey,
        type: String(payload.type || "out") === "in" ? "in" : "out",
        method: String(payload.method || "efectivo"),
        amount: Number(payload.amount || 0),
        note: String(payload.note || ""),
      });
      DB.updatedAt = now();
      scheduleSave();
      broadcastState();
      return;
    }
    case "cash:transfer": {
      recordCashTransfer(payload || {}, by);
      broadcastState();
      return;
    }
    case "cash:movementBig": {
      const dateKey = String((payload && payload.dateKey) || ymd());
      recordCajaMayorMovement({
        dateKey,
        type: String(payload.type || "out") === "in" ? "in" : "out",
        amount: Number(payload.amount || 0),
        note: String(payload.note || ""),
        by,
      });
      DB.updatedAt = now();
      scheduleSave();
      broadcastState();
      return;
    }
case "settings:update": {
  updateSettings(payload.patch || {});
  broadcastState();
  return;
}
    case "inventory:addIngredient": {
      addIngredient(payload || {});
      broadcastState();
      return;
    }
    case "inventory:setIngredient": {
      setIngredient(String(payload.ingredientId || ""), payload || {});
      broadcastState();
      return;
    }
    case "inventory:setRecipe": {
      setRecipe(String(payload.productId || ""), payload.recipe || []);
      broadcastState();
      return;
    }

    case "tables:setCount": {
      setTablesCount(Number(payload.count || 0));
      broadcastState();
      return;
    }
    case "tables:rename": {
      renameTable(String(payload.tableId || ""), String(payload.name || ""));
      broadcastState();
      return;
    }
    case "tables:reorder": {
      reorderTables(payload.order || []);
      broadcastState();
      return;
    }
    case "ticket:moveTable": {
      const ticketId = String(payload.ticketId || "");
      const toTableId = String(payload.toTableId || "");
      const t = findTicket(ticketId);
      const fromLabel = t && t.tableId ? tableLabel(t.tableId) : "";
      const toLabel = toTableId ? tableLabel(toTableId) : "";
      moveTicketToTable(ticketId, toTableId);
      const msg = (fromLabel || toLabel) ? `Mesa movida ${fromLabel || "?"} -> ${toLabel || "?"}` : "Mesa movida";
      notify(msg, "warn", { action: "ticket:moveTable", ticketId, fromTableId: t ? t.tableId : null, toTableId }, by);
      broadcastState();
      return;
    }

    case "products:upsert": {
      await upsertProduct(payload || {});
      const name = String((payload && payload.name) || "").trim();
      const action = payload && payload.productId ? "actualizado" : "creado";
      notify(`Producto ${action}: ${name || "sin nombre"}`, "info", { action: "products:upsert", productId: payload && payload.productId ? String(payload.productId) : null, name }, by);
      broadcastState();
      return;
    }
case "products:setSector": {
  setProductSector(String(payload.productId || ""), String(payload.sectorId || "general"));
  broadcastState();
  return;
}
case "products:setModifiers": {
  setProductModifiers(String(payload.productId || ""), payload.modifiers || []);
  broadcastState();
  return;
}
    case "products:delete": {
      const productId = String(payload.productId || "");
      const prod = (DB.products || []).find(p => p && p.id === productId);
      const name = prod ? prod.name : productId;
      await deleteProduct(productId);
      notify(`Producto eliminado: ${name || productId}`, "warn", { action: "products:delete", productId }, by);
      broadcastState();
      return;
    }
    case "products:renameId": {
      const fromId = String(payload.fromId || "");
      const toId = String(payload.toId || "");
      renameProductId(fromId, toId);
      notify(`Producto renombrado: ${fromId} -> ${toId}`, "info", { action: "products:renameId", fromId, toId }, by);
      broadcastState();
      return;
    }
    case "tables:resetLayout": {
      resetTablesLayout();
      broadcastState();
      return;
    }
    case "tables:link": {
      addTableLink(String(payload.fromId || ""), String(payload.toId || ""));
      broadcastState();
      return;
    }
    case "tables:setLayout": {
      setTableLayout(String(payload.tableId || ""), payload || {});
      broadcastState();
      return;
    }
    case "people:addSupplier": {
      addSupplier(payload || {});
      broadcastState();
      return;
    }
    case "purchases:create": {
      createPurchase(payload || {});
      broadcastState();
      return;
    }
    case "accounts:supplierPayment": {
      supplierPayment(payload || {});
      broadcastState();
      return;
    }
    case "fiscal:markIssued": {
      await markFiscalDocIssued(String(payload.docId || ""), payload.patch || {});
      broadcastState();
      return;
    }
    case "fiscal:ensureDocForSale": {
      ensureFiscalDocForSale(String(payload.saleId || ""), { includeAll: payload.includeAll !== false });
      broadcastState();
      return;
    }
    case "fiscal:markSale": {
      const doc = ensureFiscalDocForSale(String(payload.saleId || ""), { includeAll: payload.includeAll !== false });
      if (doc) await markFiscalDocIssued(doc.id, payload.patch || {});
      broadcastState();
      return;
    }
    case "fiscal:generateFromSales": {
      generateFiscalDocsFromSales({ includeAll: payload.includeAll !== false });
      broadcastState();
      return;
    }
    case "people:ensureEmployee": {
      const emp = ensureEmployeeByName(String(payload.name || ws.name || ""));
      if (emp && payload.autoCheckIn) {
        if (getAttendanceStatus(emp.id) !== "in") recordAttendance(emp.id, "in", "Auto entrada");
      }
      broadcastState();
      return;
    }
    case "attendance:checkIn": {
      const emp = ensureEmployeeByName(String(payload.name || ws.name || ""));
      if (emp) recordAttendance(emp.id, "in", String(payload.note || ""));
      broadcastState();
      return;
    }
case "attendance:checkOut": {
      const emp = ensureEmployeeByName(String(payload.name || ws.name || ""));
      if (emp) recordAttendance(emp.id, "out", String(payload.note || ""));
      broadcastState();
      return;
    }
    case "notify:printRequired": {
      const ticketId = String(payload.ticketId || "");
      const t = ticketId ? findTicket(ticketId) : null;
      const place = (t && t.tableId) ? tableLabel(t.tableId) : "";
      const msg = place ? `Imprimir comanda ${place}` : "Imprimir comanda";
      notify(msg, "warn", { action: "print:required", ticketId, tableId: t ? t.tableId : null }, by);
      return;
    }
    case "day:close": {
      closeDay({
        closingCash: Number(payload.closingCash || 0),
        note: String(payload.note || ""),
        closedBy: String(payload.closedBy || ws.name || ""),
      });
      broadcastState();
      return;
    }
    case "period:close": {
      const closure = closePeriod({
        fromKey: String(payload.fromKey || ymd()),
        toKey: String(payload.toKey || ymd()),
        label: String(payload.label || ""),
        note: String(payload.note || ""),
        closedBy: String(payload.closedBy || ws.name || ""),
      });
      if (closure) notify(`Cierre guardado: ${closure.fromKey} → ${closure.toKey}`, "info", { action: "period:close", closureId: closure.id }, by);
      broadcastState();
      return;
    }
    case "period:adjust": {
      const adj = addPeriodAdjustment({
        closureId: String(payload.closureId || ""),
        amount: Number(payload.amount || 0),
        type: String(payload.type || "out"),
        note: String(payload.note || ""),
        by: String(payload.by || ws.name || ""),
      });
      if (adj) notify("Ajuste de cierre guardado", "info", { action: "period:adjust", closureId: payload.closureId }, by);
      broadcastState();
      return;
    }
    case "demo:generateSales": {
      demoGenerateSales({ count: Number(payload.count || 25) });
      broadcastState();
      return;
    }

    default:
      return;
  }
}


wss.on("connection", (ws, req) => {
  // Auth por cookie (login)
  const ses = req ? authFromReq(req) : null;
  ws.role = ses ? String(ses.role || "cliente").slice(0, 16) : "cliente";
  ws.restaurantId = ses ? String(ses.restaurantId || "") : "";
  ws.restaurantName = ses ? String(ses.restaurantName || "") : "";
  ws.name = (ses && ses.name) ? String(ses.name).slice(0, 24) : (ws.role === "admin" ? "Admin" : (ws.role === "mozo" ? "Mozo" : "Anónimo"));

  // snapshot al conectar (según rol)
  sendWsState(ws);

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === "hello") {
      // Solo permitimos actualizar nombre; el rol viene del login.
      if (data.name) ws.name = String(data.name || ws.name).slice(0, 24);
      ws.send(JSON.stringify({ type: "hello:ok", role: ws.role, name: ws.name, restaurantId: ws.restaurantId, restaurantName: ws.restaurantName }));
      return;
    }

    if (data.type === "state:request") {
      sendWsState(ws);
      return;
    }

    if (data.type === "action") {
      try {
        await runWithRestaurantContext(ws.restaurantId, async () => {
          const kind = String(data.kind || "");
          const payload = data.payload || {};
          const need = requiredRoleForAction(kind);
          if (!hasMinRole(ws.role, need)) {
            ws.send(JSON.stringify({ type: "action:error", kind, error: "forbidden", needRole: need }));
            return;
          }
          await applyAction(kind, payload, ws);
          ws.send(JSON.stringify({ type: "action:ok", kind }));
        });
      } catch (err) {
        const kind = String(data.kind || "");
        ws.send(JSON.stringify({ type: "action:error", kind, error: "server_error" }));
      }
      return;
    }
  });
});

// ------------------ Start ------------------
;(async () => {
  try {
    await initPersistence();
    MENU = await loadMenu();
    ROOT_DB = await loadRootDb(MENU);
    ensureAuthDefaults();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ PC: http://localhost:${PORT}`);
  console.log(`Storage: ${STORAGE && STORAGE.mode === "postgres" ? "postgres" : "file"}`);
  const ips = getLocalIPv4s();
  const urls = buildUrls(ips);
  const pref = preferredUrl(urls);

      if (pref) {
    console.log(`Cliente (menu):     ${pref}/menu.html`);
    console.log(`Central:           ${pref}/central.html`);
    console.log(`Mozo (login):      ${pref}/login.html?role=mozo`);
    console.log(`Cocina:            ${pref}/cocina.html`);
    console.log(`Admin (panel):     ${pref}/panel.html`);
  } else {
    console.log("⚠️ No pude detectar IP local. Usa ipconfig para ver tu IPv4.");
  }
});
  } catch (err) {
    console.error("Fallo al iniciar NEXA:", err && err.message ? err.message : err);
    process.exit(1);
  }
})();









