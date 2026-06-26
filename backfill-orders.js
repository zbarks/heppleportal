// ============================================================
//  backfill-orders.js
//  Run ONCE with: node backfill-orders.js
//
//  Fetches every order from Stripe that already exists in
//  Supabase and updates the row with:
//    - items   in the new shape {name,slug,sku,qty,price}
//    - shipping_address from Stripe
//
//  Requires env vars (copy from your .env):
//    STRIPE_SECRET_KEY
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//
//  Safe to re-run — uses upsert so nothing gets duplicated.
//  Only updates rows where items is still in the old shape
//  (i.e. has "quantity" field instead of "qty").
// ============================================================

require('dotenv').config();

const STRIPE_KEY  = process.env.STRIPE_SECRET_KEY;
const SUPA_URL    = process.env.SUPABASE_URL;
const SUPA_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!STRIPE_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('Missing env vars. Make sure .env has STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const stripe = require('stripe')(STRIPE_KEY);

const SKU_MAP = {
  'HEP-GIN-70':  { slug: 'hepple-wild-juniper-gin',  name: 'Hepple Wild Juniper Gin'  },
  'HEP-DFV-70':  { slug: 'hepple-douglas-fir-vodka', name: 'Hepple Douglas Fir Vodka' },
  'HEP-WHV-70':  { slug: 'hepple-moorland-vodka',    name: 'Hepple Wheat Vodka'       },
};

function resolveLineItem(l) {
  const product = l.price && l.price.product;
  let name = null, slug = '', sku = '';

  if (product && typeof product === 'object') {
    name = product.name || (product.metadata && product.metadata.name) || null;
    slug = (product.metadata && product.metadata.slug) || '';
    sku  = (product.metadata && product.metadata.sku)  || '';
  }

  if (!name && sku && SKU_MAP[sku])  { name = SKU_MAP[sku].name; slug = slug || SKU_MAP[sku].slug; }
  if (!name && l.description)        { name = l.description; }

  // If description IS a SKU (e.g. old orders stored "HEP-GIN-70" as description)
  if (name && SKU_MAP[name]) { slug = slug || SKU_MAP[name].slug; sku = sku || name; name = SKU_MAP[name].name; }

  if (!slug && name) slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  return { name: name || 'Unknown item', slug, sku, qty: l.quantity || 1, price: (l.price && l.price.unit_amount || 0) / 100 };
}

async function supaFetch(path, opts = {}) {
  const r = await fetch(`${SUPA_URL.replace(/\/$/, '')}${path}`, {
    ...opts,
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Supabase ${r.status}: ${t}`); }
  return r.headers.get('content-type')?.includes('json') ? r.json() : null;
}

async function main() {
  console.log('Fetching all orders from Supabase...');
  const rows = await supaFetch('/rest/v1/orders?select=stripe_session_id,items,fulfilled&order=created_at.desc&limit=1000');
  console.log(`Found ${rows.length} orders in Supabase`);

  // Only backfill rows that are still in the old shape
  const needsBackfill = rows.filter(r => {
    const items = r.items || [];
    return items.length === 0 || items.some(it => it.quantity != null && it.qty == null);
  });

  console.log(`${needsBackfill.length} orders need backfilling`);
  if (!needsBackfill.length) { console.log('Nothing to do!'); return; }

  let ok = 0, fail = 0;

  for (const row of needsBackfill) {
    try {
      // Fetch from Stripe with full product expand
      const session = await stripe.checkout.sessions.retrieve(row.stripe_session_id, {
        expand: ['line_items', 'line_items.data.price.product'],
      });

      const lineItems = (session.line_items && session.line_items.data) || [];
      const items = lineItems.map(resolveLineItem);

      const shippingAddress = (function () {
  var sd = (session.collected_information && session.collected_information.shipping_details)
    || (session.shipping_details && session.shipping_details.address ? { address: session.shipping_details.address, name: session.shipping_details.name } : null)
    || (session.shipping && session.shipping.address ? { address: session.shipping.address, name: session.shipping.name } : null);
  var address = (sd && sd.address) || (session.customer_details && session.customer_details.address) || null;
  if (!address) return null;
  var name = (sd && sd.name) || (session.customer_details && session.customer_details.name) || null;
  return name ? Object.assign({}, address, { name: name }) : address;
})();

      const itemCount = items.reduce((s, i) => s + i.qty, 0) || null;
      const cartSummary = items.map(i => `${i.qty}× ${i.name}`).join(', ');

      await supaFetch(
        `/rest/v1/orders?stripe_session_id=eq.${encodeURIComponent(row.stripe_session_id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ items, shipping_address: shippingAddress, item_count: itemCount, cart_summary: cartSummary }),
        }
      );

      console.log(`✓ ${row.stripe_session_id.slice(-16)}  →  ${cartSummary}  📍 ${shippingAddress ? [shippingAddress.city, shippingAddress.postal_code].filter(Boolean).join(', ') : 'no address'}`);
      ok++;

      // Respect Stripe rate limits
      await new Promise(r => setTimeout(r, 120));
    } catch (err) {
      console.error(`✗ ${row.stripe_session_id.slice(-16)}  →  ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} updated, ${fail} failed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
