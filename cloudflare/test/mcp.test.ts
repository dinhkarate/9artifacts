import { beforeAll, describe, expect, it } from 'vitest';
import { Client, body, fresh, makeToken, pathOf } from './helpers';

let c: Client;
let seq = 1;

async function rpc(method: string, params?: unknown) {
  const r = await c.fetch('/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: seq++, method, params }),
  });
  expect(r.status).toBe(200);
  return body(r);
}

async function tool(name: string, args: Record<string, unknown>) {
  const r = await rpc('tools/call', { name, arguments: args });
  return { text: r.result.content[0].text as string, isError: Boolean(r.result.isError) };
}

beforeAll(async () => {
  await fresh();
  c = new Client(undefined, await makeToken());
});

describe('MCP', () => {
  it('requires a bearer token', async () => {
    const r = await c.fetch('/mcp', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('WWW-Authenticate')).toBe('Bearer realm="vitrine"');
  });

  it('initializes and echoes the protocol version', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.serverInfo).toEqual({ name: 'vitrine', version: 'cf-0.1.0' });
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result.instructions).toContain('get_design_guide');
    expect((await rpc('initialize', {})).result.protocolVersion).toBe('2025-06-18');
    expect((await rpc('ping')).result).toEqual({});
  });

  it('lists the same tools as the Go server', async () => {
    const r = await rpc('tools/list');
    expect(r.result.tools.map((t: any) => t.name)).toEqual([
      'get_design_guide', 'publish_artifact', 'list_artifacts', 'read_artifact', 'share_artifact', 'revoke_share', 'restore_version', 'delete_artifact',
    ]);
    const publish = r.result.tools[1];
    expect(publish.inputSchema.required).toEqual(['files']);
    expect(publish.inputSchema.properties.files.items.required).toEqual(['name', 'content']);
  });

  it('notifications get 202, batches and parse errors follow JSON-RPC', async () => {
    const h = { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' };
    const note = await c.fetch('/mcp', { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.status).toBe(202);
    const batch = await c.fetch('/mcp', {
      method: 'POST', headers: h,
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'nope' }]),
    });
    const out = await body<any[]>(batch);
    expect(out).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'method not found: nope' } },
    ]);
    const bad = await body(await c.fetch('/mcp', { method: 'POST', headers: h, body: '{nope' }));
    expect(bad).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  });

  it('publishes, updates, reads, lists, shares, restores and deletes', async () => {
    const guide = await tool('get_design_guide', {});
    expect(guide.text).toContain('# Starter template (template.html)');

    const pub = await tool('publish_artifact', {
      title: 'Agent dashboard', tags: ['Ops'],
      files: [{ name: 'index.html', content: '<h1>v1</h1><link rel=stylesheet href=style.css>' }, { name: 'style.css', content: 'h1{}' }],
    });
    expect(pub.isError).toBe(false);
    const m = /^Published "Agent dashboard" \(id ([a-z2-7]+), version 1\)\.\nPrivate URL \(owner login required\): http:\/\/localhost:8080\/a\/\1$/.exec(pub.text);
    expect(m, pub.text).not.toBeNull();
    const id = m![1];

    // New version with only the changed file: style.css is kept.
    const v2 = await tool('publish_artifact', { id, files: [{ name: 'index.html', content: '<h1>v2</h1>' }], message: 'retitle' });
    expect(v2.text).toContain(`(id ${id}, version 2)`);
    const a = await body(await c.api('GET', `/api/artifacts/${id}`));
    expect(a.files.map((f: any) => f.name).sort()).toEqual(['index.html', 'style.css']);
    expect(await (await c.fetch(pathOf(a.viewBase) + 'style.css')).text()).toBe('h1{}');

    const read = await tool('read_artifact', { id });
    expect(read.text).toBe('Artifact "Agent dashboard" v2, file index.html (files: index.html, style.css)\n\n<h1>v2</h1>');
    const readOld = await tool('read_artifact', { id, version: 1, file: 'style.css' });
    expect(readOld.text).toContain('h1{}');
    const missing = await tool('read_artifact', { id, file: 'nope.css' });
    expect(missing).toEqual({ text: 'Error: no file "nope.css"; files: index.html, style.css', isError: true });

    const list = await tool('list_artifacts', { tag: 'OPS' });
    expect(list.text).toMatch(new RegExp(`^- ${id} — "Agent dashboard" v2 \\[ops\\] updated \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d http://localhost:8080/a/${id}\\n$`));
    expect((await tool('list_artifacts', { query: 'zzz' })).text).toBe('No artifacts found.');

    const share = await tool('share_artifact', { id, ttl: '1h', max_views: 2 });
    const sm = /^Public link \(expires \d{4}-\d\d-\d\d \d\d:\d\d UTC\): (http:\/\/localhost:8080\/s\/(\S+))\nRevoke token: \2$/.exec(share.text);
    expect(sm, share.text).not.toBeNull();
    expect((await new Client().fetch(sm![1])).status).toBe(200);
    expect((await tool('revoke_share', { id, token: sm![2] })).text).toBe('Share revoked.');
    expect((await new Client().fetch(sm![1])).status).toBe(410);

    const restored = await tool('restore_version', { id, version: 1 });
    expect(restored.text).toBe(`Restored v1 as v3: http://localhost:8080/a/${id}`);
    expect((await tool('read_artifact', { id })).text).toContain('<h1>v1</h1>');

    // replace_all_files drops files not sent.
    await tool('publish_artifact', { id, files: [{ name: 'only.md', content: '# Only' }], replace_all_files: true });
    const after = await body(await c.api('GET', `/api/artifacts/${id}`));
    expect(after.files.map((f: any) => f.name)).toEqual(['only.md']);

    expect((await tool('delete_artifact', { id })).text).toBe('Artifact deleted.');
    expect((await tool('delete_artifact', { id })).isError).toBe(true);
    expect((await tool('publish_artifact', { id, files: [{ name: 'a.html', content: 'x' }] })).text).toBe('Error: artifact not found');
  });

  it('reports tool errors as isError results', async () => {
    expect(await tool('publish_artifact', { files: [{ name: '../x', content: 'x' }] })).toMatchObject({ isError: true });
    expect(await tool('publish_artifact', { files: [] })).toEqual({ text: 'Error: no files uploaded', isError: true });
    expect(await tool('frobnicate', {})).toEqual({ text: 'Error: unknown tool "frobnicate"', isError: true });
    const bin = await tool('publish_artifact', { files: [{ name: 'x.png', content: 'iVBORw0KGgo=', encoding: 'base64' }] });
    const id = /id ([a-z2-7]+)/.exec(bin.text)![1];
    expect((await tool('read_artifact', { id })).text).toBe('Error: x.png is binary (8 bytes)');
  });
});
