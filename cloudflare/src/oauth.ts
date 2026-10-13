// OAuth 2.1 authorization server for MCP clients (internal/app/oauth.go):
// protected-resource metadata (RFC 9728), server metadata (RFC 8414), dynamic
// client registration (RFC 7591), PKCE S256 only, public clients. The owner
// approves a client on the SPA's consent page; the client then gets an access
// token (1 h) and a rotating refresh token (90 days), both stored hashed and
// revocable in Settings like any API token. Clients and codes live in D1.
import type { Ctx } from './env';
import { HttpError, b64url, bool, dec, field, hashSecret, json, newID, randomBytes, readBody, readJSON, safeEqual, sha256, str, truncate } from './util';

const CODE_TTL = 5 * 60e3;
const ACCESS_TTL = 3600e3;
const REFRESH_TTL = 90 * 86400e3;
const MAX_CLIENTS = 100;
const MAX_TOKENS = 50;

export const resourceURL = (c: Ctx) => c.publicURL + '/mcp';
export const resourceMetadataURL = (c: Ctx) => c.publicURL + '/.well-known/oauth-protected-resource';

/** cors lets browser-based MCP clients call /mcp and the public OAuth endpoints. No cookies are involved. */
export function cors(h: ((c: Ctx) => Promise<Response> | Response) | null) {
  return async (c: Ctx): Promise<Response> => {
    const resp = c.req.method === 'OPTIONS' || !h ? new Response(null, { status: 204 }) : await h(c);
    const out = new Response(resp.body, resp);
    out.headers.set('Access-Control-Allow-Origin', '*');
    out.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
    out.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    out.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    return out;
  };
}

export function handleResourceMetadata(c: Ctx): Response {
  return json(200, {
    resource: resourceURL(c),
    authorization_servers: [c.publicURL],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_name: c.name,
  });
}

export function handleAuthServerMetadata(c: Ctx): Response {
  const u = c.publicURL;
  return json(200, {
    issuer: u,
    authorization_endpoint: u + '/oauth/authorize',
    token_endpoint: u + '/oauth/token',
    registration_endpoint: u + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
}

const oauthError = (status: number, code: string, desc: string) => json(status, { error: code, error_description: desc });

/** validRedirect accepts https URLs and http loopback URLs (native apps). */
export function validRedirect(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (raw.includes('#') || !u.host) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

interface Client {
  id: string;
  name: string;
  redirectURIs: string[];
  createdAt: string;
}

async function getClient(c: Ctx, id: string): Promise<Client | null> {
  const r = await c.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind(id).first<Record<string, string>>();
  return r ? { id: r.id, name: r.name, redirectURIs: JSON.parse(r.redirect_uris), createdAt: r.created_at } : null;
}

export async function handleOAuthRegister(c: Ctx): Promise<Response> {
  let name: string, uris: unknown;
  try {
    const b = await readJSON(c.req);
    name = str(b, 'client_name');
    uris = field(b, 'redirect_uris') ?? [];
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'invalid JSON');
  }
  if (!Array.isArray(uris) || uris.some((u) => typeof u !== 'string')) return oauthError(400, 'invalid_client_metadata', 'invalid JSON');
  if (uris.length === 0 || uris.length > 10) return oauthError(400, 'invalid_redirect_uri', '1 to 10 redirect_uris are required');
  for (const u of uris as string[]) {
    if (!validRedirect(u) || u.length > 2000) return oauthError(400, 'invalid_redirect_uri', 'redirect URIs must be https (or http on localhost)');
  }
  name = truncate(name, 80) || 'MCP client';
  const now = new Date();
  const client: Client = { id: 'vc_' + newID(12), name, redirectURIs: uris as string[], createdAt: now.toISOString() };
  const n = await c.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').first<number>('n');
  const stmts = [];
  if ((n ?? 0) >= MAX_CLIENTS) {
    // Forget the oldest client that has no token.
    stmts.push(c.db.prepare(`DELETE FROM oauth_clients WHERE id = (SELECT id FROM oauth_clients o
      WHERE NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id = o.id) ORDER BY created_at LIMIT 1)`));
  }
  stmts.push(c.db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').bind(client.id, name, JSON.stringify(uris), client.createdAt));
  await c.db.batch(stmts);
  return json(201, {
    client_id: client.id, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: name, redirect_uris: uris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
}

/** handleOAuthClientInfo feeds the consent page (owner session only). */
export async function handleOAuthClientInfo(c: Ctx): Promise<Response> {
  const client = await getClient(c, c.url.searchParams.get('client_id') ?? '');
  const redirect = c.url.searchParams.get('redirect_uri') ?? '';
  if (!client || !client.redirectURIs.includes(redirect)) return json(400, { error: 'unknown client or redirect URI' });
  return json(200, { name: client.name, redirectHost: new URL(redirect).host });
}

/** handleOAuthDecision is the consent page's Allow/Deny (owner session + CSRF). */
export async function handleOAuthDecision(c: Ctx): Promise<Response> {
  const b = await readJSON(c.req);
  const d = {
    clientID: str(b, 'client_id'), redirectURI: str(b, 'redirect_uri'), state: str(b, 'state'), challenge: str(b, 'code_challenge'),
    method: str(b, 'code_challenge_method'), responseType: str(b, 'response_type'), resource: str(b, 'resource'), approve: bool(b, 'approve') ?? false,
  };
  const client = await getClient(c, d.clientID);
  // Never redirect to an unregistered URI.
  if (!client || !client.redirectURIs.includes(d.redirectURI)) return json(400, { error: 'unknown client or redirect URI' });
  const back = (params: Record<string, string>) => {
    if (d.state) params.state = d.state;
    params.iss = c.publicURL;
    const u = new URL(d.redirectURI);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.sort(); // Go's url.Values.Encode sorts by key
    return json(200, { redirect: u.toString() });
  };
  const resource = d.resource.replace(/\/+$/, '');
  if (!d.approve) return back({ error: 'access_denied' });
  if (d.responseType !== 'code') return back({ error: 'unsupported_response_type' });
  if (d.method !== 'S256' || d.challenge.length < 43 || d.challenge.length > 128) {
    return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
  }
  if (d.resource && resource !== resourceURL(c) && resource !== c.publicURL) return back({ error: 'invalid_target' });
  const code = b64url(randomBytes(24));
  await c.db
    .prepare('INSERT INTO oauth_codes (hash, client_id, redirect_uri, challenge, expires) VALUES (?, ?, ?, ?, ?)')
    .bind(await hashSecret(code), client.id, d.redirectURI, d.challenge, Date.now() + CODE_TTL)
    .run();
  return back({ code });
}

export async function handleOAuthToken(c: Ctx): Promise<Response> {
  let f: URLSearchParams;
  try {
    f = new URLSearchParams(dec.decode(await readBody(c.req, 16 << 10)));
  } catch {
    return oauthError(400, 'invalid_request', 'form body expected');
  }
  try {
    switch (f.get('grant_type')) {
      case 'authorization_code':
        return await exchangeCode(c, f);
      case 'refresh_token':
        return await refreshToken(c, f);
    }
  } catch (e) {
    if (e instanceof HttpError) return oauthError(400, 'invalid_grant', e.message);
    throw e;
  }
  return oauthError(400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
}

async function exchangeCode(c: Ctx, f: URLSearchParams): Promise<Response> {
  // Single use, even when the rest fails.
  const code = await c.db
    .prepare('DELETE FROM oauth_codes WHERE hash = ? RETURNING client_id, redirect_uri, challenge, expires')
    .bind(await hashSecret(f.get('code') ?? ''))
    .first<{ client_id: string; redirect_uri: string; challenge: string; expires: number }>();
  if (!code || Date.now() > code.expires || code.client_id !== f.get('client_id') || code.redirect_uri !== f.get('redirect_uri')) {
    return oauthError(400, 'invalid_grant', 'unknown, expired or mismatched code');
  }
  if (!(await safeEqual(b64url(await sha256(f.get('code_verifier') ?? '')), code.challenge))) {
    return oauthError(400, 'invalid_grant', 'PKCE verification failed');
  }
  const client = await getClient(c, code.client_id);
  if (!client) return oauthError(400, 'invalid_client', 'client no longer registered');
  return issueTokens(c, client, '');
}

async function refreshToken(c: Ctx, f: URLSearchParams): Promise<Response> {
  const want = await hashSecret(f.get('refresh_token') ?? '');
  const t = await c.db
    .prepare("SELECT client_id FROM tokens WHERE refresh_hash = ? AND refresh_hash != '' AND refresh_expires_at > ? AND client_id = ?")
    .bind(want, new Date().toISOString(), f.get('client_id') ?? '')
    .first<{ client_id: string }>();
  const client = t ? await getClient(c, t.client_id) : null;
  if (!client) return oauthError(400, 'invalid_grant', 'unknown or expired refresh token');
  return issueTokens(c, client, want);
}

/** issueTokens creates (or rotates) the one token record a client has. */
async function issueTokens(c: Ctx, client: Client, oldRefresh: string): Promise<Response> {
  const access = 'vt_' + b64url(randomBytes(24));
  const refresh = 'vr_' + b64url(randomBytes(32));
  const now = Date.now();
  const [hash, rhash] = await Promise.all([hashSecret(access), hashSecret(refresh)]);
  const exp = new Date(now + ACCESS_TTL).toISOString();
  const rexp = new Date(now + REFRESH_TTL).toISOString();
  const set = 'hash = ?2, prefix = ?3, expires_at = ?4, refresh_hash = ?5, refresh_expires_at = ?6';
  const args = [client.id, hash, access.slice(0, 7), exp, rhash, rexp];
  if (oldRefresh) {
    // Rotation is atomic: only one request can swap out a given refresh token.
    const r = await c.db.prepare(`UPDATE tokens SET ${set} WHERE client_id = ?1 AND refresh_hash = ?7`).bind(...args, oldRefresh).run();
    if (!r.meta.changes) throw new HttpError(400, 'refresh token was already used');
  } else {
    const r = await c.db.prepare(`UPDATE tokens SET ${set} WHERE client_id = ?1`).bind(...args).run();
    if (!r.meta.changes) {
      const ins = await c.db
        .prepare(`INSERT INTO tokens (id, name, hash, prefix, created_at, expires_at, client_id, refresh_hash, refresh_expires_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM tokens) < ${MAX_TOKENS}`)
        .bind(newID(5), client.name + ' (OAuth)', hash, access.slice(0, 7), new Date(now).toISOString(), exp, client.id, rhash, rexp)
        .run();
      if (!ins.meta.changes) throw new HttpError(400, 'too many tokens; delete some in Settings');
    }
  }
  return json(200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'mcp' });
}
