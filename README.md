# Hepple · Analytics Portal

A private dashboard for **Hepple Spirits** — revenue, orders, fulfilment and
visitor behaviour in one place. Built and maintained by **Barker Digital**.

It is a companion to the Hepple website: the site takes payments (Stripe) and
records orders (Supabase) and behaviour (PostHog); this portal reads all three
back and presents them.

---

## What it shows

| Section | Source of truth | Notes |
|---|---|---|
| **Performance KPIs** — gross revenue, net (after fees), orders, customers, AOV, conversion | Stripe + PostHog | Net = gross − estimated Stripe fees |
| **Revenue over time** — 30-day daily line chart | Stripe | Chart.js |
| **By product** — revenue + units per bottle | Stripe / orders | Live mode derives this from order line items |
| **Fulfilment** — % dispatched, outstanding count + value, progress bar | Supabase | The only writable section |
| **Orders table** — with one-click *Mark fulfilled* / *Mark unsent* | Supabase | Writes back to `orders.fulfilled` |
| **Traffic & conversion** — funnel, top pages, sources, abandoned carts | PostHog | HogQL query API |
| **Top customers** — top 8 by spend | derived from orders | Works in every mode |

---

## Demo mode (important)

**With no environment variables set, the portal runs in DEMO MODE.** It serves
realistic, deterministic sample data (≈130 orders over 90 days, Scottish /
Northumbrian customers, matching funnel + traffic) and shows a blue banner so it
can never be mistaken for real figures.

This means you can deploy it immediately and see exactly how it looks, then
connect each service one at a time. Each data feed flips to live independently —
e.g. you can have live Stripe revenue while PostHog is still demo.

| Feed | Goes live when you set |
|---|---|
| Revenue / orders / customers | `STRIPE_SECRET_KEY` |
| Fulfilment (read + write) | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| Traffic / funnel | `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` |

---

## Connecting each service

### 1. Stripe — revenue, orders, customers
1. Stripe Dashboard → **Developers → API keys**.
2. Copy the **Secret key** (`sk_live_…`, or `sk_test_…` to trial).
3. Set `STRIPE_SECRET_KEY`.

The portal reads charges (last 90 days) for revenue and expands the balance
transaction to show **true net after fees**. Read-only — it never creates or
modifies anything in Stripe.

### 2. Supabase — fulfilment
This is the **same table the Hepple website writes orders into**, so the two
apps share one source of truth.
1. Supabase → **SQL Editor**, run [`supabase-schema.sql`](./supabase-schema.sql)
   (skip if the site already created the `orders` table).
2. **Project Settings → API**: copy the **Project URL** and the
   **`service_role`** key.
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

> The `service_role` key is admin-level. It lives only in server env vars and is
> never sent to the browser. RLS is enabled with no public policies.

When Supabase is connected, the orders table shows real fulfilment state and the
**Mark fulfilled** buttons persist. Without it, the portal falls back to Stripe
sessions (read-only, everything shown as outstanding) and the toggle is
optimistic-only.

### 3. PostHog — behaviour
1. PostHog → **Settings → Personal API keys** → create one
   (scope: *Query Read*). This is **not** the `phc_…` key on the website.
2. Find your **Project ID** (Settings → Project — the number).
3. Set `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, and `POSTHOG_HOST`
   (`https://eu.i.posthog.com` for EU cloud, `https://us.i.posthog.com` for US).

Powers the funnel (`$pageview → product_viewed → product_added_to_cart →
checkout_started → purchase`), top pages, traffic sources and abandoned carts —
the events the Hepple site already sends.

---

## Deploy (Vercel)

1. Push this folder to its **own** Git repo (separate from the website).
2. Vercel → **New Project** → import it.
3. Framework preset: **Other** (it is already configured — static files +
   `/api/*` serverless functions, no build step).
4. Add the environment variables above (omit any service to keep it in demo).
5. Deploy.

Local dev:
```bash
npm install
npx vercel dev      # serves the static site + /api functions locally
```

The portal is marked `noindex, nofollow` and sends `no-store` on all API
responses. For real-world use, also put it behind access control
(e.g. **Vercel → Settings → Deployment Protection → Password / Vercel
Authentication**) so only the Hepple team can open it.

---

## Project structure

```
hepple-portal/
├─ index.html              Dashboard shell
├─ styles.css              Editorial styling (Hepple blue + cream, Proxima Nova)
├─ app.js                  Fetches /api/*, renders KPIs/chart/tables, fulfil toggle
├─ api/
│  ├─ _demo.js             Deterministic demo dataset (seeded)
│  ├─ metrics.js           GET — Stripe revenue/orders/customers (+ demo fallback)
│  ├─ orders.js            GET — Supabase → Stripe → demo, with fulfilment summary
│  ├─ fulfill.js           POST — toggle fulfilled state in Supabase
│  └─ analytics.js         GET — PostHog funnel/traffic (+ demo fallback)
├─ assets/
│  ├─ brand/               Hepple logotype (primary) + Barker Digital mark
│  └─ fonts/               Self-hosted Proxima Nova
├─ supabase-schema.sql     orders table (shared with the site)
├─ .env.example            Every variable, documented
├─ vercel.json             Static + functions config, security headers
└─ package.json            stripe dependency, Node ≥ 18
```

Every API route degrades safely: if a live service errors, that feed returns
demo data with an `error` flag rather than breaking the dashboard.
