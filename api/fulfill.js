// ============================================================
//  POST /api/fulfill
//  Body: { stripe_session_id, fulfilled: true|false }
//  Toggles an order's fulfilment status in Supabase.
//  In DEMO mode (no Supabase) it acknowledges optimistically
//  so the UI stays interactive without persisting.
// ============================================================

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

  const body = await readJson(req);
  const id = body.stripe_session_id;
  const fulfilled = body.fulfilled !== false; // default true
  if (!id) return send(res, 400, { error: 'missing_stripe_session_id' });

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // ---- DEMO MODE: acknowledge without persisting -----------
  if (!SUPA_URL || !SUPA_KEY) {
    return send(res, 200, {
      demo: true,
      stripe_session_id: id,
      fulfilled,
      fulfilled_at: fulfilled ? new Date().toISOString() : null,
      note: 'Demo mode — change not persisted. Connect Supabase to save fulfilment.',
    });
  }

  // ---- LIVE: PATCH the order row ---------------------------
  try {
    const endpoint = `${SUPA_URL.replace(/\/$/, '')}/rest/v1/orders?stripe_session_id=eq.${encodeURIComponent(id)}`;
    const r = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        fulfilled,
        fulfilled_at: fulfilled ? new Date().toISOString() : null,
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return send(res, 502, { error: 'supabase_error', status: r.status, detail: txt.slice(0, 300) });
    }
    const rows = await r.json();
    return send(res, 200, { demo: false, updated: rows.length, order: rows[0] || null });
  } catch (err) {
    return send(res, 502, { error: 'supabase_unavailable', message: String(err && err.message || err) });
  }
};
