import { beforeAll, describe, expect, it } from 'vitest';
import { htmlText } from '../src/text';
import { Client, body, fresh, makeToken } from './helpers';

// The same fixture is in internal/app/server_test.go.
const FIXTURE = `<!doctype html><html><head><title>T</title><style>.x{}</style></head><body><main>
<h1>Gateway &amp; friends</h1><p>Hello <b>world</b>,<br>second line. <a href="https://example.com/x">docs</a></p>
<ul><li>one<li>two <code>x=1</code></ul>
<table><tr><th>Item<th>Value</tr><tr><td>A</td><td>42</td></tr></table>
<pre>  keep
    indent</pre>
<div class="d"><div class="flow">
<div class="node" tabindex="0"><i class="led"></i><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><div class="n">Client</div><div class="a">10.0.0.1</div><div class="tip"><b>Caller</b>Sends requests.<code>POST /v1</code></div></div>
<div class="link live"><span class="lbl">HTTPS</span><span class="line"><i class="pkt"></i></span><div class="tip">TLS ends here.</div></div>
<div class="node mark"><i class="led warn"></i><div class="n">Gateway</div></div>
</div><div class="drop live"><span class="line"></span></div>
<div class="flow end"><div class="node bad"><div class="n">Primary</div></div><div class="link down"><span class="lbl">cut</span><span class="line"></span></div><div class="node"><div class="n">Router</div></div></div>
<div class="legend"><span><i class="led"></i>up</span></div></div>
<section class="slide"><h2>Next</h2><script>var hidden = "<p>no</p>"</script></section>
</main></body></html>`;

const WANT =
  '# Gateway & friends\n\nHello world,\nsecond line. docs (https://example.com/x)\n\n- one\n- two `x=1`\n\nItem | Value\nA | 42\n\n```\n  keep\n    indent\n```\n\n' +
  'Diagram nodes:\n- Client (10.0.0.1) [up]: Caller: Sends requests. `POST /v1`\n- Gateway [degraded, focus]\n- Primary [down]\n- Router\n\n' +
  'Diagram links:\n- Client → Gateway [live] "HTTPS": TLS ends here.\n- Primary → Router [down] "cut"\n- Gateway → Router [live]\n\n[Slide 1]\n\n## Next';

let owner: Client;

beforeAll(async () => {
  await fresh();
  owner = new Client(undefined, await makeToken());
});

describe('text form for agents', () => {
  it('renders a page like the Go server', () => {
    expect(htmlText(FIXTURE)).toBe(WANT);
  });

  it('serves artifacts and share links as text', async () => {
    const a = await body(await owner.upload('/api/artifacts', { title: 'Weekly' }, { 'index.html': '<h1>Revenue</h1><p>Up 4%</p>' }));
    for (const p of [`/api/artifacts/${a.id}/text`, `/a/${a.id}`]) {
      const r = await owner.fetch(p, { headers: { Accept: 'text/markdown', Authorization: 'Bearer ' + owner.token } });
      expect(r.status, p).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
      const text = await r.text();
      expect(text).toContain('# Weekly\n');
      expect(text).toContain('# Revenue\n\nUp 4%');
    }
    const anon = new Client();
    expect((await anon.fetch(`/a/${a.id}`, { headers: { Accept: 'text/markdown' } })).status).toBe(401);
    expect((await anon.fetch(`/a/${a.id}`)).headers.get('Content-Type')).toContain('text/html');

    // One view even when the agent looks like a preview bot.
    const sh = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h', maxViews: 1 }));
    const first = await anon.fetch(`/s/${sh.token}?format=md`, { headers: { 'User-Agent': 'Slackbot 1.0' } });
    expect(first.status).toBe(200);
    const shared = await first.text();
    expect(shared).toContain('Up 4%');
    expect(shared).toContain('Shared link, expires');
    expect((await new Client().fetch(`/s/${sh.token}`, { headers: { Accept: 'text/markdown' } })).status).toBe(410);

    const pw = await body(await owner.api('POST', `/api/artifacts/${a.id}/shares`, { ttl: '1h', password: 'hunter22' }));
    const locked = await anon.fetch(`/s/${pw.token}?format=md`);
    expect(locked.status).toBe(401);
    expect(await locked.text()).not.toContain('Weekly');

    const llms = await anon.fetch('/llms.txt');
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain('/api/artifacts/{id}/text');
  });
});
