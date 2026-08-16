# sheets — Void Sheets

**Collaborative spreadsheets for the VoidSuite family.** Sign in with **VoidAuth** once and
your spreadsheets sync to any device — no passphrase, nothing to enter. Excel-style functions,
smart drag, formatting, per-sheet tabs, imports/exports, live multi-user editing, and an
optional **end-to-end encrypted** Vault mode per sheet.

> **Security model:** Void Sheets has two tiers. Regular sheets are *server-authoritative*
> (the chat-app trade-off: live collaboration, presence, version history) — the server can
> read them. With **Vault** you flip a sheet to single-user E2E: the document is AES-GCM
> encrypted in your browser and the server stores only ciphertext, share links and memberships
> are cleared, and the vault key is escrowed (VoidAuth storage, wrapped under your device key).

## Highlights

| Feature | How it works |
| --- | --- |
| Sign in with VoidAuth | OAuth 2.0 + PKCE against VoidAuth (browser SDK or gateway proxy) — the gateway mints an httpOnly session cookie. |
| Univer grid | Full-featured spreadsheet engine (formulas, number formats, filters, conditional formatting, data validation, hyperlinks, notes) via `@univerjs/presets`. |
| Server-authoritative doc | The gateway keeps a normalized **VS1** document and applies a whitelisted, validated op log — stable snapshots for version history and replay. |
| Live multiplayer | Optimistic edits + authenticated WebSocket push: peers get ops, presence and live cursors; reconnect catches up via `GET /ops?after=`. |
| Excel imports/exports | `.xlsx` in/out (exceljs), `.csv`/`.tsv` (papaparse), `.html`/`.md` export, print/PDF via print layout. |
| Smart tabs | Per-sheet tabs: insert, rename, reorder, duplicate, tab colors — plus command palette (⌘K), shortcuts pack (F2, Ctrl+D, Ctrl+R, Ctrl+;), templates and charts. |
| Vault (E2E) | Per-sheet toggle: AES-GCM-256, `iv‖ct` blobs, server sees ciphertext only. Vault key wrapped + escrowed; unlock per device. |
| Share links | Per-file secret-token links with viewer/editor roles; owners curate members. |

## Architecture

```
client/   Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui (Base UI) + Univer — PWA
server/   Bun + Hono gateway: VoidAuth session, REST API, SQLite store, WebSocket push
```

- Client :5178 · gateway :3007 · SQLite at `server/data/sheets.db` (auto-migrated on boot).
- Auth modes via `VITE_AUTH_MODE`: `backend` (gateway proxy, recommended) or `browser`
  (`@voidauth/client` PKCE directly against VoidAuth).

## Getting started

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
cp .env.example .env        # fill in values (see below)
bun dev.ts                  # client :5178 + gateway :3007 together
```

Open the client, sign in with VoidAuth, create a sheet, type some formulas (`=SUM(A1:A5)`,
`=VLOOKUP(...)`), import an `.xlsx`, share a link, and try the Vault toggle.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `VOIDAUTH_URL` | VoidAuth issuer (prod `https://auth.stwupid.tech`). |
| `SHEETS_CLIENT_ID` / `SHEETS_CLIENT_SECRET` | OAuth client for sheets (backend mode). |
| `SESSION_SECRET` | Encrypts the local vault-key escrow fallback at rest. |
| `APP_URL` | Public app URL (OAuth redirect, CORS, secure cookies). |
| `PORT` | Gateway port (default `3007`). |
| `VITE_AUTH_MODE` | `backend` (default) \| `browser`. |
| `VITE_VOIDAUTH_CLIENT_ID` | Same value as `SHEETS_CLIENT_ID` (browser mode). |

### Registering the OAuth client

Ask the voidsuite admin to register a VoidAuth client for `sheets` with scopes
`openid profile email` and redirect URI `<APP_URL>/oauth/callback`, then put the issued
client id/secret into `.env`. In local dev, the VoidAuth seed should include a `sheets`
client pointing at `http://localhost:5178/oauth/callback`.

## Docker

```bash
docker compose up --build   # builds client + server, serves everything on :3007
```

The database lives in the `sheets-data` named volume, so your spreadsheets survive container
recreates. Point `DATA_DIR` elsewhere if you'd rather keep them outside Docker.

## License

MIT — see [LICENSE](LICENSE). sheets is part of the **VoidSuite** app family.