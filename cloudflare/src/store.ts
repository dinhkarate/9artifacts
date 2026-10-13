// D1 rows and the queries shared by the API, MCP and content handlers.
import type { Ctx } from './env';

export interface FileMeta {
  name: string;
  size: number;
  type: string;
  /** Version whose R2 objects hold the bytes, when not this version. */
  src?: number;
}

export interface Version {
  n: number;
  entry: string;
  message: string;
  files: FileMeta[];
  createdAt: string;
}

export interface Share {
  token: string;
  artifactId: string;
  version: number;
  note: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  views: number;
  maxViews: number;
  lastViewedAt: string | null;
  passwordHash: string;
}

export interface Artifact {
  id: string;
  title: string;
  tags: string[];
  note: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  latest: number;
}

type Row = Record<string, unknown>;

export function toArtifact(r: Row): Artifact {
  return {
    id: r.id as string,
    title: r.title as string,
    tags: JSON.parse(r.tags as string) as string[],
    note: r.note as string,
    pinned: Boolean(r.pinned),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    latest: r.latest as number,
  };
}

export function toVersion(r: Row): Version {
  return {
    n: r.n as number,
    entry: r.entry as string,
    message: r.message as string,
    files: JSON.parse(r.files as string) as FileMeta[],
    createdAt: r.created_at as string,
  };
}

export function toShare(r: Row): Share {
  return {
    token: r.token as string,
    artifactId: r.artifact_id as string,
    version: r.version as number,
    note: r.note as string,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
    views: r.views as number,
    maxViews: r.max_views as number,
    lastViewedAt: (r.last_viewed_at as string | null) ?? null,
    passwordHash: r.password_hash as string,
  };
}

/** Live: neither revoked nor expired. */
export function shareLive(s: Share, now = Date.now()): boolean {
  return s.revokedAt === null && now < Date.parse(s.expiresAt);
}

/** Active: new visitors can still open the link. */
export function shareActive(s: Share, now = Date.now()): boolean {
  return shareLive(s, now) && (s.maxViews === 0 || s.views < s.maxViews);
}

/** SQL condition matching shareActive, for a shares row aliased as `s`. */
export const ACTIVE_SQL = `(s.revoked_at IS NULL AND s.expires_at > ?1 AND (s.max_views = 0 OR s.views < s.max_views))`;

export async function getArtifact(c: Ctx, id: string): Promise<Artifact | null> {
  const r = await c.db.prepare('SELECT * FROM artifacts WHERE id = ?').bind(id).first<Row>();
  return r ? toArtifact(r) : null;
}

/** Version n of artifact id, or the latest when n <= 0. */
export async function getVersion(c: Ctx, id: string, n: number): Promise<Version | null> {
  const r =
    n > 0
      ? await c.db.prepare('SELECT * FROM versions WHERE artifact_id = ? AND n = ?').bind(id, n).first<Row>()
      : await c.db
          .prepare('SELECT v.* FROM versions v JOIN artifacts a ON a.id = v.artifact_id AND v.n = a.latest WHERE a.id = ?')
          .bind(id)
          .first<Row>();
  return r ? toVersion(r) : null;
}

export async function listVersions(c: Ctx, id: string): Promise<Version[]> {
  const { results } = await c.db.prepare('SELECT * FROM versions WHERE artifact_id = ? ORDER BY n').bind(id).all<Row>();
  return results.map(toVersion);
}

export async function listShares(c: Ctx, id: string): Promise<Share[]> {
  const { results } = await c.db
    .prepare('SELECT * FROM shares WHERE artifact_id = ? ORDER BY created_at, rowid')
    .bind(id)
    .all<Row>();
  return results.map(toShare);
}

/** R2 key of a file of version n. */
export function fileKey(id: string, n: number, f: FileMeta): string {
  return `artifacts/${id}/v${f.src ?? n}/${f.name}`;
}

/** Deletes R2 objects under prefix, 1000 keys per call. */
export async function deletePrefix(c: Ctx, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await c.files.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await c.files.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
