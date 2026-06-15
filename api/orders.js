// ============================================================
//  GET /api/orders
//  Returns orders with fulfilment status + summary counts.
//  Priority: SUPABASE → STRIPE → DEMO
//  Query: ?days=N (default 180, max 730), ?limit=N (default 500)
// ============================================================
const demo = require('./_demo');

const DAY = 86400000;

// Product catalogue — SKU / slug / name lookup for Stripe line items
// that don't carry full product metadata. Add entries here as new
// products are created in Stripe.
const SKU_MAP = {
  'HEP-GIN-70':  { slug: 'hepple-wild-juniper-gin',  name: 'Hepple Wild Juniper Gin'  },
  'HEP-DFV-70':  { slug: 'hepple-douglas-fir-vodka', name: 'Hepple Douglas Fir Vodka' },
  'HEP-WHV-70':  { slug: 'hepple-moorland-vodka',    name: 'Hepple Wheat Vodka'       },
};

/**
 * Normalise a stored item regardless of which webhook version wrote it.
 *
 * Old webhook shape:  { quantity, description, amount_total }
 * New webhook shape:  { qty, name, slug, sku, price }
 *
 * cart_summary SKU fallback: "1x HEP-GIN-70" → look up in SKU_MAP
 */
function normaliseItem(it) {
  // Already new shape
  if (it.name && it.qty != null) return it;

  // Old shape — remap fields
  const qty   = it.qty   || it.quantity  || 1;
  const price = it.price != null ? it.price
              : it.amount_total != null  ? +(it.amount_total / qty).toFixed(2)
              : 0;

  // Try to resolve name: description → SKU lookup
  let name = it.name || it.description || null;
  let slug = it.slug || '';
  let sku  = it.sku  || '';

  // If description looks like a SKU (e.g. "HEP-GIN-70"), look it up
  if (name && SKU_MAP[name]) {
    slug = slug || SKU_MAP[name].slug;
    name = SKU_MAP[name].name;
  }

  // Derive slug from name if still missing
  if (!slug && name) {
    slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  return { name: name || 'Unknown item', slug, sku, qty, price };
}

/**
 * Resolve a product name from whatever Stripe gives us.
 * Priority: product.name → product.metadata.name → SKU lookup → description → slug → fallback
 */
function resolveItemName(li) {
  const product = li.price && li.price.product;
  // Fully expanded product object
  if (product && typeof product === 'object') {
    if (product.name) return product.name;
    if (product.metadata && product.metadata.name) return product.metadata.name;
    // Try SKU lookup via metadata
    const sku = (product.metadata && product.metadata.sku) || '';
    if (sku && SKU_MAP[sku]) return SKU_MAP[sku].name;
    // Try slug lookup via metadata
    const slug = (product.metadata && product.metadata.slug) || '';
    if (slug) {
      const match = Object.values(SKU_MAP).find(p => p.slug === slug);
      if (match) return match.name;
    }
  }
  // Fall back to description (Stripe line item description mirrors product name in most setups)
  if (li.description) return li.description;
  // Last resort: try SKU lookup from price metadata
  const priceSku = (li.price && li.price.metadata && li.price.metadata.sku) || '';
  if (priceSku && SKU_MAP[priceSku]) return SKU_MAP[priceSku].name;
  return null; // caller will handle
}

function resolveItemSlug(li, resolvedName) {
  const product = li.price && li.price.product;
  if (product && typeof product === 'object') {
    if (product.metadata && product.metadata.slug) return product.metadata.slug;
  }
  // Derive slug from resolved name as a last resort
  if (resolvedName) return resolvedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return '';
}

function resolveItemSku(li) {
  const product = li.price && li.price.product;
  if (product && typeof product === 'object') {
    if (product.metadata && product.metadata.sku) return product.metadata.sku;
  }
  if (li.price && li.price.metadata && li.price.metadata.sku) return li.price.metadata.sku;
  return '';
}

function ok(res, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
}

function summarise(orders) {
  const fulfilled = orders.filter(o => o.fulfilled).length;
  const outstanding = orders.length - fulfilled;
  const outstandingValue = +orders
    .filter(o => !o.fulfilled)
    .reduce((s, o) => s + (Number(o.total) || 0), 0)
    .toFixed(2);
  return { total: orders.length, fulfilled, outstanding, outstandingValue };
}

function productLeaderboard(orders) {
  const map = new Map();
  orders.forEach(o => {
    (o.items || []).map(normaliseItem).forEach(it => {
      if (!it.name || it.name === 'Unknown item') return;
      const k = it.slug || it.name;
      const cur = map.get(k) || { slug: it.slug || '', name: it.name, sku: it.sku || '', units: 0, revenue: 0, orders: 0 };
      cur.units += it.qty || 1;
      cur.revenue += (it.qty || 1) * (it.price || 0);
      cur.orders += 1;
      map.set(k, cur);
    });
  });
  return [...map.values()]
    .map(p => ({ ...p, revenue: +p.revenue.toFixed(2) }))
    .sort((a, b) => b.units - a.units);
}

// Resolve a date range from the query: ?all=1 | ?from=YYYY-MM-DD&to=YYYY-MM-DD | ?days=N
// Bounds are half-open [from, to); `to` is pushed +1 day so the end date is inclusive.
function resolveRange(q) {
  q = q || {};
  if (q.all === '1' || q.all === 'true') return { from: null, to: null, days: null };
  if (q.from || q.to) {
    let to = null;
    if (q.to) { const d = new Date(q.to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); to = d.toISOString(); }
    return { from: q.from ? new Date(q.from + 'T00:00:00Z').toISOString() : null, to, days: null };
  }
  const days = Math.min(3650, Math.max(1, parseInt(q.days, 10) || 180));
  return { from: new Date(Date.now() - days * 86400000).toISOString(), to: null, days };
}

module.exports = async function handler(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  const windowDays = Math.min(730, Math.max(7, parseInt(req.query && req.query.days, 10) || 180));
  const range = resolveRange(req.query);
  const limit = Math.min(1000, Math.max(50, parseInt(req.query && req.query.limit, 10) || 500));

  // ---- SUPABASE ----
  // Items stored by the webhook already have full name/slug/sku — no resolution needed.
  if (SUPA_URL && SUPA_KEY) {
    try {
      const since = new Date(Date.now() - windowDays * DAY).toISOString();
      let url = `${SUPA_URL.replace(/\/$/, '')}/rest/v1/orders?select=*&order=created_at.desc&limit=${limit}`;
      if (range.from) url += `&created_at=gte.${range.from}`;
      if (range.to)   url += `&created_at=lt.${range.to}`;
      const r = await fetch(url, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
      });
      if (!r.ok) throw new Error('supabase ' + r.status);
      const rawOrders = await r.json();
      // Normalise item shape — handles both old and new webhook formats
      const orders = rawOrders.map(o => ({
        ...o,
        items: (o.items || []).map(normaliseItem),
      }));

      // Whole-history aggregates via Postgres RPCs — NOT limited by the
      // date window or row limit above. Falls back to windowed JS if absent.
      async function rpc(fn, body) {
        const r = await fetch(`${SUPA_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        return r.ok ? r.json() : null;
      }
      const [lb, custs] = await Promise.all([
        rpc('product_leaderboard', { from_date: range.from, to_date: range.to }),
        rpc('customer_summary', { min_orders: 1, from_date: range.from, to_date: range.to }),
      ]);

      return ok(res, {
        demo: false, source: 'supabase', windowDays, range,
        summary: summarise(orders),
        productLeaderboard: (lb && lb.length) ? lb : productLeaderboard(orders),
        customers: custs || null,
        orders,
      });
    } catch (err) {
      if (!STRIPE_KEY) {
        const fallback = demo.ordersForWindow(windowDays);
        return ok(res, { demo: true, source: 'demo', error: 'supabase_unavailable',
          windowDays, summary: summarise(fallback),
          productLeaderboard: productLeaderboard(fallback), orders: fallback });
      }
    }
  }

  // ---- STRIPE ----
  if (STRIPE_KEY) {
    try {
      const stripe = require('stripe')(STRIPE_KEY);
      const since = Math.floor((Date.now() - windowDays * DAY) / 1000);
      const sessions = [];
      let starting_after;
      for (let i = 0; i < 20; i++) {
        const page = await stripe.checkout.sessions.list({
          created: { gte: since }, limit: 100,
          // Expand line_items AND the nested price.product so we get full product metadata
          expand: ['data.line_items', 'data.line_items.data.price.product'],
          ...(starting_after ? { starting_after } : {}),
        });
        sessions.push(...page.data);
        if (!page.has_more) break;
        starting_after = page.data[page.data.length - 1].id;
      }
      const orders = sessions
        .filter(s => s.payment_status === 'paid')
        .map(s => {
          const lineItems = (s.line_items && s.line_items.data) || [];
          const items = lineItems
            .map(li => {
              const name = resolveItemName(li);
              if (!name) return null; // drop completely unresolvable items
              const slug = resolveItemSlug(li, name);
              const sku  = resolveItemSku(li);
              return {
                slug,
                name,
                sku,
                qty:   li.quantity || 1,
                price: (li.price && li.price.unit_amount || 0) / 100,
              };
            })
            .filter(Boolean); // remove nulls

          return {
            stripe_session_id:  s.id,
            customer_email:     s.customer_details && s.customer_details.email  || null,
            customer_name:      s.customer_details && s.customer_details.name   || null,
            shipping_address:   (s.shipping_details && s.shipping_details.address)
                                || (s.customer_details && s.customer_details.address)
                                || null,
            currency:           s.currency || 'gbp',
            total:              (s.amount_total    || 0) / 100,
            subtotal:           (s.amount_subtotal || 0) / 100,
            shipping:           ((s.amount_total || 0) - (s.amount_subtotal || 0)) / 100,
            item_count:         items.reduce((acc, i) => acc + i.qty, 0) || null,
            items,
            cart_summary:       s.metadata && s.metadata.cart
                                  || items.map(i => `${i.qty}× ${i.name}`).join(', '),
            payment_status:     s.payment_status,
            fulfilled:          false,
            fulfilled_at:       null,
            created_at:         new Date(s.created * 1000).toISOString(),
          };
        });
      return ok(res, {
        demo: false, source: 'stripe', windowDays,
        note: 'Connect Supabase to track fulfilment status.',
        summary: summarise(orders),
        productLeaderboard: productLeaderboard(orders),
        orders,
      });
    } catch (err) {
      const fallback = demo.ordersForWindow(windowDays);
      return ok(res, { demo: true, source: 'demo', error: 'stripe_unavailable',
        windowDays, summary: summarise(fallback),
        productLeaderboard: productLeaderboard(fallback), orders: fallback });
    }
  }

  // ---- DEMO ----
  const fallback = demo.ordersForWindow(windowDays);
  return ok(res, { demo: true, source: 'demo', windowDays,
    summary: summarise(fallback), productLeaderboard: productLeaderboard(fallback), orders: fallback });
};
