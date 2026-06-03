// ============================================================
//  PORTAL — shared DEMO data
//  When live env vars (Stripe / Supabase / PostHog) are absent,
//  every endpoint falls back to this module so the dashboard
//  renders a rich, internally-consistent picture. All figures
//  are deterministic (seeded) so reloads look stable.
// ============================================================

const PRODUCTS = [
  { slug: 'hepple-wild-juniper-gin', name: 'Hepple Wild Juniper Gin', price: 39.95, sku: 'HEP-GIN-70' },
  { slug: 'hepple-douglas-fir-vodka', name: 'Hepple Douglas Fir Vodka', price: 39.95, sku: 'HEP-DFV-70' },
  { slug: 'hepple-moorland-vodka',   name: 'Hepple Wheat Vodka',       price: 34.95, sku: 'HEP-WHV-70' },
];

// Tiny seeded PRNG (mulberry32) — deterministic demo numbers.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Imogen','Callum','Fiona','Hamish','Niamh','Rory','Eilidh','Struan','Catriona','Angus',
  'Mairi','Douglas','Isla','Fraser','Skye','Lachlan','Bonnie','Ewan','Greer','Murray',
  'Heather','Finlay','Ailsa','Gregor','Iona','Duncan','Morag','Blair','Senga','Tavish'];
const LAST = ['MacLeod','Fraser','Sinclair','Buchanan','Ferguson','Campbell','Hepburn','Armstrong',
  'Kerr','Cunningham','Robertson','Galbraith','Wallace','Murray','Forsyth','Drummond','Crawford',
  'Bruce','Aitken','Lindsay','Maxwell','Tennant','Ogilvie','Rennie'];

function pad(n) { return n < 10 ? '0' + n : '' + n; }

// Build a deterministic set of ~140 orders across the last 90 days.
function buildOrders() {
  const rand = rng(20260518);
  const orders = [];
  const now = Date.now();
  const DAY = 86400000;
  const total = 142;

  for (let i = 0; i < total; i++) {
    // Weight orders toward recent days, with weekend lifts.
    const daysAgo = Math.floor(Math.pow(rand(), 1.6) * 90);
    const d = new Date(now - daysAgo * DAY);
    const dow = d.getDay();
    if ((dow === 0 || dow === 6) && rand() < 0.35) continue; // light weekend trim

    // 1–3 line items.
    const lineCount = 1 + (rand() < 0.55 ? 0 : rand() < 0.85 ? 1 : 2);
    const items = [];
    let subtotal = 0;
    const chosen = new Set();
    for (let j = 0; j < lineCount; j++) {
      const p = PRODUCTS[Math.floor(rand() * PRODUCTS.length)];
      if (chosen.has(p.slug)) continue;
      chosen.add(p.slug);
      const qty = 1 + (rand() < 0.78 ? 0 : rand() < 0.95 ? 1 : 2);
      items.push({ slug: p.slug, name: p.name, sku: p.sku, qty, price: p.price });
      subtotal += p.price * qty;
    }
    if (!items.length) continue;

    const shipping = subtotal >= 45 ? 0 : 4.95;
    const totalAmt = +(subtotal + shipping).toFixed(2);
    const fn = FIRST[Math.floor(rand() * FIRST.length)];
    const ln = LAST[Math.floor(rand() * LAST.length)];
    const email = `${fn}.${ln}`.toLowerCase() + '@' + (rand() < 0.5 ? 'gmail.com' : rand() < 0.7 ? 'outlook.com' : 'btinternet.com');

    // Older orders mostly fulfilled; recent ones often outstanding.
    const fulfilled = daysAgo > 4 ? rand() < 0.93 : rand() < 0.25;

    orders.push({
      id: i + 1,
      stripe_session_id: 'cs_demo_' + (100000 + i),
      stripe_payment_intent: 'pi_demo_' + (100000 + i),
      customer_email: email,
      customer_name: `${fn} ${ln}`,
      currency: 'gbp',
      subtotal: +subtotal.toFixed(2),
      shipping,
      total: totalAmt,
      item_count: items.reduce((s, it) => s + it.qty, 0),
      items,
      cart_summary: items.map(it => `${it.qty}x ${it.sku}`).join(', '),
      shipping_address: {
        line1: (1 + Math.floor(rand() * 80)) + ' ' + ['High St','Mill Wynd','Castle Row','Harbour Rd','Glebe Pl'][Math.floor(rand() * 5)],
        city: ['Edinburgh','Glasgow','Morpeth','Hexham','Newcastle','Berwick','Alnwick'][Math.floor(rand() * 7)],
        postal_code: ['EH1','G1','NE61','NE46','NE1','TD15','NE66'][Math.floor(rand() * 7)] + ' ' + (1 + Math.floor(rand() * 9)) + 'AA',
        country: 'GB',
      },
      payment_status: 'paid',
      fulfilled,
      fulfilled_at: fulfilled ? new Date(d.getTime() + (1 + Math.floor(rand() * 3)) * DAY).toISOString() : null,
      created_at: d.toISOString(),
    });
  }

  orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return orders;
}

const ORDERS = buildOrders();

// ---- Derived metrics (kept consistent with ORDERS) ---------
function metrics() {
  const revenue = ORDERS.reduce((s, o) => s + o.total, 0);
  const customers = new Set(ORDERS.map(o => o.customer_email)).size;
  const orderCount = ORDERS.length;
  const aov = orderCount ? revenue / orderCount : 0;
  const units = ORDERS.reduce((s, o) => s + o.item_count, 0);

  // Daily revenue series for the last 30 days.
  const DAY = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(today.getTime() - i * DAY);
    const key = day.toISOString().slice(0, 10);
    const dayRev = ORDERS
      .filter(o => o.created_at.slice(0, 10) === key)
      .reduce((s, o) => s + o.total, 0);
    const dayOrders = ORDERS.filter(o => o.created_at.slice(0, 10) === key).length;
    days.push({ date: key, revenue: +dayRev.toFixed(2), orders: dayOrders });
  }

  // Per-product unit + revenue split.
  const byProduct = PRODUCTS.map(p => {
    let u = 0, r = 0;
    ORDERS.forEach(o => o.items.forEach(it => {
      if (it.slug === p.slug) { u += it.qty; r += it.qty * it.price; }
    }));
    return { slug: p.slug, name: p.name, units: u, revenue: +r.toFixed(2) };
  }).sort((a, b) => b.revenue - a.revenue);

  return {
    revenue: +revenue.toFixed(2),
    net: +(revenue * 0.971 - orderCount * 0.20).toFixed(2), // approx after Stripe fees (1.5%+20p UK cards, blended)
    orders: orderCount,
    customers,
    aov: +aov.toFixed(2),
    units,
    currency: 'gbp',
    daily: days,
    byProduct,
  };
}

// ---- Top customers -----------------------------------------
function topCustomers() {
  const map = new Map();
  ORDERS.forEach(o => {
    const k = o.customer_email;
    const cur = map.get(k) || { email: k, name: o.customer_name, orders: 0, spent: 0, last: o.created_at };
    cur.orders += 1;
    cur.spent += o.total;
    if (o.created_at > cur.last) cur.last = o.created_at;
    map.set(k, cur);
  });
  return [...map.values()]
    .map(c => ({ ...c, spent: +c.spent.toFixed(2) }))
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 8);
}

// ---- PostHog-style analytics -------------------------------
function analytics() {
  const m = metrics();
  const purchases = m.orders;
  // Funnel sized to be internally plausible vs. orders.
  const pageviews = Math.round(purchases * 47);
  const productViews = Math.round(purchases * 19);
  const addToCart = Math.round(purchases * 4.3);
  const checkoutStarted = Math.round(purchases * 1.9);

  const funnel = [
    { step: 'Visited site', count: Math.round(purchases * 31) },
    { step: 'Viewed product', count: productViews },
    { step: 'Added to cart', count: addToCart },
    { step: 'Started checkout', count: checkoutStarted },
    { step: 'Purchased', count: purchases },
  ];

  const topPages = [
    { path: '/', views: Math.round(pageviews * 0.34) },
    { path: '/shop', views: Math.round(pageviews * 0.21) },
    { path: '/shop/hepple-wild-juniper-gin', views: Math.round(pageviews * 0.13) },
    { path: '/story', views: Math.round(pageviews * 0.10) },
    { path: '/shop/hepple-douglas-fir-vodka', views: Math.round(pageviews * 0.08) },
    { path: '/cocktails', views: Math.round(pageviews * 0.07) },
    { path: '/visit', views: Math.round(pageviews * 0.04) },
  ];

  const sources = [
    { source: 'Direct', sessions: Math.round(pageviews * 0.30 / 6) },
    { source: 'Instagram', sessions: Math.round(pageviews * 0.26 / 6) },
    { source: 'Google', sessions: Math.round(pageviews * 0.22 / 6) },
    { source: 'Newsletter', sessions: Math.round(pageviews * 0.12 / 6) },
    { source: 'Referral', sessions: Math.round(pageviews * 0.10 / 6) },
  ];

  const abandonedCarts = addToCart - purchases;
  const abandonedValue = +(abandonedCarts * 41.6).toFixed(2);

  return {
    pageviews,
    uniqueVisitors: Math.round(pageviews / 4.2),
    productViews,
    addToCart,
    checkoutStarted,
    purchases,
    conversionRate: +((purchases / Math.round(purchases * 31)) * 100).toFixed(2),
    abandonedCarts,
    abandonedValue,
    funnel,
    topPages,
    sources,
  };
}

module.exports = { PRODUCTS, ORDERS, metrics, topCustomers, analytics };
