import { beforeAll, describe, expect, it } from 'vitest';
import { APP, Client, body, fresh, makeToken } from './helpers';

const DEMO = { PUBLIC_URL: APP, CONTENT_URL: '', DEMO: '1' };

let owner: Client;
let visitor: Client;
let id = '';

beforeAll(async () => {
  await fresh();
  owner = new Client(DEMO, await makeToken());
  visitor = new Client(DEMO);
  const r = await owner.upload('/api/artifacts', { tags: 'demo', note: 'secret plan' }, { 'index.html': '<title>Q3 report</title>' });
  id = (await body(r)).id;
  await owner.api('POST', `/api/artifacts/${id}/shares`, { ttl: '1h' });
  await owner.api('POST', `/api/artifacts/${id}/comments`, { body: 'make the chart bigger' });
});

describe('DEMO=1', () => {
  it('says so in /api/me', async () => {
    const me = await body(await visitor.fetch('/api/me'));
    expect(me).toMatchObject({ demo: true, authenticated: false, needsSetup: false });
  });

  it('lets visitors read the gallery and artifacts without the note or share links', async () => {
    const list = await body(await visitor.fetch('/api/artifacts'));
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0]).toMatchObject({ id, title: 'Q3 report', note: '', activeShares: 0 });
    const a = await body(await visitor.fetch(`/api/artifacts/${id}`));
    expect(a).toMatchObject({ note: '', shares: [], activeShares: 0, openComments: 1 });
    expect(a.comments[0].body).toBe('make the chart bigger');
    expect((await visitor.fetch(`/api/artifacts/${id}/download/index.html`)).status).toBe(200);
  });

  it('does not let visitors search the private note', async () => {
    expect((await body(await visitor.fetch('/api/artifacts?q=secret'))).artifacts).toHaveLength(0);
    expect((await body(await owner.api('GET', '/api/artifacts?q=secret'))).artifacts).toHaveLength(1);
  });

  it('refuses every change from visitors', async () => {
    const tries: [string, string, unknown?][] = [
      ['POST', '/api/artifacts', { files: [{ name: 'index.html', content: 'x' }] }],
      ['PATCH', `/api/artifacts/${id}`, { title: 'pwned' }],
      ['DELETE', `/api/artifacts/${id}`],
      ['POST', `/api/artifacts/${id}/shares`, { ttl: '1h' }],
      ['POST', `/api/artifacts/${id}/comments`, { body: 'spam' }],
    ];
    for (const [method, path, payload] of tries) {
      const r = await visitor.browser(method, path, payload);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((await body(r)).error).toMatch(/read-only demo/);
    }
    expect((await body(await owner.api('GET', `/api/artifacts/${id}`))).title).toBe('Q3 report');
  });

  it('keeps account pages and MCP behind auth', async () => {
    expect((await visitor.browser('GET', '/api/tokens')).status).toBe(401);
    expect((await visitor.fetch('/mcp', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('still gives the owner everything', async () => {
    const a = await body(await owner.api('GET', `/api/artifacts/${id}`));
    expect(a).toMatchObject({ note: 'secret plan', activeShares: 1 });
    expect((await owner.api('PATCH', `/api/artifacts/${id}`, { pinned: true })).status).toBe(200);
  });
});

describe('without DEMO', () => {
  it('visitors still need to sign in', async () => {
    expect((await new Client().fetch('/api/artifacts')).status).toBe(401);
    expect((await body(await new Client().fetch('/api/me'))).demo).toBe(false);
  });
});
