import { beforeAll, describe, expect, it } from 'vitest';
import { APP, CONTENT, Client, body, fresh, makeToken, pathOf } from './helpers';

let c: Client;

async function mcp(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await c.fetch('/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await body(r)).result.content[0].text;
}

beforeAll(async () => {
  await fresh();
  c = new Client(undefined, await makeToken('test'));
});

describe('review comments (port of TestCommentsRoundTrip)', () => {
  it('round-trips: add, list over MCP, publish reminder, resolve, delete', async () => {
    const a = await body(await c.upload('/api/artifacts', { title: 'Q3' }, { 'index.html': '<h1>Revenue</h1>' }));
    const r = await c.api('POST', `/api/artifacts/${a.id}/comments`, { body: 'Make the chart blue', quote: 'Revenue' });
    expect(r.status).toBe(201);
    const cm = await body(r);
    expect(cm).toMatchObject({ version: 1, file: 'index.html', author: 'agent: test', quote: 'Revenue', body: 'Make the chart blue' });
    expect(Object.keys(cm)).toEqual(['id', 'version', 'file', 'quote', 'body', 'author', 'createdAt']);
    expect((await c.api('POST', `/api/artifacts/${a.id}/comments`, { body: '  ' })).status).toBe(400);

    let got = await body(await c.api('GET', `/api/artifacts/${a.id}`));
    expect(got.openComments).toBe(1);
    expect(got.comments).toHaveLength(1);
    const list = await body(await c.api('GET', '/api/artifacts'));
    expect(list.artifacts[0].openComments).toBe(1);
    expect(list.artifacts[0].comments).toBeUndefined();

    const listed = await mcp('list_comments', { id: a.id });
    expect(listed).toBe(
      `Comments on "Q3" (latest v1):\n- [${cm.id}] v1 index.html (open, by agent: test)\n  on: "Revenue"\n  Make the chart blue\n\nFix them with publish_artifact (same id), then resolve_comment each one with a short note.`,
    );
    const pub = await mcp('publish_artifact', { id: a.id, files: [{ name: 'index.html', content: '<h1>Revenue</h1>' }] });
    expect(pub).toContain('\n1 open review comment(s): if this version addresses them, call resolve_comment; see list_comments.');

    expect(await mcp('resolve_comment', { id: a.id, comment_id: cm.id, note: 'Chart is blue now' })).toBe('Comment resolved.');
    got = await body(await c.api('GET', `/api/artifacts/${a.id}`));
    expect(got.openComments).toBe(0);
    expect(got.comments[0].resolution).toBe('Chart is blue now');
    expect(got.comments[0].resolvedAt).toMatch(/^\d{4}-/);
    expect(await mcp('list_comments', { id: a.id })).toBe('No open comments on "Q3" (latest v2).');
    expect(await mcp('list_comments', { id: a.id, include_resolved: true })).toContain('(resolved: Chart is blue now, by agent: test)');
    expect(await mcp('resolve_comment', { id: a.id, comment_id: 'nope' })).toBe('Error: comment not found');

    expect((await c.api('DELETE', `/api/artifacts/${a.id}/comments/${cm.id}`)).status).toBe(200);
    expect((await c.api('DELETE', `/api/artifacts/${a.id}/comments/${cm.id}`)).status).toBe(404);
    expect((await body(await c.api('GET', `/api/artifacts/${a.id}`))).comments).toBeUndefined();
  });

  it('the owner comments from the browser; bad versions and files are refused', async () => {
    const a = await body(await c.upload('/api/artifacts', {}, { 'index.html': 'x', 'b.md': '# b' }));
    expect((await c.api('POST', `/api/artifacts/${a.id}/comments`, { body: 'x', version: 9 })).status).toBe(400);
    expect((await c.api('POST', `/api/artifacts/${a.id}/comments`, { body: 'x', file: '../etc' })).status).toBe(400);
    expect((await c.api('POST', '/api/artifacts/nope/comments', { body: 'x' })).status).toBe(404);
    const onFile = await body(await c.api('POST', `/api/artifacts/${a.id}/comments`, { body: 'x', file: 'b.md', version: 1 }));
    expect(onFile.file).toBe('b.md');
    // Resolve over REST without a body (the SPA sends {}), and comments go with the artifact.
    expect((await c.fetch(`/api/artifacts/${a.id}/comments/${onFile.id}/resolve`, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token } })).status).toBe(200);
    await c.api('DELETE', `/api/artifacts/${a.id}`);
    expect(await mcp('list_comments', { id: a.id })).toBe('Error: artifact not found');
  });
});

describe('selection script (port of TestSelectionScriptOnlyInOwnerViewer)', () => {
  it('is injected only into the owner viewer HTML/Markdown', async () => {
    const a = await body(await c.upload('/api/artifacts', {}, { 'index.html': '<p>hi</p>', 'n.md': '# x', 'a.css': 'p{}' }));
    const base = pathOf(a.viewBase);
    const has = async (path: string) => (await (await c.fetch(path)).text()).includes('glasshelf:"selection"');
    expect(await has(base + 'index.html?vc=1')).toBe(true);
    expect(await has(base + 'n.md?view=1&vc=1')).toBe(true);
    const sh = await body(await c.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h' }));
    expect(await has(base + 'index.html')).toBe(false);
    expect(await has(base + 'index.html?vc=1&download=1')).toBe(false);
    expect(await has(base + 'a.css?vc=1')).toBe(false);
    expect(await has(`/s/${sh.token}/f/index.html?vc=1`)).toBe(false);
    const r = await c.fetch(base + 'index.html?vc=1');
    expect(r.headers.get('Content-Security-Policy')).toMatch(/^sandbox /);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.text()).toContain(`parent.postMessage({glasshelf:"selection",text:s},"${APP}")`);
  });

  it('posts to the app origin when content is on its own origin', async () => {
    const split = new Client({ PUBLIC_URL: APP, CONTENT_URL: CONTENT }, c.token);
    const a = await body(await split.upload('/api/artifacts', {}, { 'index.html': '<p>hi</p>' }));
    const text = await (await split.fetch(a.viewBase + 'index.html?vc=1')).text();
    expect(text.startsWith('<p>hi</p><script>')).toBe(true);
    expect(text).toContain(`},"${APP}")`);
  });
});
