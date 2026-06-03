// ============================================================
//  GET /api/analytics
//  Behavioural analytics from PostHog (traffic, funnel, paths,
//  sources, abandoned carts, conversion rate).
//  DEMO mode when PostHog env vars are absent.
//
//  Live mode uses the PostHog Query API (HogQL):
//    POST {host}/api/projects/{id}/query
//    Authorization: Bearer <personal api key>
//  Env: POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID,
//       POSTHOG_HOST (default https://eu.i.posthog.com)
// ============================================================

const demo = require('./_demo');

function send(res, code, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).json(body);
}

async function hogql(host, projectId, key, query) {
  const r = await fetch(`${host.replace(/\/$/, '')}/api/projects/${projectId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`PostHog ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.results || [];
}

module.exports = async function handler(req, res) {
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  const PID = process.env.POSTHOG_PROJECT_ID;
  const HOST = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';

  // ---- DEMO MODE -------------------------------------------
  if (!KEY || !PID) {
    return send(res, 200, { demo: true, source: 'demo', ...demo.analytics() });
  }

  // ---- LIVE MODE -------------------------------------------
  try {
    const WINDOW = "timestamp > now() - INTERVAL 30 DAY";

    // Funnel step counts (unique persons per event)
    const funnelRows = await hogql(HOST, PID, KEY, `
      SELECT event, count(DISTINCT person_id) AS people
      FROM events
      WHERE ${WINDOW}
        AND event IN ('$pageview','product_viewed','product_added_to_cart','checkout_started','purchase')
      GROUP BY event
    `);
    const fmap = {};
    funnelRows.forEach(r => { fmap[r[0]] = Number(r[1]) || 0; });
    const funnel = [
      { step: 'Visited site',     count: fmap['$pageview'] || 0 },
      { step: 'Viewed product',   count: fmap['product_viewed'] || 0 },
      { step: 'Added to cart',    count: fmap['product_added_to_cart'] || 0 },
      { step: 'Started checkout', count: fmap['checkout_started'] || 0 },
      { step: 'Purchased',        count: fmap['purchase'] || 0 },
    ];

    // Pageviews + unique visitors
    const pvRows = await hogql(HOST, PID, KEY, `
      SELECT count() AS pv, count(DISTINCT person_id) AS uv
      FROM events
      WHERE ${WINDOW} AND event = '$pageview'
    `);
    const pageviews = Number(pvRows[0] && pvRows[0][0]) || 0;
    const uniqueVisitors = Number(pvRows[0] && pvRows[0][1]) || 0;

    // Top pages
    const pageRows = await hogql(HOST, PID, KEY, `
      SELECT properties.$pathname AS path, count() AS views
      FROM events
      WHERE ${WINDOW} AND event = '$pageview'
      GROUP BY path ORDER BY views DESC LIMIT 8
    `);
    const topPages = pageRows.map(r => ({ path: r[0] || '/', views: Number(r[1]) || 0 }));

    // Traffic sources
    const srcRows = await hogql(HOST, PID, KEY, `
      SELECT coalesce(properties.$referring_domain, 'direct') AS src, count(DISTINCT person_id) AS people
      FROM events
      WHERE ${WINDOW} AND event = '$pageview'
      GROUP BY src ORDER BY people DESC LIMIT 6
    `);
    const sources = srcRows.map(r => ({ source: r[0] || 'direct', visitors: Number(r[1]) || 0 }));

    const started = fmap['checkout_started'] || 0;
    const purchased = fmap['purchase'] || 0;
    const abandonedCarts = Math.max(started - purchased, 0);
    const conversionRate = uniqueVisitors ? +(purchased / uniqueVisitors * 100).toFixed(2) : 0;

    return send(res, 200, {
      demo: false,
      source: 'posthog',
      pageviews,
      uniqueVisitors,
      conversionRate,
      funnel,
      topPages,
      sources,
      abandonedCarts,
      abandonedValue: null, // requires joining cart value; shown from orders/demo
    });
  } catch (err) {
    // Degrade gracefully to demo so the dashboard still renders
    return send(res, 200, {
      demo: true,
      source: 'demo',
      error: String(err && err.message || err),
      ...demo.analytics(),
    });
  }
};
