// REST API for artifacts, versions and shares (internal/app/api.go).
import { type Ctx, shareURL } from './env';
import { viewBase } from './content';
import { title as markdownTitle } from './markdown';
import { notify } from './notify';
import {
  ACTIVE_SQL, type Artifact, type FileMeta, type Share, type Version, deletePrefix, fileKey, getArtifact, getVersion,
  listShares, listVersions, shareActive, toArtifact, toShare,
} from './store';
import { type Meta, VersionWriter, jsonMeta, metaUpdates, parseUpload } from './upload';
import { HttpError, b64url, dec, int, json, newID, normTags, nowISO, randomBytes, readJSON, str, truncate } from './util';
import { hashSharePassword } from './sharepw';

export const SHARE_TTLS: Record<string, number> = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };

// ---------- JSON views (field order and omitempty as in the Go structs) ----------

const publicFiles = (files: FileMeta[]) => files.map(({ name, size, type }) => ({ name, size, type }));

export function shareView(c: Ctx, s: Share, now = Date.now()): Record<string, unknown> {
  const v: Record<string, unknown> = { token: s.token, url: shareURL(c, s.token), version: s.version };
  if (s.note) v.note = s.note;
  v.createdAt = s.createdAt;
  v.expiresAt = s.expiresAt;
  if (s.revokedAt) v.revokedAt = s.revokedAt;
  v.active = shareActive(s, now);
  v.views = s.views;
  if (s.maxViews) v.maxViews = s.maxViews;
  if (s.lastViewedAt) v.lastViewedAt = s.lastViewedAt;
  if (s.passwordHash) v.protected = true;
  return v;
}

async function versionView(c: Ctx, id: string, v: Version): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { n: v.n, entry: v.entry, files: publicFiles(v.files) };
  if (v.message) out.message = v.message;
  out.createdAt = v.createdAt;
  out.viewBase = await viewBase(c, id, v.n);
  return out;
}

export interface ArtifactView {
  id: string;
  title: string;
  url: string;
  version: number;
  [k: string]: unknown;
}

/** The artifact JSON; full adds versions and shares (list view leaves them out). */
export async function artifactView(
  c: Ctx, a: Artifact, latest: Version, opts: { versions?: Version[]; shares?: Share[]; activeShares?: number },
): Promise<ArtifactView> {
  const now = Date.now();
  const out: ArtifactView = {
    id: a.id, title: a.title, tags: a.tags, note: a.note, pinned: a.pinned, createdAt: a.createdAt, updatedAt: a.updatedAt,
    url: c.publicURL + '/a/' + a.id, version: latest.n, entry: latest.entry, files: publicFiles(latest.files),
    size: latest.files.reduce((n, f) => n + f.size, 0), viewBase: await viewBase(c, a.id, latest.n),
  };
  if (opts.versions) out.versions = await Promise.all([...opts.versions].reverse().map((v) => versionView(c, a.id, v)));
  out.shares = opts.shares ? opts.shares.map((s) => shareView(c, s, now)) : [];
  out.activeShares = opts.shares ? opts.shares.filter((s) => shareActive(s, now)).length : (opts.activeShares ?? 0);
  return out;
}

/** The full artifact view, or null when it does not exist. */
export async function fullView(c: Ctx, id: string): Promise<ArtifactView | null> {
  const [a, versions, shares] = await Promise.all([getArtifact(c, id), listVersions(c, id), listShares(c, id)]);
  if (!a) return null;
  const latest = versions.find((v) => v.n === a.latest);
  if (!latest) return null;
  return artifactView(c, a, latest, { versions, shares });
}

// ---------- list ----------

export interface ListItem {
  a: Artifact;
  latest: Version;
  active: number;
}

/** All artifacts, pinned first then newest, with their latest version. */
export async function listArtifacts(c: Ctx): Promise<ListItem[]> {
  const { results } = await c.db
    .prepare(
      `SELECT a.*, v.entry AS v_entry, v.files AS v_files, v.message AS v_message, v.created_at AS v_created_at,
        (SELECT COUNT(*) FROM shares s WHERE s.artifact_id = a.id AND ${ACTIVE_SQL}) AS active
       FROM artifacts a JOIN versions v ON v.artifact_id = a.id AND v.n = a.latest
       ORDER BY a.pinned DESC, a.updated_at DESC`,
    )
    .bind(nowISO())
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    a: toArtifact(r),
    latest: { n: r.latest as number, entry: r.v_entry as string, message: r.v_message as string, files: JSON.parse(r.v_files as string), createdAt: r.v_created_at as string },
    active: r.active as number,
  }));
}

export async function handleList(c: Ctx): Promise<Response> {
  const q = (c.url.searchParams.get('q') ?? '').trim().toLowerCase();
  const tag = (c.url.searchParams.get('tag') ?? '').toLowerCase();
  const limit = parseInt(c.url.searchParams.get('limit') ?? '', 10) || 0;
  const items: Promise<ArtifactView>[] = [];
  const tags: Record<string, number> = {};
  for (const { a, latest, active } of await listArtifacts(c)) {
    for (const t of a.tags) tags[t] = (tags[t] ?? 0) + 1;
    if (tag && !a.tags.includes(tag)) continue;
    if (q && !`${a.title} ${a.tags.join(' ')} ${a.note}`.toLowerCase().includes(q)) continue;
    if (limit > 0 && items.length >= limit) continue;
    items.push(artifactView(c, a, latest, { activeShares: active }));
  }
  return json(200, { artifacts: await Promise.all(items), tags });
}

export async function handleGet(c: Ctx, id: string): Promise<Response> {
  const v = await fullView(c, id);
  return v ? json(200, v) : json(404, { error: 'artifact not found' });
}

// ---------- create / versions ----------

function pickEntry(files: FileMeta[], want: string): string {
  const names = files.map((f) => f.name);
  if (want && names.includes(want)) return want;
  if (names.includes('index.html')) return 'index.html';
  for (const ext of ['.html', '.htm', '.md', '.pdf', '.svg', '.png', '.jpg', '.jpeg', '.webp']) {
    for (const n of names) if (!n.includes('/') && n.toLowerCase().endsWith(ext)) return n;
  }
  return names[0];
}

/** guessTitle derives a title from the entry file when none was given. */
async function guessTitle(c: Ctx, id: string, n: number, entry: FileMeta): Promise<string> {
  const lower = entry.name.toLowerCase();
  if (/\.(md|html?)$/.test(lower)) {
    const obj = await c.files.get(fileKey(id, n, entry), { range: { offset: 0, length: 64 << 10 } });
    if (obj) {
      const raw = dec.decode(await obj.arrayBuffer());
      if (lower.endsWith('.md')) {
        const t = markdownTitle(raw);
        if (t) return truncate(t, 160);
      } else {
        const m = /<title[^>]*>(.*?)<\/title>/is.exec(raw);
        const t = m ? unescapeEntities(m[1]).trim() : '';
        if (t) return truncate(t, 160);
      }
    }
  }
  const base = entry.name.slice(entry.name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? base : base.slice(0, dot);
}

/** html.UnescapeString for the entities that show up in <title>. */
function unescapeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', middot: '·', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/** CreateArtifact commits a new artifact whose files w has written as v1. */
export async function createArtifact(c: Ctx, m: Meta, w: VersionWriter): Promise<ArtifactView> {
  try {
    if (w.count === 0) throw new HttpError(400, 'no files uploaded');
    const files = w.sorted();
    const entry = pickEntry(files, m.entry);
    let title = m.title !== undefined ? truncate(m.title, 160) : '';
    if (!title) title = await guessTitle(c, w.id, 1, files.find((f) => f.name === entry)!);
    const now = nowISO();
    const a: Artifact = { id: w.id, title, tags: normTags(m.tags), note: m.note !== undefined ? truncate(m.note, 4000) : '', pinned: m.pinned ?? false, createdAt: now, updatedAt: now, latest: 1 };
    const v: Version = { n: 1, entry, message: truncate(m.message, 200), files, createdAt: now };
    await c.db.batch([
      c.db
        .prepare('INSERT INTO artifacts (id, title, tags, note, pinned, created_at, updated_at, latest, next_n) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)')
        .bind(a.id, a.title, JSON.stringify(a.tags), a.note, a.pinned ? 1 : 0, now, now),
      c.db.prepare('INSERT INTO versions (artifact_id, n, entry, message, files, created_at) VALUES (?, 1, ?, ?, ?, ?)').bind(a.id, entry, v.message, JSON.stringify(files), now),
    ]);
    const out = await artifactView(c, a, v, { versions: [v], shares: [] });
    notify(c, 'artifact.published', { id: out.id, title: out.title, url: out.url, version: out.version }, '');
    return out;
  } catch (e) {
    await w.abort();
    throw e;
  }
}

/** A writer for the next version of id: reserves the number in D1. */
export function nextVersionWriter(c: Ctx, id: string): VersionWriter {
  return new VersionWriter(
    c,
    id,
    async () => {
      const r = await c.db.prepare('UPDATE artifacts SET next_n = next_n + 1 WHERE id = ? RETURNING next_n').bind(id).first<{ next_n: number }>();
      if (!r) throw new HttpError(404, 'artifact not found');
      return r.next_n;
    },
    async (n) => {
      await c.db.prepare('UPDATE artifacts SET next_n = next_n - 1 WHERE id = ? AND next_n = ?').bind(id, n).run();
    },
  );
}

/**
 * AddVersion commits the files written by w (plus, with keep, the previous
 * version's other files) as a new version; the private URL stays the same.
 * Kept and restored files point at the earlier version's R2 objects.
 */
export async function addVersion(c: Ctx, id: string, m: Meta, w: VersionWriter, extra: FileMeta[] = []): Promise<ArtifactView> {
  try {
    const prev = await getVersion(c, id, 0);
    if (!prev) throw new HttpError(404, 'artifact not found');
    const files = w.sorted();
    const n = await w.version();
    for (const f of extra) files.push(f);
    if (m.keep) {
      const uploaded = new Set(files.map((f) => f.name));
      for (const f of prev.files) if (!uploaded.has(f.name)) files.push({ ...f, src: f.src ?? prev.n });
      if (!m.entry) m.entry = prev.entry;
    }
    if (files.length === 0) throw new HttpError(400, 'no files uploaded');
    const now = nowISO();
    const v: Version = { n, entry: pickEntry(files, m.entry), message: truncate(m.message, 200), files, createdAt: now };
    const sets = ['latest = MAX(latest, ?2)', 'updated_at = ?3'];
    const args: unknown[] = [id, n, now];
    metaSets(metaUpdates(m), sets, args);
    const [ins] = await c.db.batch([
      c.db
        .prepare('INSERT INTO versions (artifact_id, n, entry, message, files, created_at) SELECT id, ?, ?, ?, ?, ? FROM artifacts WHERE id = ?')
        .bind(n, v.entry, v.message, JSON.stringify(files), now, id),
      c.db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?1`).bind(...args),
    ]);
    if (!ins.meta.changes) throw new HttpError(409, 'artifact was deleted');
    const out = await fullView(c, id);
    if (!out) throw new HttpError(409, 'artifact was deleted');
    notify(c, 'artifact.version', { id: out.id, title: out.title, url: out.url, version: n }, m.message);
    return out;
  } catch (e) {
    await w.abort();
    throw e;
  }
}

export async function handleCreate(c: Ctx): Promise<Response> {
  const w = new VersionWriter(c, newID(8), async () => 1);
  let m: Meta;
  try {
    m = await parseUpload(c, c.req, w);
  } catch (e) {
    await w.abort();
    throw e;
  }
  return json(201, await createArtifact(c, m, w));
}

export async function handleNewVersion(c: Ctx, id: string): Promise<Response> {
  if (!(await getArtifact(c, id))) throw new HttpError(404, 'artifact not found');
  const w = nextVersionWriter(c, id);
  let m: Meta;
  try {
    m = await parseUpload(c, c.req, w);
  } catch (e) {
    await w.abort();
    throw e;
  }
  return json(201, await addVersion(c, id, m, w));
}

/** Appends `col = ?N` assignments for the metadata applyMeta would change. */
function metaSets(u: ReturnType<typeof metaUpdates>, sets: string[], args: unknown[]): void {
  const add = (col: string, v: unknown) => {
    args.push(v);
    sets.push(`${col} = ?${args.length}`);
  };
  if (u.title !== undefined) add('title', u.title);
  if (u.tags !== undefined) add('tags', JSON.stringify(normTags(u.tags)));
  if (u.note !== undefined) add('note', u.note);
  if (u.pinned !== undefined) add('pinned', u.pinned ? 1 : 0);
}

/** RestoreVersion publishes a copy of version n as the new latest version. */
export async function restoreVersion(c: Ctx, id: string, n: number): Promise<ArtifactView> {
  const old = n > 0 ? await getVersion(c, id, n) : null;
  if (!old) throw new HttpError(404, 'version not found');
  const files = old.files.map((f) => ({ ...f, src: f.src ?? old.n }));
  return addVersion(c, id, { entry: old.entry, message: `Restored from v${n}`, keep: false }, nextVersionWriter(c, id), files);
}

export async function handleRestore(c: Ctx, id: string, nRaw: string): Promise<Response> {
  if (!/^[+-]?\d+$/.test(nRaw)) throw new HttpError(400, 'invalid version');
  return json(201, await restoreVersion(c, id, parseInt(nRaw, 10)));
}

export async function handlePatch(c: Ctx, id: string): Promise<Response> {
  const sets: string[] = [];
  const args: unknown[] = [id];
  metaSets(metaUpdates(jsonMeta(await readJSON(c.req))), sets, args);
  if (sets.length) await c.db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?1`).bind(...args).run();
  const out = await fullView(c, id);
  return out ? json(200, out) : json(404, { error: 'artifact not found' });
}

/** DeleteArtifact removes an artifact, its versions, share links and files. */
export async function deleteArtifact(c: Ctx, id: string): Promise<void> {
  const rs = await c.db.batch([
    c.db.prepare('DELETE FROM share_visitors WHERE token IN (SELECT token FROM shares WHERE artifact_id = ?)').bind(id),
    c.db.prepare('DELETE FROM shares WHERE artifact_id = ?').bind(id),
    c.db.prepare('DELETE FROM versions WHERE artifact_id = ?').bind(id),
    c.db.prepare('DELETE FROM artifacts WHERE id = ?').bind(id),
  ]);
  if (!rs[3].meta.changes) throw new HttpError(404, 'artifact not found');
  await deletePrefix(c, `artifacts/${id}/`);
}

export async function handleDelete(c: Ctx, id: string): Promise<Response> {
  await deleteArtifact(c, id);
  return json(200, { ok: true });
}

// ---------- shares ----------

export interface ShareOpts {
  ttl: string;
  note: string;
  version: number;
  maxViews: number;
  password: string;
}

/** CreateShare issues an expiring public link pinned to one version. */
export async function createShare(c: Ctx, id: string, o: ShareOpts): Promise<Record<string, unknown>> {
  const ttl = o.ttl || '7d';
  const d = SHARE_TTLS[ttl];
  if (!d) throw new HttpError(400, 'ttl must be one of 1h, 24h, 7d, 30d');
  if (o.maxViews < 0 || o.maxViews > 10000) throw new HttpError(400, 'maxViews must be between 0 (unlimited) and 10000');
  let pwHash = '';
  if (o.password) {
    if (o.password.length < 4 || o.password.length > 200) throw new HttpError(400, 'share password must be 4 to 200 characters');
    pwHash = await hashSharePassword(o.password);
  }
  const a = await getArtifact(c, id);
  if (!a) throw new HttpError(404, 'artifact not found');
  let version = o.version;
  if (version !== 0 && !(await getVersion(c, id, version))) throw new HttpError(404, 'no such version');
  // Pin the link to what the owner is sharing now; later versions stay
  // private until they share again.
  if (version === 0) version = a.latest;
  const now = Date.now();
  const s: Share = {
    token: b64url(randomBytes(18)), artifactId: id, version, note: truncate(o.note, 1000), createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + d).toISOString(), revokedAt: null, views: 0, maxViews: o.maxViews, lastViewedAt: null, passwordHash: pwHash,
  };
  const cutoff = new Date(now - 30 * 86400e3).toISOString();
  await c.db.batch([
    // Keep the list bounded: drop links that died more than 30 days ago.
    c.db.prepare('DELETE FROM share_visitors WHERE token IN (SELECT token FROM shares WHERE artifact_id = ? AND expires_at < ?)').bind(id, cutoff),
    c.db.prepare('DELETE FROM shares WHERE artifact_id = ? AND expires_at < ?').bind(id, cutoff),
    c.db
      .prepare('INSERT INTO shares (token, artifact_id, version, note, created_at, expires_at, max_views, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(s.token, id, version, s.note, s.createdAt, s.expiresAt, s.maxViews, pwHash),
  ]);
  let detail = 'expires in ' + ttl;
  if (o.maxViews > 0) detail += `, max ${o.maxViews} viewers`;
  if (pwHash) detail += ', password';
  notify(c, 'share.created', { id, title: a.title, url: c.publicURL + '/a/' + id, version }, detail);
  return shareView(c, s, now);
}

export async function handleShareCreate(c: Ctx, id: string): Promise<Response> {
  const body = await readJSON(c.req);
  const opts = { ttl: str(body, 'ttl'), note: str(body, 'note'), version: int(body, 'version'), maxViews: int(body, 'maxViews'), password: str(body, 'password') };
  return json(201, await createShare(c, id, opts));
}

/** RevokeShare kills a public link immediately. */
export async function revokeShare(c: Ctx, id: string, token: string): Promise<void> {
  if (!(await getArtifact(c, id))) throw new HttpError(404, 'artifact not found');
  const r = await c.db.prepare('SELECT * FROM shares WHERE token = ? AND artifact_id = ?').bind(token, id).first<Record<string, unknown>>();
  if (!r) throw new HttpError(404, 'share not found');
  if (!toShare(r).revokedAt) await c.db.prepare('UPDATE shares SET revoked_at = ? WHERE token = ?').bind(nowISO(), token).run();
}

export async function handleShareRevoke(c: Ctx, id: string, token: string): Promise<Response> {
  await revokeShare(c, id, token);
  return json(200, { ok: true });
}
