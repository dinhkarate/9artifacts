// The text form of an artifact: what an agent reads instead of rendering the
// page. This is internal/app/text.go in TypeScript; change both.

import type { Ctx } from './env';
import { shareURL } from './env';
import { type Share, type Version, fileKey, getArtifact, getVersion } from './store';
import { humanBytes } from './util';

const READ = 512 << 10;
const TEXT_EXT = new Set(['.html', '.htm', '.md', '.txt', '.csv', '.svg']);

const DROP = /<!--[\s\S]*?-->|<![^>]*>|<(script|style|title|template)\b[\s\S]*?<\/(script|style|title|template)\s*>/gi;
const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const set = (...n: string[]) => new Set(n);
const VOID = set('br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'track');
const IMPLIED = set('li', 'p', 'tr', 'td', 'th', 'option', 'dt', 'dd');
const PARA = set('p', 'ul', 'ol', 'table', 'section', 'article', 'blockquote', 'figure', 'details', 'dl', 'main', 'header', 'footer', 'nav', 'aside', 'form');
const BLOCK = set('div', 'thead', 'tbody', 'tfoot', 'figcaption', 'summary', 'dt', 'dd', 'caption', 'address', 'fieldset', 'body', 'html');

// The Go server knows every named entity; these are the ones pages use.
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', times: '×', copy: '©', laquo: '«', raquo: '»', bull: '•', deg: '°',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', minus: '−', plusmn: '±',
};
function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

interface Node {
  tag: string; // '' for text
  text: string;
  attr: Record<string, string>;
  kids: Node[];
}

const has = (n: Node, cls: string) => (n.attr.class ?? '').split(/\s+/).includes(cls);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function first(n: Node, cls: string): Node | null {
  for (const k of n.kids) {
    if (!k.tag) continue;
    if (has(k, cls)) return k;
    const x = first(k, cls);
    if (x) return x;
  }
  return null;
}

function raw(n: Node, br = ''): string {
  return (n.tag === 'br' ? br : '') + n.text + n.kids.map((k) => raw(k, br)).join('');
}
const plain = (n: Node) => oneLine(raw(n, ' '));

function parse(src: string): Node {
  src = src.replace(DROP, ' ');
  const root: Node = { tag: '#root', text: '', attr: {}, kids: [] };
  let stack = [root];
  const add = (n: Node) => stack[stack.length - 1].kids.push(n);
  let pos = 0;
  for (const m of src.matchAll(TOKEN)) {
    if (m.index > pos) add({ tag: '', text: unescape(src.slice(pos, m.index)), attr: {}, kids: [] });
    pos = m.index + m[0].length;
    const tag = m[2].toLowerCase();
    const rest = m[3];
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack = stack.slice(0, i);
          break;
        }
      }
      continue;
    }
    const top = stack[stack.length - 1].tag;
    if (IMPLIED.has(tag) && (top === tag || (tag === 'td' && top === 'th') || (tag === 'th' && top === 'td'))) stack.pop();
    const n: Node = { tag, text: '', attr: {}, kids: [] };
    for (const a of rest.matchAll(ATTR)) n.attr[a[1].toLowerCase()] = unescape((a[2] ?? '') + (a[3] ?? '') + (a[4] ?? ''));
    add(n);
    if (!VOID.has(tag) && !rest.trim().endsWith('/')) stack.push(n);
  }
  if (pos < src.length) add({ tag: '', text: unescape(src.slice(pos)), attr: {}, kids: [] });
  return root;
}

/** Renders a page as text for agents. */
export function htmlText(src: string): string {
  const pre: string[] = [];
  let slide = 0;
  let out = '';

  const kids = (n: Node) => n.kids.forEach(walk);
  function walk(n: Node): void {
    if (!n.tag) {
      out += n.text.replace(/\s+/g, ' ');
      return;
    }
    if ('hidden' in n.attr || n.tag === 'head') return;
    if (has(n, 'd') && first(n, 'flow')) {
      out += diagram(n);
      return;
    }
    if (has(n, 'slide')) out += `\n\n[Slide ${++slide}]\n`;
    const tag = n.tag;
    if (tag === 'br') out += '\n';
    else if (tag === 'hr') out += '\n\n---\n\n';
    else if (tag === 'img') {
      const alt = (n.attr.alt ?? '').trim();
      if (alt) out += `[image: ${alt}]`;
    } else if (tag === 'pre') {
      out += `\n\n\u0000${pre.length}\u0000\n\n`;
      pre.push(raw(n).replace(/^\n+|\n+$/g, ''));
    } else if (tag === 'code') out += '`' + plain(n) + '`';
    else if (/^h[1-6]$/.test(tag)) out += '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + plain(n) + '\n\n';
    else if (tag === 'li') {
      out += '\n- ';
      kids(n);
    } else if (tag === 'tr') {
      out += '\n';
      kids(n);
    } else if (tag === 'td' || tag === 'th') {
      kids(n);
      out += ' | ';
    } else if (tag === 'a') {
      kids(n);
      const href = n.attr.href ?? '';
      if (href.startsWith('http') && href !== plain(n)) out += ` (${href})`;
    } else if (PARA.has(tag)) {
      out += '\n\n';
      kids(n);
      out += '\n\n';
    } else if (BLOCK.has(tag)) {
      out += '\n';
      kids(n);
      out += '\n';
    } else kids(n);
  }
  walk(parse(src));

  const lines = out.split('\n').map((l) => {
    l = oneLine(l);
    return l.endsWith(' |') ? l.slice(0, -2) : l;
  });
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  pre.forEach((p, i) => {
    text = text.replace(`\u0000${i}\u0000`, () => '```\n' + p + '\n```');
  });
  return text;
}

// A link joins the nodes on either side of it in its row; a drop joins the
// last node of the row above to the last node of the row below.
function diagram(d: Node): string {
  const rows: Node[] = [];
  const collect = (n: Node) => {
    for (const k of n.kids) {
      if (!k.tag) continue;
      if (has(k, 'flow') || has(k, 'drop')) rows.push(k);
      else collect(k);
    }
  };
  collect(d);

  const nodes: string[] = [];
  const links: string[] = [];
  const edge = (from: string, to: string, l: Node) => {
    let s = `- ${from || '?'} → ${to || '?'}`;
    if (has(l, 'down')) s += ' [down]';
    else if (has(l, 'live')) s += ' [live]';
    else if (has(l, 'tunnel')) s += ' [tunnel]';
    const lbl = first(l, 'lbl');
    if (lbl && plain(lbl)) s += ` "${plain(lbl)}"`;
    const tip = tipText(l);
    if (tip) s += ': ' + tip;
    links.push(s);
  };
  let drop: Node | null = null;
  let prevLast = '';
  for (const row of rows) {
    if (has(row, 'drop')) {
      drop = row;
      continue;
    }
    let last = '';
    let open: Node | null = null;
    for (const it of row.kids) {
      if (!it.tag) continue;
      if (has(it, 'node')) {
        const nameEl = first(it, 'n');
        const name = plain(nameEl ?? it);
        nodes.push(describeNode(it, name));
        if (open) {
          edge(last, name, open);
          open = null;
        }
        last = name;
      } else if (has(it, 'link')) open = it;
    }
    if (open) edge(last, '', open);
    if (drop) {
      edge(prevLast, last, drop);
      drop = null;
    }
    prevLast = last;
  }
  return '\n\nDiagram nodes:\n' + nodes.join('\n') + '\n\nDiagram links:\n' + links.join('\n') + '\n\n';
}

function describeNode(n: Node, name: string): string {
  let s = '- ' + name;
  const sub = ['a', 'p'].map((c) => first(n, c)).filter((x): x is Node => !!x && plain(x) !== '').map(plain);
  if (sub.length) s += ` (${sub.join('; ')})`;
  const state: string[] = [];
  const led = first(n, 'led');
  if (has(n, 'bad') || (led && has(led, 'bad'))) state.push('down');
  else if (has(n, 'warn') || (led && has(led, 'warn'))) state.push('degraded');
  else if (led) state.push('up');
  if (has(n, 'mark')) state.push('focus');
  if (state.length) s += ` [${state.join(', ')}]`;
  const tip = tipText(n);
  if (tip) s += ': ' + tip;
  return s;
}

/** Reads a .tip: its <b> is a title and its <code> sits on its own line. */
function tipText(n: Node): string {
  const tip = first(n, 'tip');
  if (!tip) return '';
  let s = '';
  for (const k of tip.kids) {
    if (!k.tag) s += k.text;
    else if (k.tag === 'b' || k.tag === 'strong') s += plain(k) + ': ';
    else if (k.tag === 'code') s += ' `' + plain(k) + '`';
    else s += plain(k);
  }
  return oneLine(s);
}

const utcMinute = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC';

/** The text form of one version: a short header, then the entry file as text. */
export async function artifactText(c: Ctx, id: string, title: string, v: Version, meta: string[]): Promise<string> {
  let head = `- Version: ${v.n} (${utcMinute(v.createdAt)})`;
  if (v.message) head += ', ' + v.message;
  let b = `# ${title}\n\n${head}\n- Files: ${v.files.map((f) => `${f.name} (${humanBytes(f.size)})`).join(', ')}\n`;
  for (const m of meta) b += `- ${m}\n`;
  b += '\n---\n\n';
  const dot = v.entry.lastIndexOf('.');
  const ext = dot < 0 ? '' : v.entry.slice(dot).toLowerCase();
  const f = v.files.find((x) => x.name === v.entry);
  if (!TEXT_EXT.has(ext) || !f) return b + `(${v.entry} is not text; download it to read it.)\n`;
  const obj = await c.files.get(fileKey(id, v.n, f), { range: { offset: 0, length: READ } });
  if (!obj) return b + `(${v.entry} is missing from storage.)\n`;
  let body = new TextDecoder().decode(await obj.arrayBuffer());
  if (ext === '.html' || ext === '.htm' || ext === '.svg') body = htmlText(body);
  b += body.trim() + '\n';
  if (f.size > READ) b += '\n(Cut after the first 512 kB.)\n';
  return b;
}

/** An agent asked for the text form, with ?format=md or an Accept header no browser sends. */
export function wantsText(c: Ctx): boolean {
  const f = c.url.searchParams.get('format');
  return f === 'md' || f === 'text' || (c.req.headers.get('Accept') ?? '').includes('text/markdown');
}

const reply = (status: number, body: string) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept' } });

/** GET /api/artifacts/{id}/text, and /a/{id} for agents. */
export async function handleText(c: Ctx, id: string): Promise<Response> {
  const n = Number.parseInt(c.url.searchParams.get('v') ?? '', 10) || 0;
  const [art, v] = await Promise.all([getArtifact(c, id), getVersion(c, id, n)]);
  if (!art || !v) return reply(404, 'Artifact or version not found.\n');
  const meta = [`Page: ${c.publicURL}/a/${id}`];
  if (art.tags.length) meta.push('Tags: ' + art.tags.join(', '));
  if (v.n !== art.latest) meta.push(`Latest version: ${art.latest}`);
  return reply(200, await artifactText(c, id, art.title, v, meta));
}

/** The text form of a share page, with the status the page has. */
export async function shareText(c: Ctx, status: number, r: { id?: string; title?: string; v?: Version; share?: Share }): Promise<Response> {
  if (status === 200) {
    const meta = ['Shared link, expires ' + utcMinute(r.share!.expiresAt)];
    if (r.share!.note) meta.push('Note: ' + r.share!.note);
    return reply(200, await artifactText(c, r.id!, r.title!, r.v!, meta));
  }
  if (status === 401 || status === 429) return reply(status, 'This link is protected by a password. Ask the person who shared it to open it in a browser, or to send the text.\n');
  if (status === 410) return reply(status, 'This link has expired or has no views left.\n');
  return reply(status, 'Link not found.\n');
}

export function handleLLMs(c: Ctx): Response {
  const u = c.publicURL;
  const share = shareURL(c, '').slice(0, -'/s/'.length);
  const auth = c.demo
    ? 'This is a read-only public demo: reading needs no token, publishing is off.'
    : 'Send `Authorization: Bearer <token>`; the owner creates tokens in Settings.';
  const what =
    (c.demo ? 'a read-only public demo of a gallery' : 'a private gallery') +
    ' where AI agents publish HTML, Markdown, SVG, images and PDFs for their owner to review, comment on and share';
  const body = `# ${c.name}

> This is a 9artifacts server (${c.version}): ${what}. ${auth}

## Read an artifact as text

Pages here are HTML made for people. Agents should read the text form instead: Markdown with the markup, styles and scripts removed. Diagrams become a list of nodes and links with their states; slide decks are split by slide.

- ${u}/api/artifacts/{id}/text (add ?v=N for an older version), or the page URL ${u}/a/{id} with the header "Accept: text/markdown"
- A share link (${share}/s/...): add ?format=md, or send "Accept: text/markdown". A password-protected link has no text form.
- ${u}/api/artifacts?q=words lists artifacts as JSON; q matches titles and tags
- The raw files: MCP tool read_artifact, or ${u}/api/artifacts/{id}/download/{file}

## Publish

- MCP endpoint: ${u}/mcp (bearer token, or OAuth for remote connectors). Tools: get_design_guide, publish_artifact, list_artifacts, read_artifact, share_artifact, revoke_share, restore_version, list_comments, resolve_comment, delete_artifact
- CLI: 9artifacts login ${u}, then 9artifacts publish FILE|DIR
- Before writing a page, read the owner's house style: [design guide](${u}/design.md), [diagram kit](${u}/diagram.css), starter templates for a [page](${u}/template.html), [slides](${u}/template.html?kind=slides) and an [A4 document](${u}/template.html?kind=document)

## Optional

- [Agent skill](https://github.com/dinhkarate/9artifacts/blob/main/skills/9artifacts/SKILL.md)
- [REST API](https://github.com/dinhkarate/9artifacts/blob/main/docs/api.md)
- [Run your own](https://9artifacts.com/install.md)
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
