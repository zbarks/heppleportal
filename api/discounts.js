// =============================================================
//  /api/discounts   (portal)
//    GET                    -> { codes: [...] }   all codes + usage stats
//    GET ?code=MYSCHOOL10   -> { orders: [...] }  orders that used that code
//    POST   { code, kind, value, ... }        -> create
//    PATCH  { id, ... } | { id, active }      -> update / toggle
//    DELETE ?id=3                             -> delete
//
//  Backed by Supabase public.discount_codes plus the discount_code_stats and
//  discount_code_orders views. Service role only — the storefront never talks
//  to this; it goes through the site's own /api/promo-check.
//  Designed by Barker Digital
// =============================================================

function send(res, code, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).json(body);
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Demo rows so the portal still renders with no Supabase configured.
const DEMO_CODES = [{
  id: 1, code: 'MYSCHOOL10', kind: 'percent', value: 10, active: true,
  label: '10% OFF + FREE UK DELIVERY', description: 'Demo data',
  free_shipping: true, once_per_customer: true, stripe_coupon_id: null,
  times_used: 1, total_discount: 11.24, total_revenue: 101.17,
  first_used_at: null, last_used_at: null,
}];

// Validate + normalise a submitted code. Throws with a human message.
function clean(body) {
  const kind = String(body.kind || 'percent').toLowerCase();
  if (kind !== 'percent' && kind !== 'fixed') {
    throw new Error('Type must be "percent" or "fixed"');
  }

  const value = Number(body.value);
  if (!isFinite(value) || value <= 0) throw new Error('Amount must be more than 0');
  if (kind === 'percent' && value > 100) throw new Error('A percentage cannot be over 100');

  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{2,40}$/.test(code)) {
    throw new Error('Code must be 2–40 characters — letters, numbers, and . _ - only');
  }

  return {
    code,
    kind,
    value: Math.round(value * 100) / 100,
    label: body.label ? String(body.label).trim().toUpperCase().slice(0, 80) : null,
    description: body.description ? String(body.description).trim().slice(0, 200) : null,
    free_shipping: !!body.free_shipping,
    once_per_customer: body.once_per_customer !== false,
    stripe_coupon_id: body.stripe_coupon_id ? String(body.stripe_coupon_id).trim().slice(0, 80) : null,
    active: body.active !== false,
  };
}

module.exports = async function handler(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPA_URL || !SUPA_KEY) {
    if (req.method === 'GET' && !(req.query && req.query.code)) {
      return send(res, 200, { codes: DEMO_CODES, demo: true });
    }
    if (req.method === 'GET') return send(res, 200, { orders: [], demo: true });
    return send(res, 200, { demo: true, error: 'Supabase is not configured, so nothing was saved.' });
  }

  const base = SUPA_URL.replace(/\/$/, '') + '/rest/v1';
  const auth = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
  };

  // Surface Postgres errors as something a human can act on.
  async function fail(resp) {
    const txt = await resp.text().catch(() => '');
    if (/duplicate key|23505/.test(txt)) return 'That code already exists';
    if (/discount_codes_percent_max/.test(txt)) return 'A percentage cannot be over 100';
    if (/violates check constraint/.test(txt)) return 'Those values are not allowed';
    console.error('[discounts] Supabase error:', resp.status, txt);
    return 'Could not save — please try again';
  }

  try {
    // ---- read ------------------------------------------------------------
    if (req.method === 'GET') {
      const code = req.query && req.query.code;

      if (code) {
        const r = await fetch(
          `${base}/discount_code_orders?code=eq.${encodeURIComponent(String(code).toUpperCase())}`
          + `&order=created_at.desc`,
          { headers: auth }
        );
        if (!r.ok) return send(res, 502, { error: await fail(r) });
        return send(res, 200, { orders: await r.json() });
      }

      const r = await fetch(
        `${base}/discount_code_stats?order=active.desc,code.asc`,
        { headers: auth }
      );
      if (!r.ok) return send(res, 502, { error: await fail(r) });
      return send(res, 200, { codes: await r.json() });
    }

    // ---- create ----------------------------------------------------------
    if (req.method === 'POST') {
      const row = clean(await readJson(req));
      const r = await fetch(`${base}/discount_codes`, {
        method: 'POST',
        headers: Object.assign({}, auth, { Prefer: 'return=representation' }),
        body: JSON.stringify([row]),
      });
      if (!r.ok) return send(res, 400, { error: await fail(r) });
      const rows = await r.json();
      return send(res, 201, { code: rows[0] });
    }

    // ---- update ----------------------------------------------------------
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const id = parseInt(body.id, 10);
      if (!id) return send(res, 400, { error: 'Missing id' });

      // A bare on/off toggle shouldn't have to resubmit the whole record.
      const keys = Object.keys(body);
      const patch = (keys.length === 2 && keys.indexOf('active') !== -1)
        ? { active: !!body.active }
        : clean(body);

      const r = await fetch(`${base}/discount_codes?id=eq.${id}`, {
        method: 'PATCH',
        headers: Object.assign({}, auth, { Prefer: 'return=representation' }),
        body: JSON.stringify(patch),
      });
      if (!r.ok) return send(res, 400, { error: await fail(r) });
      const rows = await r.json();
      return send(res, 200, { code: rows[0] });
    }

    // ---- delete ----------------------------------------------------------
    if (req.method === 'DELETE') {
      const id = parseInt((req.query && req.query.id) || 0, 10);
      if (!id) return send(res, 400, { error: 'Missing id' });

      // Past orders reference the code as a plain string, so a delete keeps
      // the orders but loses the type/value on the report. The UI warns first.
      const r = await fetch(`${base}/discount_codes?id=eq.${id}`, {
        method: 'DELETE',
        headers: auth,
      });
      if (!r.ok) return send(res, 400, { error: await fail(r) });
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return send(res, 405, { error: 'Method not allowed' });

  } catch (err) {
    return send(res, 400, { error: (err && err.message) || 'Something went wrong' });
  }
};
