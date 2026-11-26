// Service worker : l'appli s'ouvre même sans réseau.
// Les données, elles, viennent du cache local de Firestore.
const CACHE = "bedetheque-v3";
const SHELL = [
  "./", "./index.html", "./css/style.css", "./manifest.webmanifest", "./favicon.svg",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./js/app.js", "./js/auth.js", "./js/components.js", "./js/constants.js", "./js/db.js",
  "./js/firebase-config.js", "./js/fs.js", "./js/image.js", "./js/isbn.js", "./js/scanner.js", "./js/ui.js", "./js/utils.js",
  "./js/views/account.js", "./js/views/bd-form.js", "./js/views/bds.js", "./js/views/collections.js",
  "./js/views/home.js", "./js/views/import.js", "./js/views/join.js", "./js/views/publishers.js",
  "./js/vendor/papaparse.min.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Hôtes mis en cache « au fil de l'eau » : SDK Firebase et polices.
const STATIC_HOSTS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Fichiers de l'appli : réseau d'abord (toujours la dernière version), cache en secours.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // SDK et polices : cache d'abord.
  if (STATIC_HOSTS.includes(url.hostname) && (url.hostname !== "www.gstatic.com" || url.pathname.startsWith("/firebasejs/"))) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
  // Tout le reste (Firestore, Auth, Google Books, couvertures) passe directement.
});
