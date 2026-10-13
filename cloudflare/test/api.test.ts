import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client, body, fresh, makeToken, pathOf } from './helpers';

let c: Client;

beforeAll(async () => {
  await fresh();
  c = new Client(undefined, await makeToken());
});

describe('token auth', () => {
  it('rejects missing, malformed and unknown tokens', async () => {
    expect((await c.fetch('/api/artifacts')).status).toBe(401);
    expect((await c.fetch('/api/artifacts', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await c.fetch('/api/artifacts', { headers: { Authorization: 'Bearer vt_unknown' } })).status).toBe(401);
    const r = await c.api('GET', '/api/artifacts');
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ artifacts: [], tags: {} });
  });

  it('records lastUsedAt', async () => {
    const row = await env.DB.prepare('SELECT last_used_at FROM tokens LIMIT 1').first<{ last_used_at: string }>();
    expect(row?.last_used_at).toMatch(/^\d{4}-/);
  });
});

describe('publish, list, get, versions, restore, delete', () => {
  let id = '';

  it('publishes multipart with sub-folders, title from <title>, normalized tags', async () => {
    const r = await c.upload('/api/artifacts', { tags: 'Finance, q3' }, {
      'index.html': '<title>Q3 &amp; report</title><link rel=stylesheet href=assets/site.css>',
      'assets/site.css': 'body{}',
    });
    expect(r.status).toBe(201);
    const a = await body(r);
    id = a.id;
    expect(id).toMatch(/^[a-z2-7]{13}$/);
    expect(a.title).toBe('Q3 & report');
    expect(a.tags).toEqual(['finance', 'q3']);
    expect(a.version).toBe(1);
    expect(a.entry).toBe('index.html');
    expect(a.url).toBe('http://localhost:8080/a/' + id);
    expect(a.files).toEqual([
      { name: 'index.html', size: 72, type: 'text/html; charset=utf-8' },
      { name: 'assets/site.css', size: 6, type: 'text/css; charset=utf-8' },
    ]);
    expect(a.size).toBe(78);
    expect(a.viewBase).toMatch(new RegExp(`^http://localhost:8080/c/${id}\\.1\\.[0-9a-z]+\\.[A-Za-z0-9_-]{24}/$`));
    expect(a.versions).toHaveLength(1);
    expect(a.shares).toEqual([]);
    expect(a.activeShares).toBe(0);
    expect(Object.keys(a)).toEqual(['id', 'title', 'tags', 'note', 'pinned', 'createdAt', 'updatedAt', 'url', 'version', 'entry', 'files', 'size', 'viewBase', 'versions', 'shares', 'activeShares', 'openComments']);
  });

  it('serves the files through the view token', async () => {
    const a = await body(await c.api('GET', `/api/artifacts/${id}`));
    const css = await c.fetch(pathOf(a.viewBase) + 'assets/site.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(await css.text()).toBe('body{}');
    const entry = await c.fetch(pathOf(a.viewBase));
    expect(await entry.text()).toContain('<title>');
  });

  it('publishes JSON (utf8 + base64) and guesses a Markdown title', async () => {
    const r = await c.api('POST', '/api/artifacts', {
      tags: ['Team Notes'],
      note: 'private',
      files: [
        { name: 'notes.md', content: '# Weekly report\n\nhello' },
        { name: 'img/dot.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
      ],
    });
    expect(r.status).toBe(201);
    const a = await body(r);
    expect(a.title).toBe('Weekly report');
    expect(a.entry).toBe('notes.md');
    expect(a.tags).toEqual(['team-notes']);
    expect(a.note).toBe('private');
    expect(a.files[1]).toEqual({ name: 'img/dot.png', size: 8, type: 'image/png' });
  });

  it('lists newest first with tag counts, search and filters', async () => {
    const all = await body(await c.api('GET', '/api/artifacts'));
    expect(all.artifacts.map((a: any) => a.title)).toEqual(['Weekly report', 'Q3 & report']);
    expect(all.tags).toEqual({ finance: 1, q3: 1, 'team-notes': 1 });
    expect(all.artifacts[0].versions).toBeUndefined();
    expect(all.artifacts[0].shares).toEqual([]);
    const tagged = await body(await c.api('GET', '/api/artifacts?tag=finance'));
    expect(tagged.artifacts.map((a: any) => a.id)).toEqual([id]);
    const q = await body(await c.api('GET', '/api/artifacts?q=PRIVATE'));
    expect(q.artifacts.map((a: any) => a.title)).toEqual(['Weekly report']);
    const lim = await body(await c.api('GET', '/api/artifacts?limit=1'));
    expect(lim.artifacts).toHaveLength(1);
  });

  it('pins and patches metadata', async () => {
    const r = await c.api('PATCH', `/api/artifacts/${id}`, { pinned: true, title: 'Q3', tags: ['A', 'b'] });
    expect(r.status).toBe(200);
    const a = await body(r);
    expect([a.pinned, a.title, a.tags]).toEqual([true, 'Q3', ['a', 'b']]);
    const all = await body(await c.api('GET', '/api/artifacts'));
    expect(all.artifacts[0].id).toBe(id);
    expect((await c.api('PATCH', '/api/artifacts/nope', { title: 'x' })).status).toBe(404);
    expect((await c.api('PATCH', `/api/artifacts/${id}`, { title: 5 })).status).toBe(400);
  });

  it('adds a version with keep, keeping the URL and unchanged files', async () => {
    const r = await c.upload(`/api/artifacts/${id}/versions`, { keep: '1', message: 'new colours' }, { 'assets/site.css': 'body{color:red}' });
    expect(r.status).toBe(201);
    const a = await body(r);
    expect(a.version).toBe(2);
    expect(a.url).toBe('http://localhost:8080/a/' + id);
    expect(a.entry).toBe('index.html');
    expect(a.files.map((f: any) => f.name)).toEqual(['assets/site.css', 'index.html']);
    expect(a.versions.map((v: any) => [v.n, v.message])).toEqual([[2, 'new colours'], [1, undefined]]);
    const v2 = a.versions[0];
    expect(await (await c.fetch(pathOf(v2.viewBase) + 'assets/site.css')).text()).toBe('body{color:red}');
    // index.html was kept: it is served from v1's object.
    expect(await (await c.fetch(pathOf(v2.viewBase) + 'index.html')).text()).toContain('Q3 &amp; report');
    // v1 still serves the old CSS.
    expect(await (await c.fetch(pathOf(a.versions[1].viewBase) + 'assets/site.css')).text()).toBe('body{}');
  });

  it('replaces all files without keep', async () => {
    const a = await body(await c.upload(`/api/artifacts/${id}/versions`, {}, { 'page.html': '<p>v3</p>' }));
    expect(a.version).toBe(3);
    expect(a.files.map((f: any) => f.name)).toEqual(['page.html']);
    expect(a.entry).toBe('page.html');
  });

  it('restores an old version as the new latest', async () => {
    const r = await c.api('POST', `/api/artifacts/${id}/versions/1/restore`);
    expect(r.status).toBe(201);
    const a = await body(r);
    expect(a.version).toBe(4);
    expect(a.versions[0].message).toBe('Restored from v1');
    expect(a.files.map((f: any) => f.name)).toEqual(['index.html', 'assets/site.css']);
    expect(await (await c.fetch(pathOf(a.viewBase) + 'assets/site.css')).text()).toBe('body{}');
    expect((await c.api('POST', `/api/artifacts/${id}/versions/9/restore`)).status).toBe(404);
    expect((await c.api('POST', `/api/artifacts/${id}/versions/x/restore`)).status).toBe(400);
  });

  it('downloads a file of a given version as an attachment', async () => {
    const r = await c.api('GET', `/api/artifacts/${id}/download/assets/site.css?v=2`);
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Disposition')).toBe('attachment; filename="site.css"');
    expect(r.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(r.headers.get('Content-Security-Policy')).toMatch(/^sandbox /);
    expect(await r.text()).toBe('body{color:red}');
  });

  it('deletes the artifact, its rows and its R2 objects', async () => {
    expect((await c.api('DELETE', `/api/artifacts/${id}`)).status).toBe(200);
    expect((await c.api('GET', `/api/artifacts/${id}`)).status).toBe(404);
    expect((await c.api('DELETE', `/api/artifacts/${id}`)).status).toBe(404);
    expect((await env.FILES.list({ prefix: `artifacts/${id}/` })).objects).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM versions WHERE artifact_id = ?').bind(id).first('n')).toBe(0);
  });
});

describe('upload validation', () => {
  it('rejects bad names, duplicates, empty uploads and wrong content types', async () => {
    const before = (await env.FILES.list()).objects.length;
    for (const name of ['../x.html', 'a/../../b', '.env', 'a\u0000b', 'x/'.repeat(9) + 'y']) {
      const r = await c.api('POST', '/api/artifacts', { files: [{ name, content: 'x' }] });
      expect(r.status, name).toBe(400);
    }
    const dup = await c.api('POST', '/api/artifacts', { files: [{ name: 'a.html', content: '1' }, { name: './a.html', content: '2' }] });
    expect((await body(dup)).error).toBe('duplicate file "a.html"');
    expect((await body(await c.api('POST', '/api/artifacts', { files: [] }))).error).toBe('no files uploaded');
    const bad = await c.api('POST', '/api/artifacts', { files: [{ name: 'a.bin', content: '!!', encoding: 'base64' }] });
    expect((await body(bad)).error).toBe('file "a.bin": invalid base64');
    const txt = await c.fetch('/api/artifacts', { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'text/plain' }, body: 'x' });
    expect(txt.status).toBe(400);
    // Nothing was left behind in R2 by the failed uploads.
    expect((await env.FILES.list()).objects).toHaveLength(before);
  });

  it('returns 413 over the multipart limit and cleans up', async () => {
    const before = (await env.FILES.list()).objects.length;
    const small = new Client({ PUBLIC_URL: 'http://localhost:8080', CONTENT_URL: '', MAX_UPLOAD_MB: '1' }, c.token);
    const r = await small.upload('/api/artifacts', {}, { 'a.html': 'ok', 'big.bin': new Uint8Array(1.5 * 1024 * 1024) });
    expect(r.status).toBe(413);
    expect((await body(r)).error).toMatch(/^upload too large: the limit is 1 MB/);
    expect((await env.FILES.list()).objects).toHaveLength(before);
  });

  it('streams a large file to R2 as a multipart upload', async () => {
    const big = new Uint8Array(17 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    // Delimiter-like bytes inside the file must not confuse the parser.
    big.set(new TextEncoder().encode('\r\n--not-the-boundary\r\n'), 1000);
    const r = await c.upload('/api/artifacts', { title: 'Big' }, { 'data.bin': big, 'index.html': '<p>x</p>' });
    expect(r.status).toBe(201);
    const a = await body(r);
    expect(a.files.find((f: any) => f.name === 'data.bin').size).toBe(big.length);
    const obj = await env.FILES.get(`artifacts/${a.id}/v1/data.bin`);
    const got = new Uint8Array(await obj!.arrayBuffer());
    expect(got.length).toBe(big.length);
    expect(got[1000 + 2]).toBe('-'.charCodeAt(0));
    expect(got.every((b, i) => b === big[i])).toBe(true);
    await c.api('DELETE', `/api/artifacts/${a.id}`);
  });

  it('keeps the file order of the Go server (files, file, files[] keys)', async () => {
    const fd = new FormData();
    fd.append('file', new File(['b'], 'b.html'));
    fd.append('files', new File(['a'], 'a.html'));
    const r = await c.fetch('/api/artifacts', { method: 'POST', headers: { Authorization: 'Bearer ' + c.token }, body: fd });
    const a = await body(r);
    expect(a.files.map((f: any) => f.name)).toEqual(['a.html', 'b.html']);
    expect(a.title).toBe('a');
    await c.api('DELETE', `/api/artifacts/${a.id}`);
  });
});
