// ============================================================
//  GET /api/metrics
//  Revenue, net, orders, customers, AOV, units, daily series,
//  per-product split. Source of truth: STRIPE. Falls back to
//  deterministic DEMO data when STRIPE_SECRET_KEY is absent.
// ============================================================
const demo = require('./_demo');

const DAY = 86400000;
const WINDOW_DAYS = 90;

function ok(res, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
}

module.exports = async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;

  // ---- DEMO MODE ------------------------------------------
  if (!key) {
    return ok(res, { demo: true, source: 'demo', ...demo.metrics() });
  }

  // ---- LIVE (Stripe) --------------------------------------
  try {
    const stripe = require('stripe')(key);
    const since = Math.floor((Date.now() - WINDOW_DAYS * DAY) / 1000);

    // Page through charges in the window, expanding the balance
    // transaction so we get Stripe fees → true net.
    const charges = [];
    let starting_after;
    for (let i = 0; i < 20; i++) { // safety cap: 20 pages × 100 = 2000 charges
      const page = await stripe.charges.list({
        created: { gte: since },
        limit: 100,
        ...(starting_after ? { starting_after } : {}),
        expand: ['data.balance_transaction'],
      });
      charges.push(...page.data);
      if (!page.has_more) break;
      starting_after = page.data[page.data.length - 1].id;
    }

    const paid = charges.filter(c => c.paid && c.status === 'succeeded');

    let gross = 0, net = 0, refunded = 0;
    const customers = new Set();
    const dayMap = new Map();
    const productUnits = new Map();
    const productRevenue = new Map();

    paid.forEach(c => {
      const amt = (c.amount || 0) / 100;
      const ref = (c.amount_refunded || 0) / 100;
      gross += amt;
      refunded += ref;
      const bt = c.balance_transaction;
      if (bt && typeof bt === 'object') net += (bt.net || 0) / 100;
      else net += amt - ref;

      const who = c.customer || c.billing_details?.email || c.receipt_email;
      if (who) customers.add(who);

      const key = new Date(c.created * 1000).toISOString().slice(0, 10);
      const cur = dayMap.get(key) || { revenue: 0, orders: 0 };
      cur.revenue += amt; cur.orders += 1;
      dayMap.set(key, cur);
    });

    const orders = paid.length;
    const revenue = +(gross - refunded).toFixed(2);

    // Build a continuous 30-day daily series.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const k = new Date(today.getTime() - i * DAY).toISOString().slice(0, 10);
      const d = dayMap.get(k) || { revenue: 0, orders: 0 };
      daily.push({ date: k, revenue: +d.revenue.toFixed(2), orders: d.orders });
    }

    return ok(res, {
      demo: false,
      source: 'stripe',
      revenue,
      net: +net.toFixed(2),
      refunded: +refunded.toFixed(2),
      orders,
      customers: customers.size,
      aov: orders ? +(revenue / orders).toFixed(2) : 0,
      currency: (paid[0]?.currency || 'gbp'),
      daily,
      byProduct: [], // product split needs line items; portal shows from orders endpoint
    });
  } catch (err) {
    // Never leave the dashboard blank — degrade to demo with a flag.
    return ok(res, {
      demo: true,
      source: 'demo',
      error: 'stripe_unavailable',
      message: String(err && err.message || err),
      ...demo.metrics(),
    });
  }
};
