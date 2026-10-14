import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { validRedirect } from '../src/oauth';
import { b64url, sha256 } from '../src/util';
import { CONTENT, Client, body, fresh } from './helpers';

const PUB = 'https://art.example.com';
const SETUP = 'test-setup-token-0123456789';
const vars = { PUBLIC_URL: PUB, CONTENT_URL: '' };

beforeAll(fresh);

describe('MCP OAuth (port of TestMCPOAuthFlow)', () => {
  it('discovers, registers, consents, exchanges with PKCE, refreshes and rotates', async () => {
    const c = new Client(vars);
    const at = (p: string) => PUB + p;
    // 1. Discovery: /mcp challenges with the resource metadata URL.
    const ch = await c.fetch(at('/mcp'), { method: 'POST', body: '{}' });
    expect(ch.status).toBe(401);
    expect(ch.headers.get('WWW-Authenticate')).toBe(`Bearer realm="9artifacts", resource_metadata="${PUB}/.well-known/oauth-protected-resource"`);
    expect(ch.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');
    const prm = await body(await c.fetch(at('/.well-known/oauth-protected-resource')));
    expect(prm).toEqual({ resource: PUB + '/mcp', authorization_servers: [PUB], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: '9artifacts' });
    expect((await body(await c.fetch(at('/.well-known/oauth-protected-resource/mcp')))).resource).toBe(PUB + '/mcp');
    const asm = await body(await c.fetch(at('/.well-known/oauth-authorization-server')));
    expect(asm.token_endpoint).toBe(PUB + '/oauth/token');
    expect(asm.code_challenge_methods_supported).toEqual(['S256']);

    // 2. Dynamic registration.
    const reg = (b: unknown) => c.fetch(at('/oauth/register'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    expect((await reg({ redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    expect((await body(await reg({ redirect_uris: [] }))).error).toBe('invalid_redirect_uri');
    const redirect = 'https://claude.ai/api/mcp/auth_callback';
    const r = await reg({ client_name: 'Claude', redirect_uris: [redirect] });
    expect(r.status).toBe(201);
    const client = await body(r);
    expect(client).toMatchObject({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
    expect(client.client_id).toMatch(/^vc_[a-z2-7]{20}$/);

    // 3. Consent, as the signed-in owner (passkey-only edition: the setup token recovers a session).
    const login = await c.fetch(at('/api/auth/login'), { method: 'POST', body: JSON.stringify({ password: SETUP }) });
    c.keepCookie(login);
    const info = await c.fetch(at(`/api/oauth/client?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}`), { headers: { Cookie: c.cookie } });
    expect(await body(info)).toEqual({ name: 'Claude', redirectHost: 'claude.ai' });
    const verifier = 'a-long-random-pkce-verifier-string-0123456789abcdef';
    const challenge = b64url(await sha256(verifier));
    const decide = async (approve: boolean, redirectURI: string, extra: Record<string, unknown> = {}) => {
      const resp = await c.fetch(at('/api/oauth/authorize'), {
        method: 'POST',
        headers: { Cookie: c.cookie, 'X-9artifacts': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: client.client_id, redirect_uri: redirectURI, state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code', approve, ...extra }),
      });
      return { status: resp.status, redirect: (await body(resp)).redirect as string };
    };
    expect((await decide(true, 'https://evil.example/cb')).status).toBe(400);
    const deny = await decide(false, redirect);
    expect(deny.redirect).toBe(`${redirect}?error=access_denied&iss=${encodeURIComponent(PUB)}&state=xyz`);
    expect((await decide(true, redirect, { code_challenge_method: 'plain' })).redirect).toContain('error=invalid_request');
    expect((await decide(true, redirect, { resource: 'https://other.example/mcp' })).redirect).toContain('error=invalid_target');
    const noSession = await c.fetch(at('/api/oauth/authorize'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(noSession.status).toBe(401);
    const ok = new URL((await decide(true, redirect, { resource: PUB + '/mcp' })).redirect);
    const code = ok.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(ok.searchParams.get('state')).toBe('xyz');
    expect(ok.searchParams.get('iss')).toBe(PUB);

    // 4. Token exchange (PKCE).
    const token = async (form: Record<string, string>) => {
      const resp = await c.fetch(at('/oauth/token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
      return { status: resp.status, b: await body(resp), cache: resp.headers.get('Cache-Control') };
    };
    const exchange = { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirect };
    expect((await token({ ...exchange, code_verifier: 'wrong' })).status).toBe(400);
    // The failed attempt burned the code; get a fresh one.
    exchange.code = new URL((await decide(true, redirect)).redirect).searchParams.get('code')!;
    const t1 = await token({ ...exchange, code_verifier: verifier });
    expect(t1.status).toBe(200);
    expect(t1.cache).toBe('no-store');
    expect(t1.b).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(t1.b.access_token).toMatch(/^vt_/);
    expect(t1.b.refresh_token).toMatch(/^vr_/);
    expect((await token({ ...exchange, code_verifier: verifier })).status).toBe(400);
    expect((await token({ grant_type: 'password' })).b.error).toBe('unsupported_grant_type');

    // 5. The access token works for MCP, and shows up in Settings as an OAuth token.
    const call = async (access: string) =>
      (await c.fetch(at('/mcp'), { method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).status;
    expect(await call(t1.b.access_token)).toBe(200);
    const tokens = await body<any[]>(await c.fetch(at('/api/tokens'), { headers: { Cookie: c.cookie } }));
    expect(tokens).toEqual([expect.objectContaining({ name: 'Claude (OAuth)', oauth: true })]);

    // 6. Refresh rotates; the old refresh token stops working.
    const refresh = (rt: string) => token({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id });
    const t2 = await refresh(t1.b.refresh_token);
    expect(t2.status).toBe(200);
    expect(t2.b.access_token).not.toBe(t1.b.access_token);
    expect((await refresh(t1.b.refresh_token)).status).toBe(400);
    expect(await call(t1.b.access_token)).toBe(401);
    expect(await call(t2.b.access_token)).toBe(200);
    // Still one token record per client.
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM tokens').first('n')).toBe(1);

    // 7. CORS preflight for browser clients.
    for (const p of ['/oauth/token', '/oauth/register', '/mcp']) {
      const pre = await c.fetch(at(p), { method: 'OPTIONS' });
      expect(pre.status, p).toBe(204);
      expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Mcp-Protocol-Version');
    }

    // 8. Expired access tokens are rejected.
    await env.DB.prepare('UPDATE tokens SET expires_at = ?').bind(new Date(Date.now() - 1000).toISOString()).run();
    expect(await call(t2.b.access_token)).toBe(401);
  });

  it('serves the consent page from the SPA and keeps OAuth off the content host', async () => {
    const c = new Client({ PUBLIC_URL: 'http://localhost:8080', CONTENT_URL: CONTENT });
    const page = await c.fetch('/oauth/authorize?client_id=x&redirect_uri=y');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="view-consent"');
    for (const p of ['/.well-known/oauth-authorization-server', '/oauth/authorize']) expect((await c.fetch(CONTENT + p)).status, p).toBe(404);
  });

  it('accepts only https or loopback http redirect URIs', () => {
    expect(validRedirect('https://claude.ai/cb')).toBe(true);
    expect(validRedirect('http://localhost:6274/cb')).toBe(true);
    expect(validRedirect('http://127.0.0.1/cb')).toBe(true);
    expect(validRedirect('http://[::1]:3000/cb')).toBe(true);
    for (const bad of ['http://evil.example/cb', 'https://x/cb#frag', 'javascript:alert(1)', 'not a url', 'myapp://cb']) expect(validRedirect(bad), bad).toBe(false);
  });
});
