// 9artifacts.com: static landing page. www and plain http redirect to the apex,
// /install.sh to the installer on GitHub;
// everything else is served from ./public with the security headers below.
const APEX = '9artifacts.com';
const CSP = "default-src 'self'; img-src 'self' data: https://deploy.workers.cloudflare.com; media-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.hostname === 'www.' + APEX || (url.hostname === APEX && url.protocol === 'http:')) {
      url.hostname = APEX;
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    // The installer lives in the repository; the short URL just points at main.
    if (url.pathname === '/install.sh') {
      return Response.redirect('https://raw.githubusercontent.com/dinhkarate/9artifacts/main/install.sh', 302);
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
