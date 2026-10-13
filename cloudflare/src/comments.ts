// Review comments (internal/app/comments.go): the owner leaves feedback on a
// version, agents read open comments over MCP and resolve them after
// publishing a fix.
import { tokenName } from './auth';
import type { Ctx } from './env';
import { getArtifact, getVersion } from './store';
import { HttpError, cleanName, goQuote, int, json, newID, nowISO, readJSON, str, truncate } from './util';

const MAX_COMMENTS = 500;

export interface Comment {
  id: string;
  version: number;
  file: string;
  quote: string;
  body: string;
  author: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string;
}

type Row = Record<string, unknown>;

function toComment(r: Row): Comment {
  return {
    id: r.id as string, version: r.version as number, file: r.file as string, quote: r.quote as string, body: r.body as string,
    author: r.author as string, createdAt: r.created_at as string, resolvedAt: (r.resolved_at as string | null) ?? null, resolution: r.resolution as string,
  };
}

/** The Comment JSON, field order and omitempty as in the Go struct. */
export function commentView(c: Comment): Record<string, unknown> {
  const v: Record<string, unknown> = { id: c.id, version: c.version };
  if (c.file) v.file = c.file;
  if (c.quote) v.quote = c.quote;
  v.body = c.body;
  v.author = c.author;
  v.createdAt = c.createdAt;
  if (c.resolvedAt) v.resolvedAt = c.resolvedAt;
  if (c.resolution) v.resolution = c.resolution;
  return v;
}

export async function listComments(c: Ctx, id: string): Promise<Comment[]> {
  const { results } = await c.db.prepare('SELECT * FROM comments WHERE artifact_id = ? ORDER BY created_at, rowid').bind(id).all<Row>();
  return results.map(toComment);
}

/** AddComment records feedback on a version (0 = latest). */
export async function addComment(c: Ctx, id: string, author: string, input: { body: string; quote: string; version: number; file: string }): Promise<Comment> {
  const body = input.body.trim();
  if (!body) throw new HttpError(400, 'comment is empty');
  if (!(await getArtifact(c, id))) throw new HttpError(404, 'artifact not found');
  const v = await getVersion(c, id, input.version);
  if (!v) throw new HttpError(400, 'no such version');
  const file = input.file ? cleanName(input.file) : v.entry;
  const counts = await c.db
    .prepare('SELECT COUNT(*) AS total, SUM(resolved_at IS NULL) AS open FROM comments WHERE artifact_id = ?')
    .bind(id)
    .first<{ total: number; open: number | null }>();
  if ((counts?.total ?? 0) >= MAX_COMMENTS) {
    // Drop the oldest resolved comment to stay bounded.
    const r = await c.db
      .prepare('DELETE FROM comments WHERE id = (SELECT id FROM comments WHERE artifact_id = ? AND resolved_at IS NOT NULL ORDER BY created_at, rowid LIMIT 1)')
      .bind(id)
      .run();
    if (!r.meta.changes) throw new HttpError(409, `too many open comments (${counts?.open ?? 0})`);
  }
  const cm: Comment = {
    id: newID(6), version: v.n, file, quote: truncate(input.quote.trim(), 500), body: truncate(body, 4000), author, createdAt: nowISO(), resolvedAt: null, resolution: '',
  };
  await c.db
    .prepare('INSERT INTO comments (id, artifact_id, version, file, quote, body, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(cm.id, id, cm.version, cm.file, cm.quote, cm.body, cm.author, cm.createdAt)
    .run();
  return cm;
}

/** ResolveComment marks a comment done, with an optional note for the owner. */
export async function resolveComment(c: Ctx, id: string, cid: string, note: string): Promise<Comment> {
  if (!(await getArtifact(c, id))) throw new HttpError(404, 'artifact not found');
  const r = await c.db
    .prepare('UPDATE comments SET resolved_at = ?, resolution = ? WHERE id = ? AND artifact_id = ? RETURNING *')
    .bind(nowISO(), truncate(note.trim(), 2000), cid, id)
    .first<Row>();
  if (!r) throw new HttpError(404, 'comment not found');
  return toComment(r);
}

export async function handleCommentCreate(c: Ctx, id: string): Promise<Response> {
  const b = await readJSON(c.req);
  const name = await tokenName(c);
  const cm = await addComment(c, id, name ? 'agent: ' + name : 'owner', {
    body: str(b, 'body'), quote: str(b, 'quote'), version: int(b, 'version'), file: str(b, 'file'),
  });
  return json(201, commentView(cm));
}

export async function handleCommentResolve(c: Ctx, id: string, cid: string): Promise<Response> {
  let note = '';
  try {
    note = str(await readJSON(c.req), 'note');
  } catch {
    // The note is optional; Go ignores an unreadable body.
  }
  try {
    return json(200, commentView(await resolveComment(c, id, cid, note)));
  } catch (e) {
    if (e instanceof HttpError) return json(404, { error: e.message });
    throw e;
  }
}

export async function handleCommentDelete(c: Ctx, id: string, cid: string): Promise<Response> {
  if (!(await getArtifact(c, id))) return json(404, { error: 'artifact not found' });
  const r = await c.db.prepare('DELETE FROM comments WHERE id = ? AND artifact_id = ?').bind(cid, id).run();
  if (!r.meta.changes) return json(404, { error: 'comment not found' });
  return json(200, { ok: true });
}

/** formatComments renders comments for an agent. */
export function formatComments(title: string, latest: number, comments: Comment[], includeResolved: boolean): string {
  let b = '';
  let n = 0;
  for (const cm of comments) {
    if (cm.resolvedAt && !includeResolved) continue;
    n++;
    let state = 'open';
    if (cm.resolvedAt) {
      state = 'resolved';
      if (cm.resolution) state += ': ' + cm.resolution;
    }
    b += `- [${cm.id}] v${cm.version} ${cm.file} (${state}, by ${cm.author})\n`;
    if (cm.quote) b += `  on: ${goQuote(cm.quote)}\n`;
    b += `  ${cm.body.replaceAll('\n', '\n  ')}\n`;
  }
  if (n === 0) return `No open comments on ${goQuote(title)} (latest v${latest}).`;
  return `Comments on ${goQuote(title)} (latest v${latest}):\n${b}\nFix them with publish_artifact (same id), then resolve_comment each one with a short note.`;
}
