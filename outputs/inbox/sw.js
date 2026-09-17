// Service worker de la bandeja. Dos trabajos: arrancar rápido y recibir notificaciones.
//
// Estrategia de caché: RED PRIMERO con la caché como respaldo, igual que ReservApp. Y /api/
// excluido del caché por completo -- servir una bandeja vieja de caché ocultaría que alguien está
// esperando, que es justo lo único que esta app tiene que no ocultar nunca.
//
// No hay envío sin conexión a propósito: una respuesta en cola que sale sola media hora después,
// cuando la clienta ya se fue o la atendió otra, es peor que no haberla mandado. La app bloquea
// el envío y lo dice.
const CACHE = "dalfi-inbox-v1";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./transporte.js", "./config.js", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Nada de la API se guarda ni se sirve de caché. Ver la cabecera de este archivo.
  if (url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copia));
        return respuesta;
      })
      .catch(() => caches.match(event.request)),
  );
});

// --- Notificaciones ---------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  let datos = {};
  try { datos = event.data ? event.data.json() : {}; } catch { datos = {}; }
  const titulo = datos.title || "Dalfi Bandeja";
  event.waitUntil(self.registration.showNotification(titulo, {
    body: datos.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    // Una etiqueta por conversación: si llegan tres mensajes seguidos de la misma persona, se ve
    // un aviso que se actualiza, no tres apilados.
    tag: datos.data && datos.data.conversationId ? `conv-${datos.data.conversationId}` : undefined,
    renotify: true,
    data: datos.data || {},
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.conversationId;
  event.waitUntil((async () => {
    const clientes = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Si la app ya está abierta se la trae al frente y se le dice qué conversación abrir, en vez
    // de abrir una pestaña nueva encima de la que ya estaba usando.
    for (const cliente of clientes) {
      if (cliente.url.includes(self.location.origin)) {
        cliente.postMessage({ tipo: "abrir-conversacion", conversationId: id });
        return cliente.focus();
      }
    }
    return self.clients.openWindow(`./?conversacion=${encodeURIComponent(id || "")}`);
  })());
});
