/**
 * sheets gateway — serves the built client (client/dist) plus the API:
 *   /api/auth/*        VoidAuth OAuth proxy (PKCE, httpOnly session cookie)
 *   /api/sheets        workbook CRUD, share links, members, document hydrate
 *   /api/sheets/:id    /ops (collab write path), /versions, /vault (E2E)
 *   /api/storage/*     VoidAuth storage proxy + vault-key escrow
 *   /api/ws            Realtime (op broadcast, presence, live cursors)
 *
 * Data lives in SQLite (DATA_DIR/sheets.db) — sign in once, sheets are
 * there on any device. Vaulted workbooks are stored as opaque ciphertext.
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { fileURLToPath } from "node:url"
import path from "node:path"
import config from "./config.js"
import authRoutes from "./routes/auth.js"
import sheetsRoutes from "./routes/sheets.js"
import opsRoutes from "./routes/ops.js"
import versionsRoutes from "./routes/versions.js"
import vaultRoutes from "./routes/vault.js"
import storageRoutes from "./routes/storage.js"
import { authRequired } from "./middleware/auth.js"
import { wsHandlers, handleWsUpgrade } from "./routes/ws.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.resolve(__dirname, "../../client/dist")

const app = new Hono()

app.use(
  "*",
  cors({
    origin: config.allowedOrigins.length ? config.allowedOrigins : config.appUrl,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: true,
  })
)

// Dev-friendly request log: method, path, status, and the error body for
// failures — makes OAuth/debug flows visible in the terminal.
app.use("*", async (c, next) => {
  await next()
  const res = c.res
  if (res.status >= 400) {
    const body = await res.clone().text().catch(() => "")
    console.log(`[http] ${c.req.method} ${c.req.path} -> ${res.status} ${body.slice(0, 200)}`)
  } else {
    console.log(`[http] ${c.req.method} ${c.req.path} -> ${res.status}`)
  }
})

// OAuth + session routes (no auth guard — they establish the session).
app.route("/api/auth", authRoutes)

// Everything else under /api requires a session (cookie) or bearer token.
const api = new Hono()
api.use("*", authRequired)
// NOTE: Hono v4 `route("/", subApp)` does not register the sub-app's routes
// (the parent's "/" base matches nothing) — every mount must use a non-root
// base. All workbook routes live under /api/sheets, storage under /api/storage.
api.route("/sheets", sheetsRoutes)
api.route("/sheets", opsRoutes)
api.route("/sheets", versionsRoutes)
api.route("/sheets", vaultRoutes)
api.route("/storage", storageRoutes)
app.route("/api", api)

app.get("/health", (c) => c.json({ status: "ok", service: "sheets" }))

// Static client + SPA fallback
const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain",
  map: "application/json",
  webmanifest: "application/manifest+json",
}

app.get("*", async (c) => {
  const reqPath = c.req.path
  const filePath = reqPath === "/" ? "/index.html" : reqPath
  const ext = filePath.split(".").pop()?.toLowerCase() || ""
  const f = Bun.file(path.join(DIST_DIR, filePath))
  const exists = await f.exists()

  if (exists) {
    return new Response(f, {
      headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" },
    })
  }
  if (!reqPath.startsWith("/api/")) {
    const fallback = Bun.file(path.join(DIST_DIR, "index.html"))
    if (await fallback.exists()) {
      return new Response(fallback, { headers: { "Content-Type": "text/html" } })
    }
  }
  return c.json({ error: "Not found" }, 404)
})

console.log(`[sheets] gateway starting on :${config.port} (${config.appUrl})`)

export default {
  port: config.port,
  fetch: async (req: Request, server: import("bun").Server<unknown>) => {
    const url = new URL(req.url)
    if (url.pathname === "/api/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const res = handleWsUpgrade(req, server)
      if (res) return res
      return undefined
    }
    return app.fetch(req)
  },
  websocket: wsHandlers,
}
