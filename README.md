# Stadli Minimal Cloudflare Stack

**Goal:** Upload this repo to GitHub and deploy via **deploy.workers.cloudflare.com** with minimal configuration.

## What's included

- **Cloudflare Worker (TypeScript, ES Modules)** with a tiny file-system router
- **UI authoring with Eta** (runtime templates, no build step)
- **Plain CSS** (Tailwind CDN commented in `base.eta` if you prefer)
- **Static assets** via Workers Static Assets (`public/`)
- **State/Data** bindings: **D1**, **KV** (sessions + config), **R2** (uploads/assets), **Workers AI**
- **Security**: sensible security headers, cookie flags, CSRF token scaffold, very light rate-limit
- **Pages**: placeholders for the MVP admin routes under `/pages`
- **Migrations**: `migrations/0001_init.sql` for D1 starter tables
- **Tests/Usage**: curl examples at the bottom of this README

> WebC is "preferred" in the brief, but WebC typically requires a build step (e.g., 11ty).
> To keep this repo **buildless**, UI uses **Eta** at runtime. You can still author HTML-first with partials/components.
> If you truly need WebC later, add an 11ty build and serve compiled HTML from `public/`.

## One-time Cloudflare setup (fast)

1. Go to `deploy.workers.cloudflare.com` → **Add from GitHub** → select this repo.
2. In the **Resources** step, create/provision the following (names must match `wrangler.jsonc`):
   - D1: `stadli-d1`
   - KV: `stadli-sessions`, `stadli-config`
   - R2 bucket: `stadli-assets`
   - Workers AI: enabled (no extra config)
3. Deploy. The router serves `/home` as default route.

> You can change names, but keep `wrangler.jsonc` in sync.

## Local dev

```bash
npm i
npm run dev
# open http://127.0.0.1:8787
```

> To apply D1 migrations locally:
```bash
npm run migrate
```

## Structure

```
src/
  index.ts            # Worker, router, handlers
  app_schema.json     # Product/app/navigation JSON (from brief) available to templates
templates/
  layouts/base.eta
  components/_nav.eta
  pages/...           # One .eta per route
public/
  styles.css
migrations/
  0001_init.sql
```

## Security notes

- Session cookie is **HttpOnly, Secure, SameSite=Lax**.
- Basic CSRF token scaffold (double-submit cookie) on POST endpoints.
- Minimal rate limiting by IP via KV (demo-scale). Replace with Durable Object for real apps.
- CSP is set; toggle report-only with `CSP_REPORT_ONLY` env var in `wrangler.jsonc`.

## Curl tests

```bash
# Home
curl -i https://<your-domain>/home

# Health
curl -i https://<your-domain>/_health

# Upload to R2 (demo)
curl -i -X PUT --data-binary @public/styles.css https://<your-domain>/api/upload?key=test.css

# AI echo (Workers AI)
curl -i https://<your-domain>/api/ai/echo?q=hello
```
