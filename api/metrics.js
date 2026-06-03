// ============================================================
//  GET /api/metrics
//  Revenue, net, orders, customers, AOV, units, daily series,
//  per-product split. Source: STRIPE. Window: configurable via
//  ?days=N (default 90, max 730). Falls back to DEMO.
// ============================================================
const demo = require('./_demo');

const DAY = 86400000;

function ok(res, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
}

module.exports = async function handler(req, res) {
  const key = process.env.STRIPE_SECRET_KEY;
  const windowDays = Math.min(730, Math.max(7, parseInt(req.query && req.query.days, 10) || 90));

  if (!key) {
    return ok(res, { demo: true, source: 'demo', windowDays, ...demo.metrics(windowDays) });
  }

  try {
    const stripe = require('stripe')(key);
    const since = Math.floor((Date.now() - windowDays * DAY) / 1000);

    const charges = [];
    let starting_after;
    for (let i = 0; i < 20; i++) {
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
      const k = new Date(c.created * 1000).toISOString().slice(0, 10);
      const cur = dayMap.get(k) || { revenue: 0, orders: 0 };
      cur.revenue += amt; cur.orders += 1;
      dayMap.set(k, cur);
    });

    const orders = paid.length;
    const revenue = +(gross - refunded).toFixed(2);

    // Continuous daily series for last 30 days
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const k = new Date(today.getTime() - i * DAY).toISOString().slice(0, 10);
      const d = dayMap.get(k) || { revenue: 0, orders: 0 };
      daily.push({ date: k, revenue: +d.revenue.toFixed(2), orders: d.orders });
    }

    // Monthly series for longer view
    const monthly = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); d.setHours(0,0,0,0);
      const monthKey = d.toISOString().slice(0, 7);
      let rev = 0, ord = 0;
      dayMap.forEach((v, k) => { if (k.startsWith(monthKey)) { rev += v.revenue; ord += v.orders; } });
      monthly.push({ month: monthKey, revenue: +rev.toFixed(2), orders: ord });
    }

    return ok(res, {
      demo: false, source: 'stripe', windowDays,
      revenue, net: +net.toFixed(2), refunded: +refunded.toFixed(2),
      orders, customers: customers.size,
      aov: orders ? +(revenue / orders).toFixed(2) : 0,
      currency: (paid[0]?.currency || 'gbp'),
      daily, monthly,
      byProduct: [],
    });
  } catch (err) {
    return ok(res, {
      demo: true, source: 'demo', windowDays,
      error: String(err && err.message || err),
      ...demo.metrics(windowDays),
    });
  }
};
