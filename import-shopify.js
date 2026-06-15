// ============================================================
//  import-shopify.js
//  One-time backfill of historical Shopify data into Supabase.
//
//  Handles BOTH Shopify exports and auto-detects which is which
//  by reading the CSV headers (filename doesn't matter):
//    • Orders export    → public.orders   (line items, dates, totals)
//    • Customers export → public.customers (lifetime spend, tags, consent)
//
//  Run:
//    node import-shopify.js orders_export.csv customer_export.csv
//  Or, with no args, it imports whichever of these exist:
//    orders_export.csv   customer_export.csv
//
//  Needs the same .env as backfill-orders.js:
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//
//  Idempotent: orders upsert on stripe_session_id,
//  customers upsert on email. Re-running updates, never dupes.
// ============================================================

require('dotenv').config();
const fs = require('fs');

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing env. Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

// Only import orders whose Shopify "Financial Status" is one of these.
const IMPORT_STATUSES = new Set(['paid', 'partially_refunded', 'partially_paid']);

// ---- ORDERS export column names (Shopify defaults) ----
const O = {
  name: 'Name', email: 'Email', finStatus: 'Financial Status', fulStatus: 'Fulfillment Status',
  currency: 'Currency', subtotal: 'Subtotal', shipping: 'Shipping', total: 'Total',
  createdAt: 'Created at', paidAt: 'Paid at', note: 'Note',
  liQty: 'Lineitem quantity', liName: 'Lineitem name', liPrice: 'Lineitem price', liSku: 'Lineitem sku',
  billName: 'Billing Name', shipName: 'Shipping Name', shipAddr1: 'Shipping Address1',
  shipAddr2: 'Shipping Address2', shipCity: 'Shipping City', shipZip: 'Shipping Zip', shipCountry: 'Shipping Country',
};

// ---- minimal correct CSV parser (quotes, commas + newlines inside fields) ----
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift().map(h => h.trim().replace(/^\uFEFF/, ''));
  return { headers, rows: rows.map(r => { const o = {}; headers.forEach((h, i) => { o[h] = (r[i] || '').trim(); }); return o; }) };
}

const slugify = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const numOrNull = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const yes = v => ['yes', 'true', 'subscribed', '1'].includes(String(v).toLowerCase().trim());

function detectType(headers) {
  const h = headers.map(x => x.toLowerCase());
  if (h.includes('lineitem name') || (h.includes('name') && h.includes('financial status'))) return 'orders';
  if (h.includes('total orders') || h.includes('customer id')) return 'customers';
  return null;
}

// ---- ORDERS ----
function buildOrderRecords(rows) {
  const byOrder = new Map();
  for (const row of rows) {
    const name = row[O.name];
    if (!name) continue;
    if (!byOrder.has(name)) byOrder.set(name, { header: row, lines: [] });
    const grp = byOrder.get(name);
    if (numOrNull(row[O.total]) != null && numOrNull(grp.header[O.total]) == null) grp.header = row;
    if (row[O.liName]) grp.lines.push(row);
  }
  const records = []; let skipped = 0;
  for (const [name, { header, lines }] of byOrder) {
    const status = (header[O.finStatus] || '').toLowerCase();
    if (!IMPORT_STATUSES.has(status)) { skipped++; continue; }
    const items = lines.map(l => {
      const n = l[O.liName];
      return { name: n, slug: slugify(n), sku: l[O.liSku] || '', qty: parseInt(l[O.liQty], 10) || 1, price: numOrNull(l[O.liPrice]) || 0 };
    });
    const addr = { line1: header[O.shipAddr1] || null, line2: header[O.shipAddr2] || null, city: header[O.shipCity] || null, postal_code: header[O.shipZip] || null, country: header[O.shipCountry] || null };
    records.push({
      stripe_session_id: `shopify:${name}`, source: 'shopify',
      customer_email: (header[O.email] || '').toLowerCase() || null,
      customer_name: header[O.billName] || header[O.shipName] || null,
      currency: (header[O.currency] || 'gbp').toLowerCase(),
      subtotal: numOrNull(header[O.subtotal]), shipping: numOrNull(header[O.shipping]), total: numOrNull(header[O.total]),
      item_count: items.reduce((s, i) => s + i.qty, 0) || null, items,
      cart_summary: items.map(i => `${i.qty}× ${i.name}`).join(', '),
      shipping_address: Object.values(addr).some(Boolean) ? addr : null,
      payment_status: status, gift_message: header[O.note] || null,
      has_gift_card: items.some(i => /gift\s*card/i.test(i.name || '')),
      fulfilled: (header[O.fulStatus] || '').toLowerCase() === 'fulfilled', fulfilled_at: null,
      created_at: header[O.createdAt] || header[O.paidAt] || new Date().toISOString(),
    });
  }
  return { records, skipped };
}

// ---- CUSTOMERS ----
function buildCustomerRecords(rows) {
  const records = []; let skipped = 0;
  for (const r of rows) {
    const email = (r['Email'] || '').toLowerCase().trim();
    if (!email) { skipped++; continue; }
    const addr = {
      company: r['Default Address Company'] || null, line1: r['Default Address Address1'] || null,
      line2: r['Default Address Address2'] || null, city: r['Default Address City'] || null,
      province: r['Default Address Province Code'] || null, country: r['Default Address Country Code'] || null,
      zip: r['Default Address Zip'] || null, phone: r['Default Address Phone'] || null,
    };
    records.push({
      email, shopify_customer_id: r['Customer ID'] || null,
      first_name: r['First Name'] || null, last_name: r['Last Name'] || null,
      phone: r['Phone'] || r['Default Address Phone'] || null,
      total_spent: numOrNull(r['Total Spent']) || 0, total_orders: parseInt(r['Total Orders'], 10) || 0,
      accepts_email_marketing: yes(r['Accepts Email Marketing']),
      accepts_sms_marketing: yes(r['Accepts SMS Marketing']),
      accepts_whatsapp_marketing: yes(r['Accepts WhatsApp Marketing']),
      tax_exempt: yes(r['Tax Exempt']), tags: r['Tags'] || null, note: r['Note'] || null,
      address: Object.values(addr).some(Boolean) ? addr : null, source: 'shopify',
    });
  }
  return { records, skipped };
}

async function upsertBatched(table, conflictCol, records) {
  for (let i = 0; i < records.length; i += 200) {
    const batch = records.slice(i, i + 200);
    const url = `${SUPA_URL.replace(/\/$/, '')}/rest/v1/${table}?on_conflict=${conflictCol}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`Supabase ${table} ${r.status}: ${t}`); }
    console.log(`  upserted ${Math.min(i + 200, records.length)}/${records.length}`);
  }
}

(async () => {
  let files = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (!files.length) files = ['orders_export.csv', 'customer_export.csv'].filter(f => fs.existsSync(f));
  if (!files.length) { console.error('No CSV given and no orders_export.csv / customer_export.csv found here.'); process.exit(1); }

  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`\nSkip (not found): ${f}`); continue; }
    const { headers, rows } = parseCSV(fs.readFileSync(f, 'utf8'));
    const type = detectType(headers);
    console.log(`\n${f}: ${rows.length} rows → detected "${type || 'UNKNOWN'}"`);
    if (type === 'orders') {
      const { records, skipped } = buildOrderRecords(rows);
      console.log(`  ${records.length} orders to import (${skipped} skipped by status)`);
      if (records.length) await upsertBatched('orders', 'stripe_session_id', records);
    } else if (type === 'customers') {
      const { records, skipped } = buildCustomerRecords(rows);
      console.log(`  ${records.length} customers to import (${skipped} skipped — no email)`);
      if (records.length) await upsertBatched('customers', 'email', records);
    } else {
      console.error(`  Could not detect type. First headers: ${headers.slice(0, 6).join(', ')}…`);
    }
  }
  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
