const CACHE_NAME = "nexa-shell-v2";

const APP_SHELL = [
  "/",
  "/login.html",
  "/index.html",
  "/menu.html",
  "/mozo.html",
  "/cocina.html",
  "/salon_pc.html",
  "/admin_qr.html",
  "/admin_productos.html",
  "/admin_caja_test.html",
  "/admin_fiscal_test.html",
  "/admin_stats.html",
  "/profile.html",
  "/config.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

function canCacheResponse(res){
  return res && res.status === 200 && (res.type === "basic" || res.type === "default");
}

function isCacheableRequest(req){
  if(req.method !== "GET") return false;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return false;
  if(url.pathname.startsWith("/api/")) return false;
  if(url.pathname.startsWith("/images/")) return false;
  if(url.pathname === "/qr.png") return false;
  return req.mode === "navigate" ||
    ["style", "script", "worker", "manifest", "image", "font"].includes(req.destination) ||
    /\.(html|css|js|webmanifest|png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(url.pathname);
}

async function updateCache(req){
  const res = await fetch(req);
  if(canCacheResponse(res)){
    const cache = await caches.open(CACHE_NAME);
    await cache.put(req, res.clone());
  }
  return res;
}

async function staleWhileRevalidate(req){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const update = updateCache(req).catch(() => null);
  if(cached) return cached;
  const fresh = await update;
  if(fresh) return fresh;
  if(req.mode === "navigate"){
    return cache.match("/login.html");
  }
  return Response.error();
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if(!isCacheableRequest(req)) return;
  event.respondWith(staleWhileRevalidate(req));
});
