// glasshelf on Cloudflare Workers: routes, host separation, security headers and
// access logging (internal/app/server.go).
import { BRAND } from './brand';
import * as api from './api';
import * as auth from './auth';
import * as comments from './comments';
import { handleContent, handleShareContent, handleShareGrant, handleSharePage, serveVersionFile } from './content';
import { type Ctx, contentOrigin, isHTTPS, newCtx } from './env';
import { DESIGN_MD, INDEX_HTML, TEMPLATE_HTML } from './generated/web';
import { handleMCP } from './mcp';
import * as oauth from './oauth';
import { getVersion } from './store';
import { renderTemplate } from './template';
import { HttpError, b64url, json, jsonError, notFound, randomBytes, textError } from './util';

type Handler = (c: Ctx, p: Record<string, string>) => Promise<Response> | Response;
type Guard = 'auth' | 'session' | null;

interface Route {
  method: string;
  segs: string[];
  guard: Guard;
  h: Handler;
}

const routes: Route[] = [];
function route(spec: string, h: Handler, guard: Guard = null) {
  const [method, path] = spec.split(' ');
  routes.push({ method, segs: path === '/' ? [''] : path.slice(1).split('/'), guard, h });
}

// App shell and theme.
for (const p of ['/', '/a/{id}', '/settings', '/setup', '/login', '/oauth/authorize']) route('GET ' + p, (c) => handleIndex(c));
route('GET /assets/{name}', (c, p) => handleAsset(c, p.name));
route('GET /design.md', () => new Response(DESIGN_MD, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }));
route('GET /template.html', () => new Response(TEMPLATE_HTML, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
route('GET /health', (c) => json(200, { ok: true, version: c.version }));
// Auth.
route('GET /api/me', auth.handleMe);
route('POST /api/auth/setup', auth.handleSetup);
route('POST /api/auth/login', auth.handleLogin);
route('POST /api/auth/logout', auth.handleLogout);
route('POST /api/auth/passkey/login/begin', auth.handlePasskeyLoginBegin);
route('POST /api/auth/passkey/login/finish', auth.handlePasskeyLoginFinish);
route('POST /api/passkeys/begin', auth.handlePasskeyRegisterBegin, 'session');
route('POST /api/passkeys/finish', auth.handlePasskeyRegisterFinish, 'session');
route('GET /api/passkeys', auth.handlePasskeyList, 'session');
route('DELETE /api/passkeys/{id}', (c, p) => auth.handlePasskeyDelete(c, p.id), 'session');
route('POST /api/password', () => auth.handlePasswordChange(), 'session');
route('GET /api/tokens', auth.handleTokenList, 'session');
route('POST /api/tokens', auth.handleTokenCreate, 'session');
route('DELETE /api/tokens/{id}', (c, p) => auth.handleTokenDelete(c, p.id), 'session');
// Artifacts.
route('GET /api/artifacts', api.handleList, 'auth');
route('POST /api/artifacts', api.handleCreate, 'auth');
route('GET /api/artifacts/{id}', (c, p) => api.handleGet(c, p.id), 'auth');
route('PATCH /api/artifacts/{id}', (c, p) => api.handlePatch(c, p.id), 'auth');
route('DELETE /api/artifacts/{id}', (c, p) => api.handleDelete(c, p.id), 'auth');
route('POST /api/artifacts/{id}/versions', (c, p) => api.handleNewVersion(c, p.id), 'auth');
route('POST /api/artifacts/{id}/versions/{n}/restore', (c, p) => api.handleRestore(c, p.id, p.n), 'auth');
route('POST /api/artifacts/{id}/shares', (c, p) => api.handleShareCreate(c, p.id), 'auth');
route('POST /api/artifacts/{id}/comments', (c, p) => comments.handleCommentCreate(c, p.id), 'auth');
route('POST /api/artifacts/{id}/comments/{cid}/resolve', (c, p) => comments.handleCommentResolve(c, p.id, p.cid), 'auth');
route('DELETE /api/artifacts/{id}/comments/{cid}', (c, p) => comments.handleCommentDelete(c, p.id, p.cid), 'auth');
route('DELETE /api/artifacts/{id}/shares/{token}', (c, p) => api.handleShareRevoke(c, p.id, p.token), 'auth');
route('GET /api/artifacts/{id}/download/{path...}', (c, p) => handleDownload(c, p.id, p.path), 'auth');
// MCP for agents.
route('POST /mcp', oauth.cors(handleMCP));
route('OPTIONS /mcp', oauth.cors(null));
route('GET /mcp', oauth.cors(() => json(405, { error: 'use POST (MCP streamable HTTP, JSON responses)' }, { Allow: 'POST' })));
// OAuth for MCP connectors (see oauth.ts).
route('GET /.well-known/oauth-protected-resource', oauth.cors(oauth.handleResourceMetadata));
route('GET /.well-known/oauth-protected-resource/mcp', oauth.cors(oauth.handleResourceMetadata));
route('GET /.well-known/oauth-authorization-server', oauth.cors(oauth.handleAuthServerMetadata));
route('POST /oauth/register', oauth.cors(oauth.handleOAuthRegister));
route('OPTIONS /oauth/register', oauth.cors(null));
route('POST /oauth/token', oauth.cors(oauth.handleOAuthToken));
route('OPTIONS /oauth/token', oauth.cors(null));
route('GET /api/oauth/client', oauth.handleOAuthClientInfo, 'session');
route('POST /api/oauth/authorize', oauth.handleOAuthDecision, 'session');
// Public share page.
route('GET /s/{token}', (c, p) => handleSharePage(c, p.token));
route('POST /s/{token}', (c, p) => handleSharePage(c, p.token));
route('GET /s/{token}/g/{grant}/{path...}', (c, p) => handleShareGrant(c, p.token, p.grant, p.path));
// Artifact bytes (content origin).
route('GET /c/{vt}/{path...}', (c, p) => handleContent(c, p.vt, p.path));
route('GET /s/{token}/f/{path...}', (c, p) => handleShareContent(c, p.token, p.path));

function matchRoute(r: Route, segs: string[]): Record<string, string> | null {
  const p: Record<string, string> = {};
  for (let i = 0; i < r.segs.length; i++) {
    const s = r.segs[i];
    if (i >= segs.length) return null;
    if (s.endsWith('...}')) {
      p[s.slice(1, -4)] = segs.slice(i).map(decodeURIComponent).join('/');
      return p;
    }
    if (s.startsWith('{')) {
      if (segs[i] === '') return null;
      p[s.slice(1, -1)] = decodeURIComponent(segs[i]);
    } else if (s !== segs[i]) {
      return null;
    }
  }
  return segs.length === r.segs.length ? p : null;
}

/** Matches like Go's ServeMux: segment wildcards, {x...} remainders, GET also serves HEAD. */
function match(path: string, method: string): { r: Route; p: Record<string, string> } | { allow: string[] } | null {
  const segs = path === '/' ? [''] : path.slice(1).split('/');
  const allow = new Set<string>();
  for (const r of routes) {
    const p = matchRoute(r, segs);
    if (!p) continue;
    if (r.method === method || (r.method === 'GET' && method === 'HEAD')) return { r, p };
    allow.add(r.method);
    if (r.method === 'GET') allow.add('HEAD');
  }
  return allow.size ? { allow: [...allow].sort() } : null;
}

// ---------- shell ----------

/** appCSP: app pages run only nonce'd scripts, so files served from /c/ on a shared origin never run as app code. */
function appCSP(c: Ctx, script: string): string {
  const co = contentOrigin(c);
  return `default-src 'self'; script-src ${script}; img-src 'self' data: blob: ${co}; style-src 'self' 'unsafe-inline'; frame-src ${co} 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'`;
}

// The Go shell's setup and sign-in forms ask for a password. This edition is
// passkey-only, so the same markup is adjusted on the way out: the setup code
// field takes the SETUP_TOKEN, and the sign-in password field becomes the
// recovery field for it. app.js is unchanged.
const passkeyOnly = new HTMLRewriter()
  .on('#setup-form p.muted', { element: (e) => void e.setInnerContent('Enter the setup token (the SETUP_TOKEN Worker secret), then add a passkey in Settings.') })
  .on('label[for="setup-code"]', { element: (e) => void e.setInnerContent('Setup token <span class="muted">(the SETUP_TOKEN secret)</span>', { html: true }) })
  .on('label[for="setup-pw"]', { element: (e) => void e.setAttribute('hidden', '') })
  .on('#setup-pw', { element: (e) => void e.removeAttribute('required').removeAttribute('minlength').setAttribute('hidden', '') })
  .on('#setup-form button[type="submit"]', { element: (e) => void e.setInnerContent('Continue') })
  .on('#login-form .divider span', { element: (e) => void e.setInnerContent('or recover with the setup token') })
  .on('label[for="pw"]', { element: (e) => void e.setInnerContent('Setup token') })
  .on('#pw', { element: (e) => void e.setAttribute('placeholder', 'Setup token').setAttribute('autocomplete', 'off') })
  .on('#login-form button[type="submit"]', { element: (e) => void e.setInnerContent('Recover') })
  // Settings → Password has nothing to change here.
  .on('head', { element: (e) => void e.append('<style>.settings .panel:has(input[autocomplete="current-password"]){display:none}</style>', { html: true }) });

function handleIndex(c: Ctx): Response {
  const nonce = b64url(randomBytes(16));
  const html = renderTemplate(INDEX_HTML, { Name: c.name, Version: c.version, Nonce: nonce });
  const resp = new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': appCSP(c, `'nonce-${nonce}'`) },
  });
  return passkeyOnly.transform(resp);
}

async function handleAsset(c: Ctx, name: string): Promise<Response> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return notFound();
  const r = await c.env.ASSETS.fetch(new Request(new URL('/assets/' + name, c.url), { method: c.req.method, headers: c.req.headers }));
  return r.status === 404 ? notFound() : r;
}

async function handleDownload(c: Ctx, id: string, path: string): Promise<Response> {
  const v = await getVersion(c, id, parseInt(c.url.searchParams.get('v') ?? '', 10) || 0);
  if (!v) return jsonError(404, 'not found');
  return serveVersionFile(c, id, v, path, true, false);
}

// ---------- request pipeline ----------

const contentPath = /^\/(?:c\/|s\/[^/]+\/[fg]\/)/;
const sharePagePath = /^\/s\/[^/]+$/;
const secretPath = /^\/(c|s)\/[^/]+|\/shares\/[^/]+|\/g\/[^/]+/g;

/** The logged path never contains share, view or grant tokens. */
export function redactPath(path: string): string {
  return path.replace(secretPath, (m) => (m.startsWith('/shares/') ? '/shares/…' : m.startsWith('/g/') ? '/g/…' : m.slice(0, 3) + '…'));
}

async function serve(c: Ctx): Promise<Response> {
  const path = c.url.pathname;
  const isContent = contentPath.test(path);
  const sharePage = sharePagePath.test(path);
  if (c.contHost) {
    // With SHARES_ON_CONTENT the content host also serves share pages and the
    // static assets they use; the app host forwards old share links.
    const pub = c.sharesOnContent && (sharePage || path.startsWith('/assets/'));
    if (c.onContent && !isContent && !pub && path !== '/health') return textError(404, 'not found');
    if (!c.onContent && isContent) return textError(404, 'not found');
    if (!c.onContent && sharePage && c.sharesOnContent) return new Response(null, { status: 308, headers: { Location: c.contentURL + path } });
  }
  let m: ReturnType<typeof match>;
  try {
    m = match(path, c.req.method);
  } catch {
    return textError(400, 'Bad Request');
  }
  if (!m) return notFound();
  if ('allow' in m) {
    const r = textError(405, 'Method Not Allowed');
    r.headers.set('Allow', m.allow.join(', '));
    return r;
  }
  if (m.r.guard === 'auth' && !(await auth.authed(c))) return auth.unauthorized();
  if (m.r.guard === 'session' && !(await auth.sessionOnly(c))) return auth.unauthorized();
  try {
    return await m.r.h(c, m.p);
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.message);
    console.error('internal error:', redactPath(path), String((e as Error)?.stack ?? e));
    return jsonError(500, 'internal error');
  }
}

/** Adds the headers every response gets, without overriding handler-specific ones. */
function secure(c: Ctx, resp: Response): Response {
  const out = new Response(resp.body, resp);
  const h = out.headers;
  const def = (k: string, v: string) => {
    if (!h.has(k)) h.set(k, v);
  };
  def('X-Content-Type-Options', 'nosniff');
  def('Referrer-Policy', 'no-referrer');
  def('X-Robots-Tag', 'noindex, nofollow');
  if (!contentPath.test(c.url.pathname)) {
    def('X-Frame-Options', 'DENY');
    def('Content-Security-Policy', appCSP(c, "'none'"));
    if (isHTTPS(c)) def('Strict-Transport-Security', 'max-age=31536000');
  }
  return out;
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const start = Date.now();
    let c: Ctx;
    try {
      c = newCtx(req, env, exec);
    } catch (e) {
      console.error('configuration error:', (e as Error).message);
      return textError(500, BRAND + ' is misconfigured: ' + (e as Error).message);
    }
    const resp = secure(c, await serve(c));
    console.log(`${req.method} ${redactPath(c.url.pathname)} ${resp.status} ${Date.now() - start}ms`);
    return resp;
  },

  /** Hourly: drop expired sessions, challenges, lockouts and visit markers. */
  async scheduled(_ctl: ScheduledController, env: Env): Promise<void> {
    await cleanup(env.DB, Date.now());
  },
} satisfies ExportedHandler<Env>;

export async function cleanup(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
    db.prepare('DELETE FROM challenges WHERE expires < ?').bind(now),
    db.prepare('DELETE FROM failures WHERE lock < ?1 AND first < ?2').bind(now, now - 15 * 60e3),
    db.prepare('DELETE FROM share_recent WHERE at < ?').bind(now - 3600e3),
    db.prepare('DELETE FROM oauth_codes WHERE expires < ?').bind(now),
  ]);
}
