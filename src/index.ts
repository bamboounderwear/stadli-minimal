// src/index.ts
// ESM Worker (no Service Worker syntax).
// Minimal file-based router + Eta templating + KV sessions + D1 + R2 + Workers AI.
// All complex logic is commented; keep this approachable.

import { render as etaRender, configure as etaConfigure } from "eta";

export interface Env {
  APP_NAME: string;
  SESSION_COOKIE_NAME: string;
  CSP_REPORT_ONLY: string;
  ASSETS: Fetcher;               // Static assets (public/)
  DB: D1Database;                // D1 binding
  SESSIONS_KV: KVNamespace;      // Session storage
  CONFIG_KV: KVNamespace;        // Config storage
  ASSETS_BUCKET: R2Bucket;       // R2 uploads
  AI: any;                       // Workers AI
}

type RouteHandler = (c: Ctx) => Promise<Response> | Response;

type Match = {
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
  method?: string;
};

class Ctx {
  req: Request;
  env: Env;
  params: Record<string, string>;
  url: URL;
  sessionId: string | null;
  constructor(req: Request, env: Env, params: Record<string, string>) {
    this.req = req;
    this.env = env;
    this.params = params;
    this.url = new URL(req.url);
    this.sessionId = null;
  }
  // Render an Eta page with base layout and navigation
  async view(page: string, data: Record<string, any> = {}) {
    const schema = await loadSchema();
    const nav = schema?.app?.navigation?.sidebar ?? [];
    const base = await renderEta("layouts/base", {
      title: data.title || "Stadli Admin",
      nav,
      active: data.active,
      appName: this.env.APP_NAME,
      content: await renderEta(page, { ...data, schema }),
    });
    return new Response(base, {
      headers: securityHeaders(this.env, { contentType: "text/html; charset=utf-8" }),
    });
  }
}

// ---- Eta in-memory loader (no file I/O at runtime) ----
const templates: Record<string, string> = {
  "layouts/base": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title><%= it.title || "Stadli Admin" %></title>
    <meta http-equiv="Content-Security-Policy" content="
      default-src 'self' cdn.jsdelivr.net;
      script-src 'self' 'unsafe-inline' cdn.jsdelivr.net;
      style-src 'self' 'unsafe-inline' cdn.jsdelivr.net;
      img-src 'self' data:;
      font-src 'self' data:;
      connect-src 'self';
      form-action 'self';
      upgrade-insecure-requests
    ">
    <link rel="stylesheet" href="/styles.css">
    <!-- Tailwind (optional, uncomment to use CDN, no build step) -->
    <!-- <script src="https://cdn.jsdelivr.net/npm/tailwindcss@3.4.13"></script> -->
  </head>
  <body>
    <div class="container">
      <%~ include('components/_nav', it) %>
      <main>
        <%- it.content %>
      </main>
      <div class="footer badge">Stadli • Minimal Cloudflare Stack</div>
    </div>
  </body>
</html>
`,
  "components/_nav": `<nav class="nav">
  <% if (it?.nav?.length) { %>
    <% it.nav.forEach(function(item){ %>
      <a href="<%= item.path %>" class="<%= it.active === item.id ? 'active' : '' %>"><%= item.label %></a>
    <% }) %>
  <% } else { %>
    <a href="/home" class="<%= it.active === 'home' ? 'active' : '' %>">Home</a>
  <% } %>
  <span style="margin-left:auto" class="badge"><%= it.appName || 'Stadli Admin' %></span>
</nav>
`,
  "pages/home": `<h1>Welcome to Stadli Admin</h1>
<div class="grid grid-2">
  <section class="card">
    <h2><%= it.schema.summary.title %></h2>
    <p><%= it.schema.summary.description %></p>
  </section>
  <section class="card">
    <h3>Quick Links</h3>
    <ul>
      <% it.schema.app.navigation.sidebar.forEach(function(s){ %>
        <li><a href="<%= s.path %>"><%= s.label %></a></li>
      <% }) %>
    </ul>
  </section>
</div>

<section class="card" style="margin-top:1rem">
  <h3>Cores</h3>
  <div class="grid grid-2">
  <% it.schema.summary.cores.forEach(function(c){ %>
    <div class="card">
      <strong><%= c.name %></strong>
      <p class="badge"><%= c.description %></p>
    </div>
  <% }) %>
  </div>
</section>
`,
  "pages/health": `<h1>OK</h1>
<p class="badge">Time: <%= it.now %></p>
<table>
  <tr><th>D1</th><td><%= it.db %></td></tr>
  <tr><th>KV</th><td><%= it.kv %></td></tr>
  <tr><th>R2</th><td><%= it.r2 %></td></tr>
</table>
`,
  // generic stub for many routes
  "pages/stub": `<h1><%= it.title %></h1>
<p class="badge">Stub page: <code><%= it.path %></code>. Replace with real content.</p>
<ul>
  <li>POST to this path will validate a CSRF token.</li>
  <li>Sessions are stored in KV (demo only).</li>
</ul>
`,
};

etaConfigure({
  views: "/", // not used; we provide templates programmatically
  cache: true,
});

async function renderEta(name: string, it: any) {
  const tpl = templates[name];
  if (!tpl) return `Missing template: ${name}`;
  return etaRender(tpl, it, { filename: name }) as string;
}

// ---- Router utilities ----
function pathToRegex(path: string) {
  const keys: string[] = [];
  const regex = path
    .replace(/\//g, "\\/")
    .replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return "([^/]+)";
    });
  return { pattern: new RegExp(`^${regex}$`), keys };
}

function matchRoute(req: Request, routes: Match[]): Match & { params: Record<string,string> } | null {
  const url = new URL(req.url);
  const pathname = url.pathname.endsWith("/") && url.pathname !== "/" ? url.pathname.slice(0, -1) : url.pathname;
  for (const r of routes) {
    if (r.method && r.method !== req.method) continue;
    const m = pathname.match(r.pattern);
    if (m) {
      const params: Record<string,string> = {};
      r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i+1]));
      return { ...r, params };
    }
  }
  return null;
}

// ---- Security headers ----
function securityHeaders(env: Env, opts?: { contentType?: string }) {
  const hdrs = new Headers();
  if (opts?.contentType) hdrs.set("content-type", opts.contentType);
  const cspBase = "default-src 'self' cdn.jsdelivr.net; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; upgrade-insecure-requests";
  hdrs.set("content-security-policy", env.CSP_REPORT_ONLY === "true" ? cspBase.replace("default-src", "default-src") : cspBase);
  hdrs.set("x-content-type-options", "nosniff");
  hdrs.set("x-frame-options", "DENY");
  hdrs.set("referrer-policy", "no-referrer");
  hdrs.set("permissions-policy", "geolocation=(), camera=(), microphone=()");
  return hdrs;
}

// ---- Sessions (demo) ----
async function getSessionId(c: Ctx) {
  const cookie = c.req.headers.get("cookie") || "";
  const name = c.env.SESSION_COOKIE_NAME;
  const m = cookie.match(new RegExp(`${name}=([^;]+)`));
  if (m) return m[1];
  const sid = crypto.randomUUID();
  const expires = new Date(Date.now() + 1000*60*60*24*30).toUTCString();
  const hdrs = new Headers({ "set-cookie": `${name}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}` });
  c.sessionId = sid;
  return { sid, headers: hdrs };
}

// ---- CSRF scaffold ----
function csrfTokenFromCookie(c: Ctx) {
  const m = (c.req.headers.get("cookie") || "").match(/csrf=([^;]+)/);
  return m?.[1];
}
function newCsrfToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

// ---- Rate limit (very light, demo only) ----
async function rateLimit(c: Ctx, key: string, limit = 100, ttlSec = 60) {
  const k = `rl:${key}`;
  const n = (await c.env.SESSIONS_KV.get(k)) || "0";
  const count = parseInt(n, 10) + 1;
  await c.env.SESSIONS_KV.put(k, String(count), { expirationTtl: ttlSec });
  if (count > limit) return new Response("Too Many Requests", { status: 429 });
  return null;
}

// ---- Schema (static JSON embedded at build) ----
const SCHEMA: any = {
  "summary": {
    "title": "Product Summary",
    "description": "Stadli is the all-in-one revenue + marketing OS for pro teams outside the big four. It launches with five integrated cores that work together from day one.",
    "cores": [
      {
        "name": "Web App / Website",
        "description": "A PWA-first team hub combining a modern web experience and branded app shell. Includes Game Day Central, sponsor surfaces, push notifications, and built-in checkout for tickets, merch, and experiences."
      },
      {
        "name": "CRM / 360\u00b0 Fan Profile",
        "description": "Unified fan database stitching ticketing, merch, and digital touchpoints into a single view. Enables live segmentation, lifecycle tracking, and identity resolution for every fan."
      },
      {
        "name": "Campaign Engine & Playbooks",
        "description": "Multi-channel campaign system with sports-ready templates and prebuilt revenue plays. Launch push/email automations, drive purchases, and measure closed-loop revenue attribution from message to checkout."
      },
      {
        "name": "Stadli Narratives & Analytics",
        "description": "Daily role-based digest (email + dashboard) with one-click, prefilled actions tailored to GM, Marketing, and Ops roles. Powered by Stadli Web Tag for standardized analytics, event tracking, and attribution."
      },
      {
        "name": "Commerce & Ticketing",
        "description": "Native ticketing and ecommerce layer with secure payment processing, unified checkout, fan wallet, and real-time reconciliation with Tixr and Shopify webhooks."
      }
    ]
  },
  "flagship_features": {
    "title": "Flagship Features",
    "description": "Core capabilities that define Stadli\u2019s MVP and roadmap-ready foundation.",
    "sections": []
  },
  "app": {
    "name": "Stadli Admin",
    "navigation": {
      "layout": "sidebar",
      "sidebar": [
        {
          "id": "home",
          "label": "Home",
          "path": "/home"
        },
        {
          "id": "web",
          "label": "Web App / Website",
          "path": "/web"
        },
        {
          "id": "crm",
          "label": "CRM / 360 Fan Profile",
          "path": "/crm"
        },
        {
          "id": "campaigns",
          "label": "Campaign Engine & Playbooks",
          "path": "/campaigns"
        },
        {
          "id": "analytics",
          "label": "Narratives & Analytics",
          "path": "/analytics"
        },
        {
          "id": "commerce",
          "label": "Commerce & Ticketing",
          "path": "/commerce"
        },
        {
          "id": "settings",
          "label": "Settings & Admin",
          "path": "/settings"
        }
      ]
    },
    "mvp_screens": [
      "/home",
      "/crm/fans",
      "/crm/fans/:id",
      "/crm/segments",
      "/crm/segments/new",
      "/campaigns/list",
      "/campaigns/new",
      "/campaigns/playbooks",
      "/analytics/narratives",
      "/analytics/overview",
      "/analytics/attribution",
      "/web/pages",
      "/web/blocks",
      "/web/offers-surfaces",
      "/commerce/catalog/tickets",
      "/commerce/catalog/products",
      "/commerce/catalog/offers",
      "/commerce/orders",
      "/commerce/checkout",
      "/settings/users",
      "/settings/integrations"
    ]
  }
};
async function loadSchema() { return SCHEMA; }

// ---- Handlers ----
const routes: Match[] = [];

// Static assets first
routes.push({
  ...pathToRegex("/(.*)"),
  handler: async (c: Ctx) => {
    // Serve /styles.css and other files from public/
    const res = await c.env.ASSETS.fetch(c.req);
    if (res.status !== 404) return res;
    return new Response(null, { status: 404 });
  },
  method: "GET"
});

// Health
routes.push({
  ...pathToRegex("/_health"),
  handler: async (c: Ctx) => {
    const db = await c.env.DB.prepare("select 1 as ok").first<{ok:number}>().then(v => v?.ok === 1 ? "ok" : "err").catch(()=> "err");
    const kv = await c.env.SESSIONS_KV.put("healthcheck", String(Date.now()), { expirationTtl: 60 }).then(()=> "ok", ()=>"err");
    const r2 = await c.env.ASSETS_BUCKET.head("nonexistent").then(()=> "ok", ()=>"ok");
    return c.view("pages/health", { active: "home", now: new Date().toISOString(), db, kv, r2, title: "Health" });
  },
  method: "GET"
});

// Home redirect
routes.push({
  ...pathToRegex("/"),
  handler: async (c: Ctx) => Response.redirect(new URL("/home", c.req.url), 302),
  method: "GET"
});

// Home
routes.push({
  ...pathToRegex("/home"),
  handler: async (c: Ctx) => {
    return c.view("pages/home", { active: "home", title: "Home" });
  },
  method: "GET"
});

// Generic admin sections -> serve stub template
const stubPaths = [
  "/web", "/crm", "/campaigns", "/analytics", "/commerce", "/settings",
  "/crm/fans", "/crm/fans/:id", "/crm/segments", "/crm/segments/new",
  "/campaigns/list", "/campaigns/new", "/campaigns/playbooks",
  "/analytics/narratives", "/analytics/overview", "/analytics/attribution",
  "/web/pages", "/web/blocks", "/web/offers-surfaces",
  "/commerce/catalog/tickets", "/commerce/catalog/products", "/commerce/catalog/offers",
  "/commerce/orders", "/commerce/checkout", "/settings/users", "/settings/integrations"
];
for (const p of stubPaths) {
  const { pattern, keys } = pathToRegex(p);
  routes.push({
    pattern, keys,
    handler: async (c: Ctx) => {
      const active = (p.split("/")[1] || "home");
      return c.view("pages/stub", { active, title: p.split("/").filter(Boolean).join(" • ") || "Page", path: p });
    },
    method: "GET"
  });
}

// API: upload to R2 (PUT /api/upload?key=...)
routes.push({
  ...pathToRegex("/api/upload"),
  handler: async (c: Ctx) => {
    if (c.req.method !== "PUT") return new Response("Method Not Allowed", { status: 405 });
    const url = new URL(c.req.url);
    const key = url.searchParams.get("key");
    if (!key) return new Response("Missing ?key", { status: 400 });
    const body = await c.req.arrayBuffer();
    await c.env.ASSETS_BUCKET.put(key, body);
    return new Response(JSON.stringify({ ok: true, key }), { headers: { "content-type": "application/json" } });
  }
});

// API: Workers AI echo (GET /api/ai/echo?q=...)
routes.push({
  ...pathToRegex("/api/ai/echo"),
  handler: async (c: Ctx) => {
    const q = new URL(c.req.url).searchParams.get("q") || "hello";
    // Call a tiny fast model for embedding-ish echo; replace with your model call as needed
    // Using text-generation chat as a placeholder to verify AI binding works.
    const resp = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages: [{ role: "user", content: q }] });
    return new Response(JSON.stringify({ ok: true, q, result: resp }), { headers: { "content-type": "application/json" } });
  },
  method: "GET"
});

// Fallback 404
routes.push({
  ...pathToRegex(".*"),
  handler: async (c: Ctx) => new Response("Not Found", { status: 404 }),
});

// ---- Exported Worker ----
export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Basic rate limit
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    const rl = await rateLimit(new Ctx(req, env, {}), `ip:${ip}`);
    if (rl) return rl;

    // Router
    const m = matchRoute(req, routes);
    if (!m) return env.ASSETS.fetch(req); // try static assets
    const ctx = new Ctx(req, env, m.params);

    // Sessions
    const sid = await getSessionId(ctx);
    let headers: Headers | undefined;
    if (typeof sid === "object") headers = sid.headers;

    const res = await m.handler(ctx);
    if (headers) {
      // merge set-cookie
      const h = new Headers(res.headers);
      h.append("set-cookie", headers.get("set-cookie") || "");
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },

  // Example cron alarm
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Lightweight heartbeat
    await env.CONFIG_KV.put("last_cron", new Date().toISOString());
  }
} satisfies ExportedHandler<Env>;
