// =============================================================
//  api/_email.js  —  transactional email via Resend (server only)
//
//  Used by /api/fulfill to send a "your order has shipped" email
//  with tracking when an order is marked fulfilled in the portal.
//
//  Env vars (set on the PORTAL Vercel project):
//    EMAILS_ENABLED   "true" to actually send. Anything else = no-op.
//    RESEND_API_KEY   re_...
//    EMAIL_FROM       e.g.  Hepple Spirits <orders@hepple.barkerdigital.co.uk>
//    EMAIL_REPLY_TO   e.g.  hello@hepplespirits.com
//  Designed by Barker Digital
// =============================================================

const BRAND = { name: 'Hepple Spirits', cream: '#f6f2ea', navy: '#003087', ink: '#1c1c1c', muted: '#6b6b6b' };

function emailsEnabled() {
  return process.env.EMAILS_ENABLED === 'true' && !!process.env.RESEND_API_KEY;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function sendEmail({ to, subject, html }) {
  if (!emailsEnabled()) return { skipped: 'emails-disabled' };
  if (!to) return { skipped: 'no-recipient' };
  try {
    const payload = {
      from: process.env.EMAIL_FROM || 'Hepple Spirits <onboarding@resend.dev>',
      to: [to], subject, html,
    };
    if (process.env.EMAIL_REPLY_TO) payload.reply_to = process.env.EMAIL_REPLY_TO;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { const txt = await r.text().catch(() => ''); return { error: `resend ${r.status}: ${txt.slice(0, 200)}` }; }
    return { ok: true };
  } catch (err) { return { error: String((err && err.message) || err) }; }
}

function shell(innerHtml, preheader) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(BRAND.name)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.cream};">
<span style="display:none;opacity:0;color:${BRAND.cream};font-size:1px;">${esc(preheader || '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;
             font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};">
      <tr><td style="background:${BRAND.navy};padding:26px 32px;">
        <div style="color:#fff;font-size:20px;letter-spacing:.14em;font-weight:600;">${esc(BRAND.name.toUpperCase())}</div>
      </td></tr>
      ${innerHtml}
      <tr><td style="padding:22px 32px;background:${BRAND.cream};color:${BRAND.muted};font-size:12px;line-height:1.6;">
        ${esc(BRAND.name)} · Hepple, Northumberland<br>Please drink responsibly.
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

function addressBlock(addr) {
  if (!addr) return '';
  const lines = [addr.name, addr.line1, addr.line2, addr.city, addr.postal_code, addr.country]
    .filter(Boolean).map(esc).join('<br>');
  return lines ? `<div style="margin-top:6px;font-size:14px;line-height:1.6;">${lines}</div>` : '';
}

// ---- Shipped / tracking -------------------------------------
async function sendShippedEmail(order) {
  const first = (order.customer_name || '').split(' ')[0];
  const carrier = order.tracking_carrier || 'your carrier';
  const num = order.tracking_number || '';
  const url = order.tracking_url || '';

  const trackBtn = url
    ? `<tr><td style="padding:20px 32px 4px;">
         <a href="${esc(url)}" style="display:inline-block;background:${BRAND.navy};color:#fff;
            text-decoration:none;font-size:14px;font-weight:600;letter-spacing:.04em;
            padding:13px 26px;border-radius:9px;">Track your parcel</a>
       </td></tr>`
    : '';

  const inner = `
    <tr><td style="padding:30px 32px 8px;">
      <div style="font-size:18px;font-weight:600;">Good news${first ? ', ' + esc(first) : ''} — your order is on its way</div>
      <div style="margin-top:6px;font-size:14px;color:${BRAND.muted};">It's been dispatched and is heading to you now.</div>
    </td></tr>
    <tr><td style="padding:14px 32px 0;">
      <div style="font-size:12px;letter-spacing:.1em;color:${BRAND.muted};text-transform:uppercase;">Carrier</div>
      <div style="margin-top:4px;font-size:15px;">${esc(carrier)}</div>
      ${num ? `<div style="margin-top:12px;font-size:12px;letter-spacing:.1em;color:${BRAND.muted};text-transform:uppercase;">Tracking number</div>
      <div style="margin-top:4px;font-size:15px;font-family:ui-monospace,Menlo,Consolas,monospace;">${esc(num)}</div>` : ''}
    </td></tr>
    ${trackBtn}
    <tr><td style="padding:20px 32px 26px;">
      <div style="font-size:12px;letter-spacing:.1em;color:${BRAND.muted};text-transform:uppercase;">Shipping to</div>
      ${addressBlock(order.shipping_address)}
    </td></tr>`;

  return sendEmail({
    to: order.customer_email,
    subject: `Your ${BRAND.name} order is on its way`,
    html: shell(inner, `Your ${BRAND.name} order has shipped${num ? ' — tracking inside' : ''}.`),
  });
}

module.exports = { emailsEnabled, sendEmail, sendShippedEmail };
