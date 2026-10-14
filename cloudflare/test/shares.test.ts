import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP, CONTENT, Client, body, fresh, makeToken, pathOf } from './helpers';

let token = '';
let owner: Client;

async function publish(c: Client, files: Record<string, string> = { 'index.html': '<title>Shared</title><p>hi</p>' }) {
  return body(await c.upload('/api/artifacts', {}, files));
}

beforeAll(async () => {
  await fresh();
  token = await makeToken();
  owner = new Client(undefined, token);
});

afterEach(() => vi.restoreAllMocks());

describe('shares', () => {
  it('creates a link pinned to the current version and serves it', async () => {
    const a = await publish(owner);
    const r = await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '24h', note: 'for Bob' });
    expect(r.status).toBe(201);
    const sh = await body(r);
    expect(sh.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(sh.url).toBe(`${APP}/s/${sh.token}`);
    expect(sh.version).toBe(1);
    expect(sh.active).toBe(true);
    expect(sh.views).toBe(0);
    expect(sh.note).toBe('for Bob');
    expect(Date.parse(sh.expiresAt) - Date.parse(sh.createdAt)).toBe(24 * 3600e3);

    // A later version stays private: the link keeps showing v1.
    await owner.upload(`/api/artifacts/${a.id}/versions`, {}, { 'index.html': '<title>Secret v2</title>' });
    const visitor = new Client();
    const page = await visitor.fetch(`/s/${sh.token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<title>Shared</title>');
    expect(html).toContain('for Bob');
    expect(html).not.toContain('Secret v2');
    expect(html).toContain(`src="${APP}/s/${sh.token}/f/index.html"`);
    expect(page.headers.get('X-Frame-Options')).toBe('DENY');
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'none'");

    const file = await visitor.fetch(`/s/${sh.token}/f/index.html`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('<title>Shared</title><p>hi</p>');
    expect(file.headers.get('Content-Security-Policy')).toMatch(/^sandbox allow-scripts/);

    const full = await body(await owner.api('GET', `/api/artifacts/${a.id}`));
    expect(full.activeShares).toBe(1);
    expect(full.shares[0].views).toBe(1); // one visitor, counted once per hour
    expect(full.shares[0].lastViewedAt).toMatch(/^\d{4}-/);
  });

  it('validates ttl, maxViews, version and password length', async () => {
    const a = await publish(owner);
    const bad = async (b: unknown, status = 400) => expect((await owner.api('POST', `/api/artifacts/${a.id}/shares`, b)).status).toBe(status);
    await bad({ ttl: '2d' });
    await bad({ ttl: '1h', maxViews: -1 });
    await bad({ ttl: '1h', maxViews: 10001 });
    await bad({ ttl: '1h', password: 'abc' });
    await bad({ ttl: '1h', version: 7 }, 404);
    expect((await owner.api('POST', '/api/artifacts/nope/shares', { ttl: '1h' })).status).toBe(404);
    const def = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, {}));
    expect(Date.parse(def.expiresAt) - Date.parse(def.createdAt)).toBe(7 * 86400e3);
  });

  it('revoked links return 410 for the page and files', async () => {
    const a = await publish(owner);
    const sh = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h' }));
    expect((await owner.api('DELETE', `/api/artifacts/${a.id}/shares/${sh.token}`)).status).toBe(200);
    const v = new Client();
    expect((await v.fetch(`/s/${sh.token}`)).status).toBe(410);
    expect((await v.fetch(`/s/${sh.token}/f/index.html`)).status).toBe(410);
    expect(await (await v.fetch(`/s/${sh.token}`)).text()).toContain('This link is no longer available');
    expect((await owner.api('DELETE', `/api/artifacts/${a.id}/shares/unknown`)).status).toBe(404);
    expect((await v.fetch('/s/doesnotexist')).status).toBe(404);
    const full = await body(await owner.api('GET', `/api/artifacts/${a.id}`));
    expect(full.shares[0].revokedAt).toMatch(/^\d{4}-/);
    expect(full.shares[0].active).toBe(false);
  });

  it('expired links return 410', async () => {
    const a = await publish(owner);
    const sh = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h' }));
    await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE token = ?').bind(new Date(Date.now() - 1000).toISOString(), sh.token).run();
    expect((await new Client().fetch(`/s/${sh.token}`)).status).toBe(410);
    expect((await new Client().fetch(`/s/${sh.token}/f/index.html`)).status).toBe(410);
  });

  it('maxViews counts distinct visitors, who can come back', async () => {
    const a = await publish(owner);
    const sh = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h', maxViews: 2 }));
    expect(sh.maxViews).toBe(2);
    const [v1, v2, v3] = [new Client(), new Client(), new Client()];
    expect((await v1.fetch(`/s/${sh.token}`)).status).toBe(200);
    expect((await v1.fetch(`/s/${sh.token}/f/index.html`)).status).toBe(200);
    expect((await v2.fetch(`/s/${sh.token}/f/index.html`)).status).toBe(200);
    expect((await v3.fetch(`/s/${sh.token}`)).status).toBe(410);
    // Counted visitors can still come back.
    expect((await v1.fetch(`/s/${sh.token}`)).status).toBe(200);
    expect((await v2.fetch(`/s/${sh.token}`)).status).toBe(200);
    const full = await body(await owner.api('GET', `/api/artifacts/${a.id}`));
    expect(full.shares[0]).toMatchObject({ views: 2, maxViews: 2, active: false });
    // Only keyed hashes of addresses are stored.
    const rows = await env.DB.prepare('SELECT visitor FROM share_visitors WHERE token = ?').bind(sh.token).all<{ visitor: string }>();
    expect(rows.results).toHaveLength(2);
    for (const r of rows.results) expect(r.visitor).not.toContain('198.51.100');
  });

  it('link previews from chat apps do not use up a view', async () => {
    const a = await publish(owner);
    const sh = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h', maxViews: 1 }));
    const bot = new Client();
    const r = await bot.fetch(`/s/${sh.token}`, { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0' } });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<meta property="og:title" content="Shared">');
    expect((await new Client().fetch(`/s/${sh.token}`)).status).toBe(200);
  });

  it('password-protected links show nothing until unlocked, then serve via a grant', async () => {
    const a = await publish(owner);
    const sh = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h', password: 'open sesame' }));
    expect(sh.protected).toBe(true);
    const v = new Client();
    const locked = await v.fetch(`/s/${sh.token}`);
    expect(locked.status).toBe(401);
    const html = await locked.text();
    expect(html).toContain('Password required');
    expect(html).not.toContain('Shared');
    expect((await v.fetch(`/s/${sh.token}/f/index.html`)).status).toBe(401);

    const form = (pw: string) =>
      v.fetch(`/s/${sh.token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(pw) });
    const wrong = await form('nope');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Wrong password.');

    const ok = await form('open sesame');
    expect(ok.status).toBe(303);
    expect(ok.headers.get('Location')).toBe(`/s/${sh.token}`);
    const cookie = ok.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(new RegExp(`^9artifacts_share=[0-9a-z]+\\.[A-Za-z0-9_-]+; Path=/s/${sh.token}; Max-Age=7200; HttpOnly; SameSite=Lax$`));
    const page = await v.fetch(`/s/${sh.token}`, { headers: { Cookie: cookie.split(';')[0] } });
    expect(page.status).toBe(200);
    const src = /<iframe src="([^"]+)"/.exec(await page.text())![1];
    expect(src).toMatch(new RegExp(`/s/${sh.token}/g/[0-9a-z]+\\.[A-Za-z0-9_-]+/index.html$`));
    expect(await (await v.fetch(pathOf(src))).text()).toContain('hi');
    // A forged or foreign grant is refused.
    expect((await v.fetch(`/s/${sh.token}/g/zzzz.forged/index.html`)).status).toBe(401);
    // Revoking takes effect for grants at once.
    await owner.api('DELETE', `/api/artifacts/${a.id}/shares/${sh.token}`);
    expect((await v.fetch(pathOf(src))).status).toBe(410);
  });

  it('wrong share passwords are rate-limited per address', async () => {
    const a = await publish(owner);
    const sh = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h', password: 'right one' }));
    const v = new Client();
    const form = (pw: string) =>
      v.fetch(`/s/${sh.token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=' + pw });
    for (let i = 0; i < 5; i++) expect((await form('bad')).status).toBe(401);
    const r = await form('right+one');
    expect(r.status).toBe(429);
    expect(await r.text()).toContain('Too many attempts');
  });

  it('POST to an unprotected share page is 405', async () => {
    const a = await publish(owner);
    const sh = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h' }));
    expect((await new Client().fetch(`/s/${sh.token}`, { method: 'POST' })).status).toBe(405);
  });

  it('webhooks get publish, share and visit events without share tokens', async () => {
    const sent: { url: string; body: string; headers: Headers }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      sent.push({ url: req.url, body: await req.text(), headers: req.headers });
      return new Response('ok');
    });
    const hooked = new Client({ PUBLIC_URL: APP, CONTENT_URL: '', WEBHOOKS: 'https://hooks.example.com/abc ntfy+https://ntfy.sh/topic' }, token);
    const a = await publish(hooked);
    const sh = await body(await hooked.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '7d', maxViews: 3 }));
    const visitor = new Client(hooked.vars);
    await visitor.fetch(`/s/${sh.token}`);
    const json = sent.filter((s) => s.url === 'https://hooks.example.com/abc').map((s) => JSON.parse(s.body));
    expect(json.map((e) => e.event)).toEqual(['artifact.published', 'share.created', 'share.visited']);
    expect(json[1].text).toBe(`Public link created: "Shared" v1 (expires in 7d, max 3 viewers)\n${APP}/a/${a.id}`);
    expect(json[2].content).toBe(`Public link opened: "Shared" v1 (visitor 1 of 3)\n${APP}/a/${a.id}`);
    expect(json[0].artifact).toEqual({ id: a.id, title: 'Shared', url: `${APP}/a/${a.id}`, version: 1 });
    for (const s of sent) expect(s.body).not.toContain(sh.token);
    const ntfy = sent.filter((s) => s.url === 'https://ntfy.sh/topic');
    expect(ntfy).toHaveLength(3);
    expect(ntfy[0].body).toBe('New artifact: "Shared" v1');
    expect(ntfy[0].headers.get('Click')).toBe(`${APP}/a/${a.id}`);
  });
});

describe('shares on the content origin', () => {
  const vars = { PUBLIC_URL: APP, CONTENT_URL: CONTENT, SHARES_ON_CONTENT: '1' };

  it('serves share pages from the content host and redirects old links', async () => {
    const c = new Client(vars, token);
    const a = await publish(c);
    const sh = await body(await c.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h' }));
    expect(sh.url).toBe(`${CONTENT}/s/${sh.token}`);
    const old = await c.fetch(`${APP}/s/${sh.token}`);
    expect(old.status).toBe(308);
    expect(old.headers.get('Location')).toBe(`${CONTENT}/s/${sh.token}`);
    const page = await c.fetch(`${CONTENT}/s/${sh.token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`src="${CONTENT}/s/${sh.token}/f/index.html"`);
    // The content host still refuses the app.
    expect((await c.fetch(`${CONTENT}/api/me`)).status).toBe(404);
    expect((await c.fetch(`${CONTENT}/`)).status).toBe(404);
  });
});
