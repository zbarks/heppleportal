// ============================================================
//  GET /api/analytics
//  Behavioural analytics from PostHog (traffic, funnel, paths,
//  sources). DEMO mode when PostHog env vars are absent.
//  Uses PostHog Query API (HogQL).
//  Env: POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID,
//       POSTHOG_HOST (default https://us.i.posthog.com)
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

// ------------------------------------------------------------
//  Weekly comparison, same shape as the PostHog weekly digest:
//  last 7 days against the 7 days before. Each value is
//  { cur, prev } so the portal can show the change.
// ------------------------------------------------------------
async function weekly(host, pid, key) {
  const D = 7;
  const ev = (cond) => `event = '$pageview' AND timestamp ${cond}`;
  const inCur = `> now() - INTERVAL ${D} DAY`;
  const inPrev = `<= now() - INTERVAL ${D} DAY`;
  const sCur = `$start_timestamp > now() - INTERVAL ${D} DAY`;
  const sPrev = `$start_timestamp <= now() - INTERVAL ${D} DAY`;
  const n = (v) => Number(v) || 0;

  const [ov, ses, pg] = await Promise.all([
    hogql(host, pid, key, `
      SELECT uniqIf(person_id, ${ev(inCur)}), uniqIf(person_id, ${ev(inPrev)}),
             countIf(${ev(inCur)}), countIf(${ev(inPrev)})
      FROM events WHERE timestamp > now() - INTERVAL ${D * 2} DAY
    `),
    hogql(host, pid, key, `
      SELECT countIf(${sCur}), countIf(${sPrev}),
             countIf($is_bounce AND ${sCur}), countIf($is_bounce AND ${sPrev}),
             avgIf($session_duration, ${sCur}), avgIf($session_duration, ${sPrev})
      FROM sessions WHERE $start_timestamp > now() - INTERVAL ${D * 2} DAY
    `),
    hogql(host, pid, key, `
      SELECT properties.$pathname AS path,
             uniqIf(person_id, ${ev(inCur)}) AS cur,
             uniqIf(person_id, ${ev(inPrev)}) AS prev
      FROM events
      WHERE event = '$pageview' AND timestamp > now() - INTERVAL ${D * 2} DAY
      GROUP BY path HAVING cur > 0 ORDER BY cur DESC LIMIT 8
    `),
  ]);

  const o = ov[0] || [], s = ses[0] || [];
  const rate = (b, t) => (t ? +((b / t) * 100).toFixed(1) : 0);
  return {
    days: D,
    visitors:    { cur: n(o[0]), prev: n(o[1]) },
    pageviews:   { cur: n(o[2]), prev: n(o[3]) },
    sessions:    { cur: n(s[0]), prev: n(s[1]) },
    bounceRate:  { cur: rate(n(s[2]), n(s[0])), prev: rate(n(s[3]), n(s[1])) },
    avgDuration: { cur: Math.round(n(s[4])), prev: Math.round(n(s[5])) },
    pages: pg.map((r) => ({ path: r[0] || '/', visitors: n(r[1]), prev: n(r[2]) })),
  };
}

module.exports = async function handler(req, res) {
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  const PID = process.env.POSTHOG_PROJECT_ID;
  // Default to US cloud (corrected from EU)
  const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

  if (!KEY || !PID) {
    return send(res, 200, { demo: true, source: 'demo', ...demo.analytics() });
  }

  try {
    const WINDOW = "timestamp > now() - INTERVAL 30 DAY";

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

    const pvRows = await hogql(HOST, PID, KEY, `
      SELECT count() AS pv, count(DISTINCT person_id) AS uv
      FROM events WHERE ${WINDOW} AND event = '$pageview'
    `);
    const pageviews = Number(pvRows[0] && pvRows[0][0]) || 0;
    const uniqueVisitors = Number(pvRows[0] && pvRows[0][1]) || 0;

    const pageRows = await hogql(HOST, PID, KEY, `
      SELECT properties.$pathname AS path, count() AS views
      FROM events WHERE ${WINDOW} AND event = '$pageview'
      GROUP BY path ORDER BY views DESC LIMIT 8
    `);
    const topPages = pageRows.map(r => ({ path: r[0] || '/', views: Number(r[1]) || 0 }));

    const srcRows = await hogql(HOST, PID, KEY, `
      SELECT coalesce(properties.$referring_domain, 'direct') AS src, count(DISTINCT person_id) AS people
      FROM events WHERE ${WINDOW} AND event = '$pageview'
      GROUP BY src ORDER BY people DESC LIMIT 6
    `);
    const sources = srcRows.map(r => ({ source: r[0] || 'direct', visitors: Number(r[1]) || 0 }));

    // Daily visitors for sparkline
    const dailyRows = await hogql(HOST, PID, KEY, `
      SELECT toDate(timestamp) AS day, count(DISTINCT person_id) AS uv
      FROM events WHERE timestamp > now() - INTERVAL 30 DAY AND event = '$pageview'
      GROUP BY day ORDER BY day ASC
    `);
    const dailyVisitors = dailyRows.map(r => ({ date: r[0], visitors: Number(r[1]) || 0 }));

    const started = fmap['checkout_started'] || 0;
    const purchased = fmap['purchase'] || 0;
    const abandonedCarts = Math.max(started - purchased, 0);
    const conversionRate = uniqueVisitors ? +(purchased / uniqueVisitors * 100).toFixed(2) : 0;

    // A failure here should not take the rest of the page down.
    let week = null;
    try { week = await weekly(HOST, PID, KEY); } catch (e) { week = null; }

    return send(res, 200, {
      demo: false, source: 'posthog',
      week,
      pageviews, uniqueVisitors, conversionRate,
      funnel, topPages, sources, dailyVisitors,
      abandonedCarts, abandonedValue: null,
    });
  } catch (err) {
    return send(res, 200, {
      demo: true, source: 'demo',
      error: String(err && err.message || err),
      ...demo.analytics(),
    });
  }
};
