// Artifact bytes, view tokens and public share pages (internal/app/content.go).
import { BRAND } from './brand';
import { type Ctx, contentOrigin, isHTTPS } from './env';
import { MARKDOWN_CSS, SHARE_HTML } from './generated/web';
import { render as renderMarkdown } from './markdown';
import { notify } from './notify';
import { checkSharePassword } from './sharepw';
import { type Share, type Version, fileKey, getVersion, shareActive, shareLive, toShare, toVersion } from './store';
import { failed, lockedFor } from './ratelimit';
import { renderTemplate } from './template';
import {
  STATUS_TEXT, b64url, baseName, cleanName, concat, contentType, dec, enc, escapeHTML, extOf, hmac, notFound, readBody, safeEqual, textError,
} from './util';

// View tokens let sandboxed iframes (which run on an opaque origin and so
// never carry the session cookie) fetch an artifact's sibling files. A token
// is scoped to one artifact version and expires after 12 hours, rounded up to
// the hour so URLs stay cacheable. Format and MAC match the Go server.
const VIEW_TTL = 12 * 3600;

export async function sign(c: Ctx, payload: string): Promise<string> {
  return b64url((await hmac(await c.signKey(), 'view|' + payload)).subarray(0, 18));
}

export async function viewToken(c: Ctx, id: string, n: number, now = Date.now()): Promise<string> {
  const exp = Math.floor((Math.floor(now / 1000) + VIEW_TTL) / 3600) * 3600 + 3600;
  const payload = `${id}.${n}.${exp.toString(36)}`;
  return payload + '.' + (await sign(c, payload));
}

export async function viewBase(c: Ctx, id: string, n: number): Promise<string> {
  return contentOrigin(c) + '/c/' + (await viewToken(c, id, n)) + '/';
}

export async function checkViewToken(c: Ctx, tok: string): Promise<{ id: string; n: number } | null> {
  const parts = tok.split('.');
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join('.');
  if (!(await safeEqual(await sign(c, payload), parts[3]))) return null;
  const exp = parseInt(parts[2], 36);
  if (!/^[0-9a-z]+$/.test(parts[2]) || Date.now() / 1000 > exp) return null;
  if (!/^[+-]?\d+$/.test(parts[1])) return null;
  return { id: parts[0], n: parseInt(parts[1], 10) };
}

export async function handleContent(c: Ctx, vt: string, path: string): Promise<Response> {
  const t = await checkViewToken(c, vt);
  if (!t) return textError(404, 'link expired, reload the page');
  const v = await getVersion(c, t.id, t.n);
  if (!v) return notFound();
  const q = c.url.searchParams;
  return serveVersionFile(c, t.id, v, path, q.has('download'), q.has('view'), q.has('vc'));
}

// ---------- shares ----------

interface Resolved {
  status: number;
  share?: Share;
  id?: string;
  title?: string;
  v?: Version;
}

/** resolveShare returns the artifact, version and title for a live share token, or 404/410. */
export async function resolveShare(c: Ctx, token: string): Promise<Resolved> {
  const r = await c.db
    .prepare(
      `SELECT s.*, a.title AS a_title, v.n, v.entry, v.message, v.files, v.created_at AS v_created_at
       FROM shares s JOIN artifacts a ON a.id = s.artifact_id
       LEFT JOIN versions v ON v.artifact_id = s.artifact_id AND v.n = s.version
       WHERE s.token = ?`,
    )
    .bind(token)
    .first<Record<string, unknown>>();
  if (!r) return { status: 404 };
  const share = toShare(r);
  if (!shareLive(share)) return { status: 410, share };
  if (r.n === null || r.n === undefined) return { status: 404, share };
  const v = toVersion({ ...r, created_at: r.v_created_at });
  return { status: 200, share, id: share.artifactId, title: r.a_title as string, v };
}

export async function handleShareContent(c: Ctx, token: string, path: string): Promise<Response> {
  const r = await resolveShare(c, token);
  let status = r.status;
  // Protected links serve files only through a grant from the unlock form.
  if (status === 200 && r.share!.passwordHash) status = 401;
  if (status === 200 && !(await recordVisit(c, token, r))) status = 410;
  if (status !== 200) return textError(status, STATUS_TEXT[status]);
  return serveVersionFile(c, r.id!, r.v!, path, c.url.searchParams.has('download'), c.url.searchParams.has('view'));
}

/**
 * handleShareGrant serves the files of a password-protected link to a visitor
 * who unlocked it. The grant is signed for this token and short-lived, and the
 * link is re-checked on every request, so revoking still takes effect at once.
 */
export async function handleShareGrant(c: Ctx, token: string, grant: string, path: string): Promise<Response> {
  const r = await resolveShare(c, token);
  let status = r.status;
  if (status === 200 && !(await checkGrant(c, token, grant))) status = 401;
  if (status !== 200) return textError(status, STATUS_TEXT[status]);
  return serveVersionFile(c, r.id!, r.v!, path, c.url.searchParams.has('download'), c.url.searchParams.has('view'));
}

const GRANT_TTL = 2 * 3600;
const SHARE_COOKIE = BRAND + '_share';

async function makeGrant(c: Ctx, token: string): Promise<string> {
  const exp = (Math.floor(Date.now() / 1000) + GRANT_TTL).toString(36);
  return exp + '.' + (await sign(c, `share|${token}|${exp}`));
}

async function checkGrant(c: Ctx, token: string, g: string): Promise<boolean> {
  const dot = g.indexOf('.');
  if (dot < 0) return false;
  const exp = g.slice(0, dot);
  if (!(await safeEqual(await sign(c, `share|${token}|${exp}`), g.slice(dot + 1)))) return false;
  const t = parseInt(exp, 36);
  return /^[0-9a-z]+$/.test(exp) && Date.now() / 1000 <= t;
}

/** isPreviewBot matches the crawlers chat and social apps send to unfurl links. */
function isPreviewBot(ua: string): boolean {
  ua = ua.toLowerCase();
  return ['slackbot', 'discordbot', 'facebookexternalhit', 'twitterbot', 'telegrambot', 'whatsapp', 'linkedinbot',
    'skypeuripreview', 'zalo', 'mattermost', 'redditbot', 'embedly', 'iframely'].some((b) => ua.includes(b));
}

/** recordVisit counts the visitor and tells the webhooks; false when no views are left. */
async function recordVisit(c: Ctx, token: string, r: Resolved): Promise<boolean> {
  const { ok, first } = await countView(c, token, r.share!);
  if (first) {
    let detail = `visitor ${r.share!.views + 1}`;
    if (r.share!.maxViews > 0) detail += ` of ${r.share!.maxViews}`;
    notify(c, 'share.visited', { id: r.id!, title: r.title!, url: c.publicURL + '/a/' + r.id, version: r.v!.n }, detail);
  }
  return ok;
}

/**
 * countView counts each visitor (client address) once. On links with a view
 * limit the visitor is remembered for the link's lifetime, so people who were
 * counted can always come back; elsewhere a visit counts once per hour. Only
 * keyed hashes of addresses are stored.
 */
async function countView(c: Ctx, token: string, sh: Share): Promise<{ ok: boolean; first: boolean }> {
  const visitor = await sign(c, `visitor|${token}|${c.ip}`);
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const active = `revoked_at IS NULL AND expires_at > ?2 AND (max_views = 0 OR views < max_views)`;
  if (sh.maxViews > 0) {
    // Claim a visitor slot first; only one concurrent request can win it.
    const claim = await c.db
      .prepare(`INSERT OR IGNORE INTO share_visitors (token, visitor) SELECT token, ?3 FROM shares WHERE token = ?1 AND ${active}`)
      .bind(token, iso, visitor)
      .run();
    if (!claim.meta.changes) {
      const known = await c.db.prepare('SELECT 1 FROM share_visitors WHERE token = ? AND visitor = ?').bind(token, visitor).first();
      return { ok: known !== null, first: false };
    }
    const upd = await c.db
      .prepare(`UPDATE shares SET views = views + 1, last_viewed_at = ?2 WHERE token = ?1 AND ${active}`)
      .bind(token, iso)
      .run();
    if (!upd.meta.changes) {
      await c.db.prepare('DELETE FROM share_visitors WHERE token = ? AND visitor = ?').bind(token, visitor).run();
      return { ok: false, first: false };
    }
    return { ok: true, first: true };
  }
  const recent = await c.db
    .prepare('INSERT INTO share_recent (key, at) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET at = excluded.at WHERE share_recent.at <= ?3')
    .bind(visitor, now, now - 3600e3)
    .run();
  if (!recent.meta.changes) return { ok: shareActive(sh, now), first: false };
  const upd = await c.db
    .prepare(`UPDATE shares SET views = views + 1, last_viewed_at = ?2 WHERE token = ?1 AND ${active}`)
    .bind(token, iso)
    .run();
  if (!upd.meta.changes) {
    await c.db.prepare('DELETE FROM share_recent WHERE key = ?').bind(visitor).run();
    return { ok: false, first: false };
  }
  return { ok: true, first: true };
}

// ---------- serving files ----------

/** Every artifact response is sandboxed except PDFs, which browsers refuse to render sandboxed. */
const needsSandbox = (name: string) => extOf(name) !== '.pdf';

function contentHeaders(c: Ctx, h: Headers, sandbox: boolean): void {
  const ancestors = `frame-ancestors ${c.publicURL} 'self'`;
  if (sandbox) {
    let csp = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads; ' + ancestors;
    if (c.artifactCSP) csp += '; ' + c.artifactCSP;
    h.set('Content-Security-Policy', csp);
  } else {
    h.set('Content-Security-Policy', ancestors);
  }
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  h.set('Cache-Control', 'private, max-age=3600');
}

/**
 * serveVersionFile writes one file of a version. With pick (the owner's viewer
 * only, ?vc=1 on a view-token URL), HTML and rendered Markdown get a tiny
 * script that reports the selected text to the viewer, so comments can quote
 * it; downloads and share links are untouched.
 */
export async function serveVersionFile(
  c: Ctx, id: string, v: Version, rawName: string, download: boolean, render: boolean, pick = false,
): Promise<Response> {
  let name: string;
  try {
    name = cleanName(rawName || v.entry);
  } catch {
    return notFound();
  }
  const f = v.files.find((x) => x.name === name);
  if (!f) return notFound();
  const key = fileKey(id, v.n, f);
  const h = new Headers();
  if (render && !download && name.toLowerCase().endsWith('.md')) {
    const obj = await c.files.get(key, { range: { offset: 0, length: 8 << 20 } });
    if (!obj) return notFound();
    contentHeaders(c, h, true);
    h.set('Content-Type', 'text/html; charset=utf-8');
    let page = markdownPage(baseName(name), dec.decode(await obj.arrayBuffer()));
    if (pick) page += pickScript(c);
    return new Response(c.req.method === 'HEAD' ? null : page, { headers: h });
  }
  if (pick && !download && contentType(name).startsWith('text/html') && f.size < 16 << 20) {
    const obj = await c.files.get(key);
    if (!obj) return notFound();
    contentHeaders(c, h, true);
    h.set('Content-Type', contentType(name));
    h.set('Cache-Control', 'no-store');
    const page = concat([new Uint8Array(await obj.arrayBuffer()), enc.encode(pickScript(c))]);
    return new Response(c.req.method === 'HEAD' ? null : page, { headers: h });
  }
  let obj: R2Object | R2ObjectBody | null;
  try {
    obj = await c.files.get(key, { range: c.req.headers, onlyIf: c.req.headers });
  } catch {
    return textError(416, 'Requested Range Not Satisfiable');
  }
  if (!obj) return notFound();
  if (download) {
    h.set('Content-Disposition', `attachment; filename="${baseName(name).replaceAll('"', '')}"`);
    h.set('Content-Type', 'application/octet-stream');
    contentHeaders(c, h, true);
  } else {
    contentHeaders(c, h, needsSandbox(name));
    h.set('Content-Type', contentType(name));
  }
  h.set('ETag', obj.httpEtag);
  h.set('Accept-Ranges', 'bytes');
  if (!('body' in obj)) return new Response(null, { status: 304, headers: h });
  let status = 200;
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && c.req.headers.has('Range')) {
    const offset = range.suffix !== undefined ? obj.size - range.suffix : (range.offset ?? 0);
    const length = range.suffix !== undefined ? range.suffix : (range.length ?? obj.size - offset);
    status = 206;
    h.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set('Content-Length', String(length));
  } else {
    h.set('Content-Length', String(obj.size));
  }
  return new Response(c.req.method === 'HEAD' ? null : obj.body, { status, headers: h });
}

/**
 * pickScript posts the current text selection to the viewer. Appended after
 * </html> it still runs: browsers move trailing content into <body>.
 */
function pickScript(c: Ctx): string {
  const origin = JSON.stringify(c.publicURL).replace(/[<>&]/g, (x) => '\\u' + x.charCodeAt(0).toString(16).padStart(4, '0'));
  return `<script>(()=>{let t,last="";document.addEventListener("selectionchange",()=>{clearTimeout(t);t=setTimeout(()=>{const s=String(getSelection()||"").trim().slice(0,500);if(s!==last){last=s;parent.postMessage({${BRAND}:"selection",text:s},${origin})}},300)})})()</script>`;
}

function markdownPage(title: string, src: string): string {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escapeHTML(title) + '</title><style>' + MARKDOWN_CSS + '</style></head><body><main class="markdown">' + renderMarkdown(src) +
    '</main></body></html>';
}

// ---------- public share page ----------

function fileKind(name: string): string {
  switch (extOf(name)) {
    case '.html': case '.htm': return 'html';
    case '.md': return 'markdown';
    case '.pdf': return 'pdf';
    case '.png': case '.jpg': case '.jpeg': case '.gif': case '.webp': case '.avif': case '.svg': return 'image';
    case '.txt': case '.csv': case '.json': case '.log': case '.yaml': case '.yml': case '.xml': case '.py': case '.go':
    case '.js': case '.ts': case '.sh': case '.sql': case '.css': return 'text';
  }
  return 'file';
}

const encodePath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function handleSharePage(c: Ctx, token: string): Promise<Response> {
  const r = await resolveShare(c, token);
  let status = r.status;
  const data: Record<string, unknown> = { Name: c.name, Version: c.version };
  let base = contentOrigin(c) + '/s/' + token + '/f/';
  const isPost = c.req.method === 'POST';
  if (status !== 200) {
    // Unavailable: the template says so.
  } else if (r.share!.passwordHash) {
    // Nothing about the artifact (not even its title) is shown until the
    // password is right; a wrong guess costs a login-style failure.
    const key = 'share|' + c.ip;
    status = 401;
    const grant = readCookie(c.req, SHARE_COOKIE);
    if (grant && !isPost && (await checkGrant(c, token, grant))) {
      status = (await recordVisit(c, token, r)) ? 200 : 410;
      base = contentOrigin(c) + '/s/' + token + '/g/' + grant + '/';
    } else if (isPost) {
      const wait = await lockedFor(c, key);
      if (wait > 0) {
        data.Error = `Too many attempts. Try again in ${Math.floor(wait / 60000) + 1} minutes.`;
        status = 429;
      } else {
        let pw = '';
        try {
          pw = new URLSearchParams(dec.decode(await readBody(c.req, 4096))).get('password') ?? '';
        } catch {
          /* oversized form: treat as wrong */
        }
        if (!(await checkSharePassword(pw, r.share!.passwordHash))) {
          await failed(c, key, false);
          data.Error = 'Wrong password.';
        } else if (!(await recordVisit(c, token, r))) {
          status = 410;
        } else {
          // Remember the unlock for this link only, then redirect so a reload
          // is a plain GET instead of a form resubmission.
          const cookie = `${SHARE_COOKIE}=${await makeGrant(c, token)}; Path=/s/${token}; Max-Age=${GRANT_TTL}; HttpOnly${isHTTPS(c) ? '; Secure' : ''}; SameSite=Lax`;
          return new Response(null, { status: 303, headers: { Location: '/s/' + token, 'Set-Cookie': cookie } });
        }
      }
    }
  } else if (isPost) {
    status = 405;
  } else if (!isPreviewBot(c.req.headers.get('User-Agent') ?? '')) {
    // Chat apps fetch the page to build a link preview; that must not use up
    // a view. Only the page shell is exempt: files are always counted.
    if (!(await recordVisit(c, token, r))) status = 410;
  }
  data.Status = status;
  if (status === 200) {
    const v = r.v!;
    let src = base + encodePath(v.entry);
    if (fileKind(v.entry) === 'markdown') src += '?view=1';
    data.Title = r.title;
    data.Note = r.share!.note;
    data.Kind = fileKind(v.entry);
    data.Src = src;
    data.Files = v.files.map((f) => ({ Name: f.name, Href: base + encodePath(f.name) + '?download=1', Size: f.size }));
    data.Expires = r.share!.expiresAt.slice(0, 16).replace('T', ' ') + ' UTC';
  }
  const html = renderTemplate(SHARE_HTML, data);
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

