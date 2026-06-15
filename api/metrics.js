// ============================================================
//  GET /api/metrics
//  Revenue, orders, customers, AOV, units, daily + monthly
//  series. Source: SUPABASE orders table — so it includes BOTH
//  Stripe orders (via the webhook) AND imported Shopify history.
//  All-time revenue therefore uses your Shopify takings as the base.
//
//  Range: ?all=1  |  ?from=YYYY-MM-DD&to=YYYY-MM-DD  |  ?days=N
//  (the 30-day daily sparkline is always the rolling last 30 days)
//  Falls back to DEMO when Supabase env vars are absent.
// ============================================================
const demo = require('./_demo');

const DAY = 86400000;

function ok(res, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
}

// ?all=1 | ?from=&to= | ?days=N  → { from, to, days }
function resolveRange(q) {
  q = q || {};
  if (q.all === '1' || q.all === 'true') return { from: null, to: null, days: null };
  if (q.from || q.to) {
    let to = null;
    if (q.to) { const d = new Date(q.to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); to = d.toISOString(); }
    return { from: q.from ? new Date(q.from + 'T00:00:00Z').toISOString() : null, to, days: null };
  }
  const days = Math.min(3650, Math.max(1, parseInt(q.days, 10) || 90));
  return { from: new Date(Date.now() - days * DAY).toISOString(), to: null, days };
}

module.exports = async function handler(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const range = resolveRange(req.query);

  if (!SUPA_URL || !SUPA_KEY) {
    return ok(res, { demo: true, source: 'demo', range, ...demo.metrics(90) });
  }

  async function rpc(fn, body) {
    const r = await fetch(`${SUPA_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(`rpc ${fn} ${r.status}`);
    return r.json();
  }

  try {
    const bounds = { from_date: range.from, to_date: range.to };
    const since30 = new Date(Date.now() - 30 * DAY).toISOString();

    const [mRows, monthlyRows, dailyRows] = await Promise.all([
      rpc('revenue_metrics', bounds),
      rpc('revenue_by_month', bounds),
      rpc('revenue_by_day', { from_date: since30, to_date: null }),  // sparkline = rolling 30d
    ]);

    const m = (mRows && mRows[0]) || {};

    // Continuous 30-day daily series (fill gaps with zero)
    const dayMap = {};
    (dailyRows || []).forEach(d => { dayMap[d.day] = d; });
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const k = new Date(today.getTime() - i * DAY).toISOString().slice(0, 10);
      const d = dayMap[k];
      daily.push({ date: k, revenue: d ? +d.revenue : 0, orders: d ? +d.orders : 0 });
    }

    const revenue = +(m.revenue || 0);
    const orders = +(m.orders || 0);

    return ok(res, {
      demo: false, source: 'supabase', range,
      revenue, orders,
      customers: +(m.customers || 0),
      aov: +(m.aov || 0),
      units: +(m.units || 0),
      net: revenue,            // cross-source: fees aren't tracked for Shopify, so net == gross
      firstOrder: m.first_order || null,
      lastOrder: m.last_order || null,
      currency: 'gbp',
      daily,
      monthly: (monthlyRows || []).map(r => ({ month: r.month, revenue: +r.revenue, orders: +r.orders })),
      byProduct: [],
    });
  } catch (err) {
    console.error('[metrics] supabase error:', err && err.message);
    return ok(res, {
      demo: false, source: 'supabase_error', range,
      error: String(err && err.message || err),
      revenue: 0, orders: 0, customers: 0, aov: 0, units: 0, net: 0,
      currency: 'gbp', daily: [], monthly: [], byProduct: [],
    });
  }
};
