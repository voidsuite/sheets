/**
 * sw.js — VoidSheets offline shell.
 *
 * The SPA shell (index.html + hashed assets) is served cache-first so the
 * board UI loads instantly and works offline. API, auth and websocket
 * requests are NEVER cached — they always hit the network.
 *
 * Bump CACHE_VERSION when you change caching behavior so old caches are
 * cleaned up on the next load.
 */

const CACHE_VERSION = "v1"
const SHELL_CACHE = `voidsheets-shell-${CACHE_VERSION}`
const SHELL_URLS = ["/", "/manifest.webmanifest", "/favicon.svg"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith("voidsheets-shell-") && key !== SHELL_CACHE).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

/** Requests that must never be served from cache (auth-sensitive / dynamic). */
function isNetworkOnly(request) {
  const url = new URL(request.url)
  if (request.method !== "GET") return true
  if (url.pathname.startsWith("/api/")) return true
  if (url.pathname.startsWith("/oauth/")) return true
  if (url.pathname.startsWith("/ws")) return true
  return false
}

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET" || !request.url.startsWith(self.location.origin)) return

  // Auth, realtime and API traffic: network only, no caching.
  if (isNetworkOnly(request)) return

  // Page navigations: network-first so deploys land immediately, with the
  // cached shell as an offline fallback (the router renders the app UI).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put("/", copy))
          return response
        })
        .catch(() => caches.match("/"))
    )
    return
  }

  // Hashed static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
