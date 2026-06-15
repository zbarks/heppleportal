// ============================================================
//  middleware.js  — site-wide password gate (HTTP Basic Auth)
//
//  Runs on Vercel BEFORE every request, so it protects the
//  static pages AND the /api/* routes (which hold all the
//  Supabase data). Without this, /api/orders would stay open
//  even if the HTML were hidden.
//
//  Credentials live in environment variables (never in code):
//    BASIC_AUTH_USER       e.g. hepple
//    BASIC_AUTH_PASSWORD   your chosen password
//  Add them in Vercel → Project → Settings → Environment
//  Variables (Production), then redeploy.
// ============================================================
import { next } from '@vercel/edge';

export const config = {
  // Protect everything except the favicon/robots so the browser
  // doesn't prompt for those. Covers all pages and all /api routes.
  matcher: ['/((?!favicon.ico|robots.txt).*)'],
};

export default function middleware(request) {
  const USER = process.env.BASIC_AUTH_USER;
  const PASS = process.env.BASIC_AUTH_PASSWORD;

  // If creds aren't configured, fail closed (deny) rather than open.
  if (!USER || !PASS) {
    return new Response('Auth not configured', { status: 503 });
  }

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch (e) { decoded = ''; }
    const i = decoded.indexOf(':');
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    if (i !== -1 && user === USER && pass === PASS) {
      return next();  // correct password → let the request through
    }
  }

  // Missing or wrong credentials → challenge the browser.
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Hepple Portal", charset="UTF-8"' },
  });
}
