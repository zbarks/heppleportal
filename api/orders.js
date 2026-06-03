// ============================================================
//  GET /api/orders
//  Returns orders with fulfilment status + summary counts.
//  Priority: SUPABASE (has fulfilment) → STRIPE (read-only,
//  fulfilled=false) → DEMO.
// ============================================================
const demo = require('./_demo');

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

module.exports = async function handler(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

  // ---- SUPABASE (preferred — carries fulfilment state) ----
  if (SUPA_URL && SUPA_KEY) {
    try {
      const url = `${SUPA_URL.replace(/\/$/, '')}/rest/v1/orders?select=*&order=created_at.desc&limit=500`;
      const r = await fetch(url, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
      });
      if (!r.ok) throw new Error('supabase ' + r.status);
      const orders = await r.json();
      return ok(res, { demo: false, source: 'supabase', summary: summarise(orders), orders });
    } catch (err) {
      // fall through to Stripe / demo
      if (!STRIPE_KEY) {
        return ok(res, { demo: true, source: 'demo', error: 'supabase_unavailable',
          message: String(err && err.message || err),
          summary: summarise(demo.ORDERS), orders: demo.ORDERS });
      }
    }
  }

  // ---- STRIPE (read-only mirror; no persisted fulfilment) -
  if (STRIPE_KEY) {
    try {
      const stripe = require('stripe')(STRIPE_KEY);
      const since = Math.floor((Date.now() - 90 * 86400000) / 1000);
      const sessions = [];
      let starting_after;
      for (let i = 0; i < 10; i++) {
        const page = await stripe.checkout.sessions.list({
          created: { gte: since }, limit: 100,
          ...(starting_after ? { starting_after } : {}),
        });
        sessions.push(...page.data);
        if (!page.has_more) break;
        starting_after = page.data[page.data.length - 1].id;
      }
      const orders = sessions
        .filter(s => s.payment_status === 'paid')
        .map(s => ({
          stripe_session_id: s.id,
          customer_email: s.customer_details?.email || null,
          customer_name: s.customer_details?.name || null,
          currency: s.currency || 'gbp',
          total: (s.amount_total || 0) / 100,
          subtotal: (s.amount_subtotal || 0) / 100,
          item_count: null,
          cart_summary: s.metadata?.cart || '',
          payment_status: s.payment_status,
          fulfilled: false, // Stripe alone can't track fulfilment — add Supabase for that
          fulfilled_at: null,
          created_at: new Date(s.created * 1000).toISOString(),
          items: [],
        }));
      return ok(res, {
        demo: false, source: 'stripe',
        note: 'Connect Supabase to persist fulfilment status.',
        summary: summarise(orders), orders,
      });
    } catch (err) {
      return ok(res, { demo: true, source: 'demo', error: 'stripe_unavailable',
        message: String(err && err.message || err),
        summary: summarise(demo.ORDERS), orders: demo.ORDERS });
    }
  }

  // ---- DEMO ------------------------------------------------
  return ok(res, { demo: true, source: 'demo', summary: summarise(demo.ORDERS), orders: demo.ORDERS });
};
