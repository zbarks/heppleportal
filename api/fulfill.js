// ============================================================
//  POST /api/fulfill
//  Body: { stripe_session_id, fulfilled: true|false,
//          tracking_carrier?, tracking_number? }
//
//  Toggles an order's fulfilment status in Supabase. When marking
//  fulfilled WITH a tracking number, it also stamps shipped_at, builds
//  a tracking_url from the carrier, and emails the customer once.
//
//  Env (portal project): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//  plus EMAILS_ENABLED / RESEND_API_KEY / EMAIL_FROM / EMAIL_REPLY_TO.
//  Designed by Barker Digital
// ============================================================

const { emailsEnabled, sendShippedEmail } = require('./_email');

// Build a public tracking URL from carrier + number. Add carriers freely.
const CARRIERS = {
  'Royal Mail':  (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(n)}`,
  'Parcelforce': (n) => `https://www.parcelforce.com/track-trace?trackNumber=${encodeURIComponent(n)}`,
  'DPD':         (n) => `https://www.dpd.co.uk/apps/tracking/?reference=${encodeURIComponent(n)}`,
  'Evri':        (n) => `https://www.evri.com/track/parcel/${encodeURIComponent(n)}`,
  'UPS':         (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  'DHL':         (n) => `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
  'FedEx':       (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
};
function trackingUrl(carrier, number) {
  if (!carrier || !number) return null;
  const fn = CARRIERS[carrier];
  return fn ? fn(number) : null;
}

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
  const carrier = (body.tracking_carrier || '').trim() || null;
  const number  = (body.tracking_number  || '').trim() || null;
  if (!id) return send(res, 400, { error: 'missing_stripe_session_id' });

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // ---- DEMO MODE: acknowledge without persisting -----------
  if (!SUPA_URL || !SUPA_KEY) {
    return send(res, 200, {
      demo: true, stripe_session_id: id, fulfilled,
      fulfilled_at: fulfilled ? new Date().toISOString() : null,
      tracking_carrier: carrier, tracking_number: number,
      tracking_url: trackingUrl(carrier, number),
      note: 'Demo mode — change not persisted. Connect Supabase to save fulfilment.',
    });
  }

  const base = `${SUPA_URL.replace(/\/$/, '')}/rest/v1/orders`;
  const auth = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
  };
  const now = new Date().toISOString();

  // ---- LIVE: PATCH the order row ---------------------------
  try {
    const patch = {
      fulfilled,
      fulfilled_at: fulfilled ? now : null,
    };
    if (fulfilled) {
      // Only touch tracking/shipping fields when shipping out.
      patch.tracking_carrier = carrier;
      patch.tracking_number  = number;
      patch.tracking_url     = trackingUrl(carrier, number);
      patch.shipped_at       = now;
    } else {
      // Un-marking clears the dispatch state so it can ship cleanly later.
      patch.tracking_carrier = null;
      patch.tracking_number  = null;
      patch.tracking_url     = null;
      patch.shipped_at       = null;
      patch.shipped_email_sent_at = null;
    }

    const r = await fetch(`${base}?stripe_session_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...auth, Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const txt = await r.text();
      return send(res, 502, { error: 'supabase_error', status: r.status, detail: txt.slice(0, 300) });
    }
    const rows = await r.json();
    const order = rows[0] || null;

    // ---- Shipped email (once), only when there's tracking ----
    let emailed = false;
    if (fulfilled && number && order && order.customer_email && emailsEnabled()) {
      try {
        // Atomic claim: flip shipped_email_sent_at NULL→now; send only if we won.
        const claim = await fetch(
          `${base}?stripe_session_id=eq.${encodeURIComponent(id)}&shipped_email_sent_at=is.null`,
          { method: 'PATCH', headers: { ...auth, Prefer: 'return=representation' },
            body: JSON.stringify({ shipped_email_sent_at: now }) }
        );
        if (claim.ok) {
          const claimedRows = await claim.json().catch(() => []);
          if (claimedRows.length) {
            const result = await sendShippedEmail(order);
            emailed = !!(result && result.ok);
            if (result && result.error) console.error('[fulfill] shipped email error:', result.error);
          }
        }
      } catch (e) {
        console.error('[fulfill] shipped email threw:', e && e.message);
      }
    }

    return send(res, 200, { demo: false, updated: rows.length, emailed, order });
  } catch (err) {
    return send(res, 502, { error: 'supabase_unavailable', message: String(err && err.message || err) });
  }
};
