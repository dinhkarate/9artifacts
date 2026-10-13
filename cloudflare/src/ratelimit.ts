// Failed-attempt lockouts (internal/app/auth.go), kept in D1 because Worker
// isolates share no memory: 5 failures per address in 15 minutes lock that
// address for 15 minutes; setup-token guesses also count towards a global cap
// of 50, so rotating addresses does not buy unlimited guesses.
import type { Ctx } from './env';

export const FAIL_LIMIT = 5;
export const GLOBAL_FAIL_LIMIT = 50;
const FAIL_WINDOW = 15 * 60e3;
const LOCK_DURATION = 15 * 60e3;
const GLOBAL = 'global';

interface Row {
  count: number;
  first: number;
  lock: number;
}

async function get(c: Ctx, key: string): Promise<Row | null> {
  return c.db.prepare('SELECT count, first, lock FROM failures WHERE key = ?').bind(key).first<Row>();
}

/** Milliseconds key is still locked out for, or 0. */
export async function lockedFor(c: Ctx, key: string): Promise<number> {
  const r = await get(c, key);
  const now = Date.now();
  return r && now < r.lock ? r.lock - now : 0;
}

/** Like lockedFor, plus the global cap that applies to setup-token guesses. */
export async function secretLockedFor(c: Ctx, key: string): Promise<number> {
  const [mine, all] = await Promise.all([lockedFor(c, key), lockedFor(c, GLOBAL)]);
  return Math.max(mine, all);
}

async function bump(c: Ctx, key: string, limit: number): Promise<void> {
  const now = Date.now();
  const r = await get(c, key);
  let f: Row = r && now - r.first <= FAIL_WINDOW ? { ...r } : { count: 0, first: now, lock: r?.lock ?? 0 };
  f.count++;
  if (f.count >= limit) f = { count: 0, first: now, lock: now + LOCK_DURATION };
  await c.db
    .prepare('INSERT INTO failures (key, count, first, lock) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (key) DO UPDATE SET count = ?2, first = ?3, lock = ?4')
    .bind(key, f.count, f.first, f.lock)
    .run();
}

/**
 * failed records a failed attempt for key (an address, or "share|"+address).
 * Only secret guesses count towards the global cap, so nobody can lock the
 * owner out by spamming bogus passkeys.
 */
export async function failed(c: Ctx, key: string, secret: boolean): Promise<void> {
  await bump(c, key, FAIL_LIMIT);
  if (secret) await bump(c, GLOBAL, GLOBAL_FAIL_LIMIT);
}

/** allowBegin rate-limits unauthenticated passkey ceremonies: 20 per address per minute. */
export async function allowBegin(c: Ctx): Promise<boolean> {
  const now = Date.now();
  const r = await c.db
    .prepare(
      `INSERT INTO failures (key, count, first, lock) VALUES (?1, 1, ?2, 0)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN ?2 - first > 60000 THEN 1 ELSE count + 1 END,
         first = CASE WHEN ?2 - first > 60000 THEN ?2 ELSE first END
       RETURNING count`,
    )
    .bind('begin|' + c.ip, now)
    .first<{ count: number }>();
  return (r?.count ?? 0) <= 20;
}

export function tooMany(waitMs: number): Response {
  const secs = Math.floor(waitMs / 1000) + 1;
  return new Response(JSON.stringify({ error: 'too many failed attempts, try again later', retryAfter: secs }) + '\n', {
    status: 429,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(secs) },
  });
}
