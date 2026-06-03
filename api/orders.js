// ============================================================
//  GET /api/orders
//  Returns orders with fulfilment status + summary counts.
//  Priority: SUPABASE → STRIPE → DEMO
//  Query: ?days=N (default 180, max 730), ?limit=N (default 500)
// ============================================================
const demo = require('./_demo');

const DAY = 86400000;

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
    (o.items || []).forEach(it => {
      const k = it.slug || it.name;
      const cur = map.get(k) || { slug: it.slug, name: it.name, sku: it.sku || '', units: 0, revenue: 0, orders: 0 };
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

module.exports = async function handler(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  const windowDays = Math.min(730, Math.max(7, parseInt(req.query && req.query.days, 10) || 180));
  const limit = Math.min(1000, Math.max(50, parseInt(req.query && req.query.limit, 10) || 500));

  // ---- SUPABASE ----
  if (SUPA_URL && SUPA_KEY) {
    try {
      const since = new Date(Date.now() - windowDays * DAY).toISOString();
      const url = `${SUPA_URL.replace(/\/$/, '')}/rest/v1/orders?select=*&order=created_at.desc&limit=${limit}&created_at=gte.${since}`;
      const r = await fetch(url, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
      });
      if (!r.ok) throw new Error('supabase ' + r.status);
      const orders = await r.json();
      return ok(res, {
        demo: false, source: 'supabase', windowDays,
        summary: summarise(orders),
        productLeaderboard: productLeaderboard(orders),
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
          expand: ['data.line_items'],
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
          const items = lineItems.map(li => ({
            slug: li.price?.product?.metadata?.slug || li.description || '',
            name: li.description || '',
            sku: li.price?.product?.metadata?.sku || '',
            qty: li.quantity || 1,
            price: (li.price?.unit_amount || 0) / 100,
          }));
          return {
            stripe_session_id: s.id,
            customer_email: s.customer_details?.email || null,
            customer_name: s.customer_details?.name || null,
            shipping_address: s.shipping_details?.address || s.customer_details?.address || null,
            currency: s.currency || 'gbp',
            total: (s.amount_total || 0) / 100,
            subtotal: (s.amount_subtotal || 0) / 100,
            shipping: ((s.amount_total || 0) - (s.amount_subtotal || 0)) / 100,
            item_count: items.reduce((s, i) => s + i.qty, 0) || null,
            items,
            cart_summary: s.metadata?.cart || items.map(i => `${i.qty}× ${i.name}`).join(', '),
            payment_status: s.payment_status,
            fulfilled: false,
            fulfilled_at: null,
            created_at: new Date(s.created * 1000).toISOString(),
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
