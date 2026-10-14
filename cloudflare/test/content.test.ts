import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkViewToken, viewToken } from '../src/content';
import { newCtx, resolveOrigins } from '../src/env';
import { redactPath } from '../src/index';
import { APP, CONTENT, Client, body, fresh, makeToken, pathOf } from './helpers';

const split = { PUBLIC_URL: APP, CONTENT_URL: CONTENT };
let token = '';

beforeAll(async () => {
  await fresh();
  token = await makeToken();
});

afterEach(() => vi.restoreAllMocks());

describe('content origin separation', () => {
  it('serves artifact bytes only on the content host, sandboxed', async () => {
    const c = new Client(split, token);
    const a = await body(await c.upload('/api/artifacts', {}, { 'index.html': '<script>alert(1)</script>', 'doc.pdf': '%PDF-1.4', 'notes.md': '# Hi\n\n<b>x</b>' }));
    expect(a.viewBase.startsWith(`${CONTENT}/c/`)).toBe(true);

    const html = await c.fetch(a.viewBase + 'index.html');
    expect(html.status).toBe(200);
    expect(html.headers.get('Content-Security-Policy')).toBe(
      `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads; frame-ancestors ${APP} 'self'`,
    );
    expect(html.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(html.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(html.headers.get('X-Frame-Options')).toBeNull(); // must be frameable by the app

    // PDFs cannot render sandboxed; they still only allow the app as ancestor.
    const pdf = await c.fetch(a.viewBase + 'doc.pdf');
    expect(pdf.headers.get('Content-Security-Policy')).toBe(`frame-ancestors ${APP} 'self'`);
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');

    // Markdown renders to escaped HTML with ?view=1.
    const md = await c.fetch(a.viewBase + 'notes.md?view=1');
    const mdText = await md.text();
    expect(md.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(md.headers.get('Content-Security-Policy')).toMatch(/^sandbox /);
    expect(mdText).toContain('<h1>Hi</h1>');
    expect(mdText).toContain('&lt;b&gt;x&lt;/b&gt;');

    // The same path on the app host is refused, and the content host refuses the app.
    expect((await c.fetch(APP + pathOf(a.viewBase) + 'index.html')).status).toBe(404);
    for (const p of ['/', '/api/me', '/mcp', '/settings', '/design.md']) expect((await c.fetch(CONTENT + p)).status, p).toBe(404);
    expect((await c.fetch(CONTENT + '/health')).status).toBe(200);
  });

  it('single-origin mode serves content from the app host, still sandboxed', async () => {
    const c = new Client({ PUBLIC_URL: APP, CONTENT_URL: '' }, token);
    const a = await body(await c.upload('/api/artifacts', {}, { 'index.html': '<p>x</p>' }));
    expect(a.viewBase.startsWith(`${APP}/c/`)).toBe(true);
    const r = await c.fetch(pathOf(a.viewBase));
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Security-Policy')).toMatch(/^sandbox /);
  });

  it('unknown extensions download as octet-stream; Range requests work', async () => {
    const c = new Client(split, token);
    const a = await body(await c.upload('/api/artifacts', {}, { 'index.html': 'x', 'evil.shtml': '<script>1</script>', 'clip.txt': '0123456789' }));
    const evil = await c.fetch(a.viewBase + 'evil.shtml');
    expect(evil.headers.get('Content-Type')).toBe('application/octet-stream');
    const part = await c.fetch(a.viewBase + 'clip.txt', { headers: { Range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(await part.text()).toBe('2345');
    const head = await c.fetch(a.viewBase + 'clip.txt', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('10');
    expect(await head.text()).toBe('');
    expect((await c.fetch(a.viewBase + 'missing.txt')).status).toBe(404);
    expect((await c.fetch(a.viewBase + '..%2F..%2Fsecret')).status).toBe(404);
  });

  it('the workers.dev auto mode derives the content Worker origin', () => {
    const e = { PUBLIC_URL: '', CONTENT_URL: 'auto' } as Env;
    expect(resolveOrigins(e, new URL('https://9artifacts.me.workers.dev/a/x'))).toEqual({
      publicURL: 'https://9artifacts.me.workers.dev', contentURL: 'https://9artifacts-content.me.workers.dev',
    });
    expect(resolveOrigins(e, new URL('https://9artifacts-content.me.workers.dev/c/x'))).toEqual({
      publicURL: 'https://9artifacts.me.workers.dev', contentURL: 'https://9artifacts-content.me.workers.dev',
    });
    expect(resolveOrigins(e, new URL('http://localhost:8787/'))).toEqual({ publicURL: 'http://localhost:8787', contentURL: '' });
    expect(resolveOrigins({ PUBLIC_URL: 'https://art.example.com', CONTENT_URL: 'https://art-content.example.com' } as Env, new URL('https://x/'))).toEqual({
      publicURL: 'https://art.example.com', contentURL: 'https://art-content.example.com',
    });
  });

  it('rejects a content URL on the app host', () => {
    const req = new Request('http://localhost:8080/');
    expect(() => newCtx(req, { ...env, PUBLIC_URL: APP, CONTENT_URL: APP + '/x' } as Env, {} as ExecutionContext)).toThrow(/different host/);
  });
});

describe('view tokens', () => {
  const ctx = () => newCtx(new Request(APP), { ...env, PUBLIC_URL: APP, CONTENT_URL: '' } as Env, { waitUntil() {} } as unknown as ExecutionContext);

  it('round-trips, rounds expiry up to the hour, and rejects tampering', async () => {
    const c = ctx();
    const now = Date.UTC(2026, 9, 13, 8, 20);
    const tok = await viewToken(c, 'abc', 3, now);
    const [id, n, exp, sig] = tok.split('.');
    expect([id, n]).toEqual(['abc', '3']);
    expect(parseInt(exp, 36)).toBe(Date.UTC(2026, 9, 13, 21, 0) / 1000);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await checkViewToken(c, await viewToken(c, 'abc', 3))).toEqual({ id: 'abc', n: 3 });
    expect(await checkViewToken(c, tok.replace('abc', 'abd'))).toBeNull();
    expect(await checkViewToken(c, `abc.4.${exp}.${sig}`)).toBeNull();
    expect(await checkViewToken(c, 'abc.3.' + exp)).toBeNull();
    expect(await checkViewToken(c, 'garbage')).toBeNull();
  });

  it('expired tokens are refused with a reload hint', async () => {
    const c = new Client({ PUBLIC_URL: APP, CONTENT_URL: '' }, token);
    const a = await body(await c.upload('/api/artifacts', {}, { 'index.html': 'x' }));
    const old = await viewToken(ctx(), a.id, 1, Date.now() - 14 * 3600e3);
    const r = await c.fetch(`/c/${old}/index.html`);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('link expired, reload the page\n');
    expect((await c.fetch(`/c/${await viewToken(ctx(), a.id, 1)}/index.html`)).status).toBe(200);
    expect((await c.fetch(`/c/${await viewToken(ctx(), a.id, 2)}/index.html`)).status).toBe(404);
  });
});

describe('security headers and logging', () => {
  it('app pages get a nonce CSP that matches the script tag', async () => {
    const c = new Client(split);
    const r = await c.fetch('/');
    expect(r.status).toBe(200);
    const csp = r.headers.get('Content-Security-Policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    const html = await r.text();
    expect(html).toContain(`<script type="module" src="/assets/app.js" nonce="${nonce}"></script>`);
    expect(csp).toBe(
      `default-src 'self'; script-src 'nonce-${nonce}'; img-src 'self' data: blob: ${CONTENT}; style-src 'self' 'unsafe-inline'; frame-src ${CONTENT} 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'`,
    );
    expect(r.headers.get('X-Frame-Options')).toBe('DENY');
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Strict-Transport-Security')).toBeNull();
    // Each response gets a new nonce.
    const again = (await c.fetch('/settings')).headers.get('Content-Security-Policy');
    expect(again).not.toContain(nonce);
  });

  it('the shell is adjusted for passkey-only sign-in', async () => {
    const html = await (await new Client().fetch('/login')).text();
    expect(html).toContain('<title>9artifacts</title>');
    expect(html).toContain('<input id="setup-pw" type="password" autocomplete="new-password" hidden="">');
    expect(html).toContain('Setup token <span class="muted">(the SETUP_TOKEN secret)</span>');
    expect(html).toContain('placeholder="Setup token"');
    expect(html).toContain('.settings .panel:has(input[autocomplete="current-password"]){display:none}');
  });

  it('HTTPS adds HSTS', async () => {
    const r = await new Client({ PUBLIC_URL: 'https://art.example.com', CONTENT_URL: '' }).fetch('https://art.example.com/health');
    expect(r.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(await body(r)).toEqual({ ok: true, version: 'cf-0.1.0' });
  });

  it('unknown paths 404 and wrong methods 405 with Allow', async () => {
    const c = new Client();
    expect((await c.fetch('/nope')).status).toBe(404);
    const r = await c.fetch('/api/me', { method: 'POST' });
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET, HEAD');
    const mcp = await c.fetch('/mcp');
    expect(mcp.status).toBe(405);
    expect(mcp.headers.get('Allow')).toBe('POST');
  });

  it('serves the design guide and template for agents', async () => {
    const c = new Client();
    const d = await c.fetch('/design.md');
    expect(d.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect((await d.text()).length).toBeGreaterThan(100);
    expect((await c.fetch('/template.html')).headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });

  it('never logs share, view or grant tokens', async () => {
    expect(redactPath('/s/SECRETTOKEN')).toBe('/s/…');
    expect(redactPath('/s/SECRETTOKEN/f/index.html')).toBe('/s/…/f/index.html');
    expect(redactPath('/s/SECRET/g/GRANT/x.css')).toBe('/s/…/g/…/x.css');
    expect(redactPath('/c/abc.1.x.SIG/index.html')).toBe('/c/…/index.html');
    expect(redactPath('/api/artifacts/abc/shares/SECRET')).toBe('/api/artifacts/abc/shares/…');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    const c = new Client({ PUBLIC_URL: APP, CONTENT_URL: '' }, token);
    const a = await body(await c.upload('/api/artifacts', {}, { 'index.html': 'x' }));
    const sh = await body(await c.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h' }));
    await c.fetch(`/s/${sh.token}`);
    await c.fetch(`/s/${sh.token}/f/index.html`);
    await c.fetch(pathOf(a.viewBase));
    await c.api('DELETE', `/api/artifacts/${a.id}/shares/${sh.token}`);
    const vt = pathOf(a.viewBase).split('/')[2];
    expect(lines.some((l) => l.startsWith('GET /s/… 200'))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain(sh.token);
      expect(l).not.toContain(vt);
    }
  });
});
