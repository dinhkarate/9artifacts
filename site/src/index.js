// 9artifacts.com: static landing page. www and any other host redirect to the apex;
// everything else is served from ./public with the security headers below.
const APEX = '9artifacts.com';
const CSP = "default-src 'self'; img-src 'self' data: https://deploy.workers.cloudflare.com; media-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.hostname === 'www.' + APEX) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }
    const resp = await env.ASSETS.fetch(req);
    const out = new Response(resp.body, resp);
    out.headers.set('Content-Security-Policy', CSP);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (url.protocol === 'https:') out.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return out;
  },
};
