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
//  Period comparison, same shape as the PostHog weekly digest:
//  the last D days against the D days before. Each value is
//  { cur, prev } so the portal can show the change.
// ------------------------------------------------------------
const ALLOWED_DAYS = [7, 30, 90, 180, 365];

async function comparison(host, pid, key, D) {
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
      GROUP BY path HAVING cur > 0 ORDER BY cur DESC LIMIT 10
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

function pickDays(req) {
  const d = parseInt((req.query || {}).days, 10);
  return ALLOWED_DAYS.indexOf(d) === -1 ? 30 : d;
}

module.exports = async function handler(req, res) {
  const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
  const PID = process.env.POSTHOG_PROJECT_ID;
  // Default to US cloud (corrected from EU)
  const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

  if (!KEY || !PID) {
    return send(res, 200, { demo: true, source: 'demo', ...demo.analytics(pickDays(req)) });
  }

  try {
    const q = req.query || {};
    let D = parseInt(q.days, 10);
    if (ALLOWED_DAYS.indexOf(D) === -1) D = 30;
    const WINDOW = `timestamp > now() - INTERVAL ${D} DAY`;

    const funnelRows = await hogql(HOST, PID, KEY, `
      SELECT event, count(DISTINCT person_id) AS people
      FROM events
      WHERE ${WINDOW}
        AND event IN ('$pageview','product_viewed','product_added_to_cart','checkout_started','purchase')
      GROUP BY event
    `);
    const fmap = {};
    funnelRows.forEach(r => { fmap[r[0]] = Number(r[1]) || 0; });

    // Previous period of the same length, for conversion and abandoned carts.
    let pmap = null;
    try {
      const prevRows = await hogql(HOST, PID, KEY, `
        SELECT event, count(DISTINCT person_id) AS people
        FROM events
        WHERE timestamp > now() - INTERVAL ${D * 2} DAY AND timestamp <= now() - INTERVAL ${D} DAY
          AND event IN ('$pageview','checkout_started','purchase')
        GROUP BY event
      `);
      pmap = {};
      prevRows.forEach(r => { pmap[r[0]] = Number(r[1]) || 0; });
    } catch (e) { pmap = null; }
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

    // Visitors over time: daily up to 3 months, weekly beyond that.
    const bucket = D > 90 ? 'toStartOfWeek(timestamp)' : 'toDate(timestamp)';
    const dailyRows = await hogql(HOST, PID, KEY, `
      SELECT ${bucket} AS day, count(DISTINCT person_id) AS uv
      FROM events WHERE ${WINDOW} AND event = '$pageview'
      GROUP BY day ORDER BY day ASC
    `);
    const dailyVisitors = dailyRows.map(r => ({ date: String(r[0]).slice(0, 10), visitors: Number(r[1]) || 0 }));

    const started = fmap['checkout_started'] || 0;
    const purchased = fmap['purchase'] || 0;
    const abandonedCarts = Math.max(started - purchased, 0);
    const conversionRate = uniqueVisitors ? +(purchased / uniqueVisitors * 100).toFixed(2) : 0;

    let prev = null;
    if (pmap) {
      const pv = pmap['$pageview'] || 0, ps = pmap['checkout_started'] || 0, pp = pmap['purchase'] || 0;
      prev = {
        conversionRate: pv ? +(pp / pv * 100).toFixed(2) : 0,
        abandonedCarts: Math.max(ps - pp, 0),
        purchases: pp,
      };
    }

    // A failure here should not take the rest of the page down.
    let compare = null;
    try { compare = await comparison(HOST, PID, KEY, D); } catch (e) { compare = null; }

    return send(res, 200, {
      demo: false, source: 'posthog',
      days: D,
      compare, prev, purchases: purchased,
      pageviews, uniqueVisitors, conversionRate,
      funnel, topPages, sources, dailyVisitors,
      abandonedCarts, abandonedValue: null,
    });
  } catch (err) {
    return send(res, 200, {
      demo: true, source: 'demo',
      error: String(err && err.message || err),
      ...demo.analytics(pickDays(req)),
    });
  }
};
