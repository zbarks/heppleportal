// =============================================================
//  POST /api/stripe-webhook
//  Stripe calls this when a checkout completes. We:
//    1. verify the signature (raw body required)
//    2. write the order into Supabase  (table: orders)
//    3. fire a server-side PostHog "order_completed" event
//
//  Point Stripe at:  https://<your-domain>/api/stripe-webhook
//  Listen for event: checkout.session.completed   (and async variants)
//
//  Env vars:
//    STRIPE_SECRET_KEY
//    STRIPE_WEBHOOK_SECRET       whsec_...   (from the Stripe webhook dashboard)
//    SUPABASE_URL                (optional)  https://xxxx.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY   (optional)  service role — server only, NEVER client
//    POSTHOG_API_KEY             (optional)  phc_...  (project API key)
//    POSTHOG_HOST                (optional)  https://eu.i.posthog.com  (default)
//  Designed by Barker Digital
// =============================================================

// Vercel must NOT pre-parse the body or the signature check fails.
module.exports.config = { api: { bodyParser: false } };

// Product catalogue — maps SKU / slug from Stripe metadata to a clean name.
// Add new products here as they're created in Stripe.
const SKU_MAP = {
  'HEP-GIN-70':  { slug: 'hepple-wild-juniper-gin',  name: 'Hepple Wild Juniper Gin'  },
  'HEP-DFV-70':  { slug: 'hepple-douglas-fir-vodka', name: 'Hepple Douglas Fir Vodka' },
  'HEP-WHV-70':  { slug: 'hepple-moorland-vodka',    name: 'Hepple Wheat Vodka'       },
};

function resolveLineItem(l) {
  const product = l.price && l.price.product;
  // Try to get clean name from fully expanded product object
  let name = null;
  let slug = '';
  let sku  = '';

  if (product && typeof product === 'object') {
    name = product.name || (product.metadata && product.metadata.name) || null;
    slug = (product.metadata && product.metadata.slug) || '';
    sku  = (product.metadata && product.metadata.sku)  || '';
  }

  // SKU lookup fallback
  if (!name && sku && SKU_MAP[sku]) {
    name = SKU_MAP[sku].name;
    slug = slug || SKU_MAP[sku].slug;
  }

  // Fall back to Stripe description (usually mirrors product name)
  if (!name) name = l.description || null;

  // Derive slug from name if still missing
  if (!slug && name) {
    slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  return {
    name:  name || 'Unknown item',
    slug,
    sku,
    qty:   l.quantity || 1,
    price: (l.price && l.price.unit_amount || 0) / 100,
  };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function recordToSupabase(order) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { skipped: 'supabase-not-configured' };
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/orders?on_conflict=stripe_session_id`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([order]),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Supabase insert failed ${resp.status}: ${txt}`);
  }
  return { ok: true };
}

async function capturePostHog(order) {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return { skipped: 'posthog-not-configured' };
  const host = (process.env.POSTHOG_HOST || 'https://eu.i.posthog.com').replace(/\/$/, '');
  const resp = await fetch(`${host}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      event: 'order_completed',
      distinct_id: order.posthog_distinct_id || order.customer_email || order.stripe_session_id,
      properties: {
        $insert_id:     order.stripe_session_id,
        revenue:        order.total,
        currency:       order.currency,
        item_count:     order.item_count,
        items:          order.items,
        order_id:       order.stripe_session_id,
        customer_email: order.customer_email,
        source:         'stripe-webhook',
      },
    }),
  });
  if (!resp.ok) throw new Error(`PostHog capture failed ${resp.status}`);
  return { ok: true };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method not allowed');
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key    = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) {
    return res.status(500).json({ error: 'Webhook not configured (missing Stripe secrets).' });
  }

  const stripe = require('stripe')(key);
  const raw    = await readRawBody(req);
  const sig    = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err && err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const s = event.data.object;

      // Fetch line items with full product expansion so we get name/slug/sku
      let items = [];
      try {
        const li = await stripe.checkout.sessions.listLineItems(s.id, {
          limit: 100,
          expand: ['data.price.product'],
        });
        items = li.data.map(resolveLineItem);
      } catch (_) { /* non-fatal — items will be empty array */ }

      // Build full shipping address — every field needed for dispatch
      const shippingAddr = (function () {
  var sd = (s.collected_information && s.collected_information.shipping_details)
    || (s.shipping_details && s.shipping_details.address ? { address: s.shipping_details.address, name: s.shipping_details.name } : null)
    || (s.shipping && s.shipping.address ? { address: s.shipping.address, name: s.shipping.name } : null);
  var address = (sd && sd.address) || (s.customer_details && s.customer_details.address) || null;
  if (!address) return null;
  var name = (sd && sd.name) || (s.customer_details && s.customer_details.name) || null;
  return name ? Object.assign({}, address, { name: name }) : address;
})();

      const order = {
        stripe_session_id:    s.id,
        stripe_payment_intent: s.payment_intent || null,
        customer_email:       (s.customer_details && s.customer_details.email) || s.customer_email || null,
        customer_name:        (s.customer_details && s.customer_details.name)  || null,
        currency:             (s.currency || 'gbp').toLowerCase(),
        total:                (s.amount_total    || 0) / 100,
        subtotal:             (s.amount_subtotal || 0) / 100,
        shipping:             ((s.total_details && s.total_details.amount_shipping) || 0) / 100,
        item_count:           items.reduce((acc, i) => acc + i.qty, 0)
                                || parseInt((s.metadata && s.metadata.item_count) || '0', 10),
        items,                // [{name, slug, sku, qty, price}]  — matches portal expectations
        cart_summary:         (s.metadata && s.metadata.cart)
                                || items.map(i => `${i.qty}× ${i.name}`).join(', ')
                                || null,
        posthog_distinct_id:  (s.metadata && s.metadata.ph_id) || null,
        shipping_address:     shippingAddr,  // {line1, line2, city, postal_code, country}
        payment_status:       s.payment_status || 'paid',
        fulfilled:            false,
        fulfilled_at:         null,
        created_at:           new Date((s.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      };

      const results = await Promise.allSettled([
        recordToSupabase(order),
        capturePostHog(order),
      ]);
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`[webhook] sink ${i} failed:`, r.reason && r.reason.message);
        }
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err && err.message);
    return res.status(200).json({ received: true, warning: 'handler error logged' });
  }
};
