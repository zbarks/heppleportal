// =============================================================
//  /api/settings   (portal)
//    GET  -> { gift_enabled }
//    POST { gift_enabled: bool } -> persists + returns new state
//  Backed by Supabase site_settings (key/value). Service role only.
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

module.exports = async function handler(req, res) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Demo mode (no Supabase): report gift on, accept toggles without persisting.
  if (!SUPA_URL || !SUPA_KEY) {
    if (req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { gift_enabled: body.gift_enabled !== false, demo: true });
    }
    return send(res, 200, { gift_enabled: true, demo: true });
  }

  const base = `${SUPA_URL.replace(/\/$/, '')}/rest/v1/site_settings`;
  const auth = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
  };

  if (req.method === 'GET') {
    try {
      const r = await fetch(`${base}?key=eq.gift_enabled&select=value`, { headers: auth });
      const rows = r.ok ? await r.json() : [];
      const giftEnabled = !(rows.length && rows[0].value === false);
      return send(res, 200, { gift_enabled: giftEnabled });
    } catch (err) {
      return send(res, 200, { gift_enabled: true }); // fail open
    }
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const next = body.gift_enabled !== false;
    try {
      const r = await fetch(`${base}?on_conflict=key`, {
        method: 'POST',
        headers: { ...auth, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ key: 'gift_enabled', value: next, updated_at: new Date().toISOString() }]),
      });
      if (!r.ok) {
        const txt = await r.text();
        return send(res, 502, { error: 'supabase_error', detail: txt.slice(0, 300) });
      }
      return send(res, 200, { gift_enabled: next });
    } catch (err) {
      return send(res, 502, { error: 'supabase_unavailable', message: String(err && err.message || err) });
    }
  }

  return send(res, 405, { error: 'method_not_allowed' });
};
