import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SHARE_HTML } from '../src/generated/web';
import { cleanup } from '../src/index';
import { render, title } from '../src/markdown';
import { renderTemplate } from '../src/template';
import { cleanName, normTags } from '../src/util';
import { parseHeaderValue } from '../src/upload';

describe('markdown (port of internal/markdown tests)', () => {
  it('renders the everyday subset', () => {
    const src = '# Title\n\nSome **bold**, *em* and `code <b>`.\n\n- [x] done\n- todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```go\nfmt.Println("<hi>")\n```\n\n> quote\n\n![chart](assets/chart.png) [site](https://example.com)';
    const out = render(src);
    for (const want of [
      '<h1>Title</h1>', '<strong>bold</strong>', '<em>em</em>', '<code>code &lt;b&gt;</code>',
      '<li class="task"><input type="checkbox" disabled checked> done</li>', '<th>a</th>', '<td>2</td>',
      '<pre><code class="language-go">fmt.Println(&#34;&lt;hi&gt;&#34;)</code></pre>', '<blockquote><p>quote</p>',
      '<img src="assets/chart.png" alt="chart" loading="lazy">', '<a href="https://example.com"',
    ]) expect(out).toContain(want);
  });

  it('escapes HTML and unsafe schemes', () => {
    const out = render('<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![y](data:text/html,hi)');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text');
  });

  it('finds the title', () => expect(title('intro\n# Weekly report\n## x')).toBe('Weekly report'));

  it('prevents attribute injection', () => {
    const out = render('![ http://x/onerror=alert(1)//](http://y/a.png) [**b** `c`](https://e.com) http://a.b/?q="x"');
    expect(out).not.toContain('onerror="');
    expect(out.split('<a ').length - 1).toBe(2);
    expect(out).toContain('<strong>b</strong> <code>c</code></a>');
  });

  it('autolinks cannot swallow placeholders', () => {
    const out = render('http://x[t](http://y/onmouseover=alert(1)//)');
    expect(out).not.toContain('\x00');
    expect(out).not.toContain('onmouseover="');
    expect(out).not.toContain('href="http://x<a');
  });
});

describe('share.html via the Go-template subset', () => {
  const files = [{ Name: 'index.html', Href: 'https://c/s/t/f/index.html?download=1', Size: 2048 }];

  it('renders a live link with escaping', () => {
    const html = renderTemplate(SHARE_HTML, {
      Name: 'vitryn', Status: 200, Title: 'Q3 <script>', Note: 'a "note" & more', Kind: 'html', Src: 'https://c/s/t/f/index.html', Files: files, Expires: '2026-10-20 08:00 UTC',
    });
    expect(html).toContain('<title>Q3 &lt;script&gt;</title>');
    expect(html).toContain('<meta property="og:description" content="a &#34;note&#34; &amp; more">');
    expect(html).toContain('<summary class="btn ghost sm">Files (1)</summary>');
    expect(html).toContain('<span class="muted">2.0 KB</span>');
    expect(html).toContain('sandbox="allow-scripts');
    expect(html).not.toContain('{{');
  });

  it('renders the password form and the gone page', () => {
    expect(renderTemplate(SHARE_HTML, { Status: 401, Error: 'Wrong password.' })).toContain('<p class="auth-error" role="alert">Wrong password.</p>');
    const gone = renderTemplate(SHARE_HTML, { Status: 410 });
    expect(gone).toContain('This link is no longer available');
    expect(renderTemplate(SHARE_HTML, { Status: 404 })).toContain('Link not found');
  });
});

describe('validation helpers', () => {
  it('cleanName matches the Go rules', () => {
    expect(cleanName(' ./assets\\logo.png ')).toBe('assets/logo.png');
    expect(cleanName('My Report (final)+v2.html')).toBe('My Report (final)+v2.html');
    for (const bad of ['', '/abs', 'a//b', '..', 'a/..b', '.hidden', 'a/' + 'x'.repeat(129), 'ünï.html']) expect(() => cleanName(bad), bad).toThrow();
  });

  it('normTags lowercases, joins words, de-duplicates and caps', () => {
    expect(normTags(['Finance, Q3', 'big  idea', 'finance', ''])).toEqual(['finance', 'q3', 'big-idea']);
    expect(normTags(Array.from({ length: 30 }, (_, i) => 't' + i))).toHaveLength(20);
    expect(normTags(['x'.repeat(41)])).toEqual([]);
  });

  it('parses Content-Disposition like mime.ParseMediaType', () => {
    expect(parseHeaderValue('form-data; name="files"; filename="assets/a \\"b\\".png"').params).toEqual({ name: 'files', filename: 'assets/a "b".png' });
    expect(parseHeaderValue("form-data; name=files; filename*=UTF-8''r%C3%A9sum%C3%A9.md").params.filename).toBe('résumé.md');
    expect(parseHeaderValue('multipart/form-data; boundary=----abc').params.boundary).toBe('----abc');
  });
});

describe('scheduled cleanup', () => {
  it('drops expired sessions, challenges, lockouts and visit markers', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions (hash, expires) VALUES (?, ?), (?, ?)').bind('old', now - 1, 'live', now + 1e6),
      env.DB.prepare('INSERT INTO challenges (id, kind, value, expires) VALUES (?, ?, ?, ?)').bind('c1', 'login', 'v', now - 1),
      env.DB.prepare('INSERT INTO failures (key, count, first, lock) VALUES (?, 1, ?, 0)').bind('x', now - 3600e3),
      env.DB.prepare('INSERT INTO share_recent (key, at) VALUES (?, ?)').bind('k', now - 7200e3),
    ]);
    await cleanup(env.DB, now);
    const count = async (t: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first('n');
    expect(await env.DB.prepare('SELECT hash FROM sessions').all()).toMatchObject({ results: [{ hash: 'live' }] });
    expect(await count('challenges')).toBe(0);
    expect(await count('failures')).toBe(0);
    expect(await count('share_recent')).toBe(0);
  });
});
