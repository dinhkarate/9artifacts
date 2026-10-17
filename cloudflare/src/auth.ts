// Sessions, API tokens, passkeys and first-run setup (internal/app/auth.go).
//
// The Cloudflare edition is passkey-only: PBKDF2 owner passwords cannot run in
// the free plan's 10 ms CPU budget. Instead the SETUP_TOKEN secret (set with
// `wrangler secret put SETUP_TOKEN`) opens a session once, on the setup screen,
// so the owner can register the first passkey; it keeps working as a
// rate-limited recovery code on the sign-in screen until the owner deletes the
// secret.
import { BRAND } from './brand';
import { type Ctx, isHTTPS } from './env';
import { allowBegin, failed, lockedFor, secretLockedFor, tooMany } from './ratelimit';
import { type Credential, WebAuthnError, assert, decodeField, register } from './webauthn';
import { HttpError, b64url, hashSecret, hmac, json, newID, nowISO, randomBytes, readJSON, safeEqual, str, unb64url } from './util';

const SESSION_COOKIE = BRAND + '_session';
const SESSION_TTL = 30 * 86400e3;
const CHALLENGE_TTL = 5 * 60e3;
export const MIN_SETUP_TOKEN = 16;

/** __Host- on HTTPS, so a sibling subdomain can never plant or overwrite the session. */
const cookieName = (c: Ctx) => (isHTTPS(c) ? '__Host-' + SESSION_COOKIE : SESSION_COOKIE);

function readCookie(c: Ctx, name: string): string {
  for (const part of (c.req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function sessionCookie(c: Ctx, value: string, maxAge: number): string {
  return `${cookieName(c)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly${isHTTPS(c) ? '; Secure' : ''}; SameSite=Strict`;
}

async function startSession(c: Ctx): Promise<string> {
  const sid = b64url(randomBytes(32));
  await c.db.prepare('INSERT INTO sessions (hash, expires) VALUES (?, ?)').bind(await hashSecret(sid), Date.now() + SESSION_TTL).run();
  return sessionCookie(c, sid, SESSION_TTL / 1000);
}

const sessionMemo = new WeakMap<Request, Promise<boolean>>();

export function hasSession(c: Ctx): Promise<boolean> {
  let p = sessionMemo.get(c.req);
  if (!p) {
    p = (async () => {
      const sid = readCookie(c, cookieName(c));
      if (!sid) return false;
      const r = await c.db.prepare('SELECT expires FROM sessions WHERE hash = ?').bind(await hashSecret(sid)).first<{ expires: number }>();
      return r !== null && Date.now() < r.expires;
    })();
    sessionMemo.set(c.req, p);
  }
  return p;
}

const tokenMemo = new WeakMap<Request, Promise<{ id: string; name: string } | null>>();

/**
 * The valid, unexpired API token on an "Authorization: Bearer vt_..." header,
 * or null. OAuth access tokens expire; tokens made in Settings never do.
 */
function bearerToken(c: Ctx): Promise<{ id: string; name: string } | null> {
  let p = tokenMemo.get(c.req);
  if (!p) {
    p = (async () => {
      const h = c.req.headers.get('Authorization') ?? '';
      if (!h.startsWith('Bearer ')) return null;
      const secret = h.slice(7);
      if (!secret.startsWith('vt_')) return null;
      const want = await hashSecret(secret.trim());
      const r = await c.db
        .prepare('SELECT id, name, last_used_at FROM tokens WHERE hash = ? AND (expires_at IS NULL OR expires_at > ?)')
        .bind(want, nowISO())
        .first<{ id: string; name: string; last_used_at: string | null }>();
      if (!r) return null;
      if (!r.last_used_at || Date.now() - Date.parse(r.last_used_at) > 60e3) {
        c.waitUntil(c.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').bind(nowISO(), r.id).run());
      }
      return { id: r.id, name: r.name };
    })();
    tokenMemo.set(c.req, p);
  }
  return p;
}

/** tokenAuth validates an "Authorization: Bearer vt_..." header. */
export async function tokenAuth(c: Ctx): Promise<boolean> {
  return (await bearerToken(c)) !== null;
}

/** tokenName returns the name of the API token on the request, or "". */
export async function tokenName(c: Ctx): Promise<string> {
  return (await bearerToken(c))?.name ?? '';
}

/** Cookie-authenticated writes must come from our own JavaScript, which sends X-9artifacts: 1. */
export function csrfOK(c: Ctx): boolean {
  const m = c.req.method;
  return m === 'GET' || m === 'HEAD' || c.req.headers.get('X-9artifacts') === '1';
}

/** auth accepts an API token or a browser session. */
export async function authed(c: Ctx): Promise<boolean> {
  return (await tokenAuth(c)) || ((await hasSession(c)) && csrfOK(c));
}

/** session accepts only a browser session (account management). */
export async function sessionOnly(c: Ctx): Promise<boolean> {
  return (await hasSession(c)) && csrfOK(c);
}

export const unauthorized = () => json(401, { error: 'authentication required' });

/** guest: on a DEMO deployment, a visitor without owner credentials who only reads. */
export async function guest(c: Ctx): Promise<boolean> {
  const m = c.req.method;
  return c.demo && (m === 'GET' || m === 'HEAD') && !(await tokenAuth(c)) && !(await hasSession(c));
}

export const readOnlyDemo = () => json(403, { error: 'this is a read-only demo: deploy your own 9artifacts to publish' });

// ---------- setup token ----------

function setupToken(c: Ctx): string {
  const t = (c.env.SETUP_TOKEN ?? '').trim();
  return t.length >= MIN_SETUP_TOKEN ? t : '';
}

async function passkeyCount(c: Ctx): Promise<number> {
  const r = await c.db.prepare('SELECT COUNT(*) AS n FROM passkeys').first<{ n: number }>();
  return r?.n ?? 0;
}

/** Checks a setup-token guess with the password-style lockout; returns a response on failure. */
async function checkSetupToken(c: Ctx, guess: string, status: number, msg: string): Promise<Response | null> {
  const wait = await secretLockedFor(c, c.ip);
  if (wait > 0) return tooMany(wait);
  const want = setupToken(c);
  if (!want) {
    return json(409, { error: `the SETUP_TOKEN secret is not set (or shorter than ${MIN_SETUP_TOKEN} characters): run \`npx wrangler secret put SETUP_TOKEN\`` });
  }
  if (!(await safeEqual(guess.trim(), want))) {
    await failed(c, c.ip, true);
    const after = await secretLockedFor(c, c.ip);
    if (after > 0) return tooMany(after);
    return json(status, { error: msg });
  }
  return null;
}

// ---------- handlers ----------

export async function handleMe(c: Ctx): Promise<Response> {
  const [session, token, passkeys] = await Promise.all([hasSession(c), tokenAuth(c), passkeyCount(c)]);
  const authenticated = session || token;
  return json(200, {
    authenticated,
    // The setup screen shows until a passkey exists; a signed-in owner without
    // one (just after setup) goes on to Settings to add it. A demo never shows
    // it to visitors; the owner signs in at /login with the setup token.
    needsSetup: passkeys === 0 && !authenticated && !c.demo,
    hasPasskeys: passkeys > 0,
    name: c.name,
    version: c.version,
    publicUrl: c.publicURL,
    contentOrigin: c.contentURL || c.publicURL,
    separateContentOrigin: c.contHost !== '',
    edition: 'cloudflare',
    passkeyOnly: true,
    demo: c.demo,
  });
}

/** POST /api/auth/setup {code}: the setup token opens a session while no passkey exists. */
export async function handleSetup(c: Ctx): Promise<Response> {
  const body = await readJSON(c.req);
  if ((await passkeyCount(c)) > 0) return json(409, { error: 'setup already completed' });
  const bad = await checkSetupToken(c, str(body, 'code'), 403, 'wrong setup token (the SETUP_TOKEN Worker secret)');
  if (bad) return bad;
  return json(201, { ok: true }, { 'Set-Cookie': await startSession(c) });
}

/**
 * POST /api/auth/login {password}: there are no owner passwords in this
 * edition; the setup token is accepted here as a recovery code, so a new
 * passkey can be added after losing the old ones.
 */
export async function handleLogin(c: Ctx): Promise<Response> {
  const body = await readJSON(c.req);
  const bad = await checkSetupToken(c, str(body, 'password'), 401, 'passkey-only server: use your passkey, or the setup token to recover');
  if (bad) return bad;
  return json(200, { ok: true }, { 'Set-Cookie': await startSession(c) });
}

export async function handleLogout(c: Ctx): Promise<Response> {
  const sid = readCookie(c, cookieName(c));
  if (sid) await c.db.prepare('DELETE FROM sessions WHERE hash = ?').bind(await hashSecret(sid)).run();
  return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(c, '', 0).replace('Max-Age=0', 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT') });
}

export function handlePasswordChange(): Response {
  return json(400, { error: 'this server is passkey-only (Cloudflare edition): there is no password to change' });
}

// ---------- passkeys ----------

async function newChallenge(c: Ctx, kind: string): Promise<{ id: string; value: string }> {
  const id = newID(10);
  const value = b64url(randomBytes(32));
  await c.db.prepare('INSERT INTO challenges (id, kind, value, expires) VALUES (?, ?, ?, ?)').bind(id, kind, value, Date.now() + CHALLENGE_TTL).run();
  return { id, value };
}

/** Single use: the row is deleted whether or not it matches. */
async function takeChallenge(c: Ctx, id: string, kind: string): Promise<string | null> {
  const r = await c.db.prepare('DELETE FROM challenges WHERE id = ? RETURNING kind, value, expires').bind(id).first<{ kind: string; value: string; expires: number }>();
  if (!r || r.kind !== kind || Date.now() > r.expires) return null;
  return r.value;
}

function rp(c: Ctx) {
  const u = new URL(c.publicURL);
  return { id: u.hostname, origin: u.origin };
}

async function userHandle(c: Ctx): Promise<string> {
  return b64url((await hmac(await c.signKey(), 'webauthn-user')).subarray(0, 16));
}

interface PasskeyRow {
  id: string;
  name: string;
  x: string;
  y: string;
  sign_count: number;
  created_at: string;
}

export async function handlePasskeyRegisterBegin(c: Ctx): Promise<Response> {
  const ch = await newChallenge(c, 'register');
  const { results } = await c.db.prepare('SELECT id FROM passkeys ORDER BY created_at, rowid').all<{ id: string }>();
  const exclude = results.length ? results.map((p) => ({ type: 'public-key', id: p.id })) : null;
  return json(200, {
    challengeId: ch.id,
    challenge: ch.value,
    rp: { id: rp(c).id, name: c.name },
    user: { id: await userHandle(c), name: 'owner', displayName: c.name + ' owner' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    excludeCredentials: exclude,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    attestation: 'none',
  });
}

export async function handlePasskeyRegisterFinish(c: Ctx): Promise<Response> {
  const body = await readJSON(c.req);
  const ch = await takeChallenge(c, str(body, 'challengeId'), 'register');
  if (!ch) return json(400, { error: 'challenge expired, try again' });
  let authData: Uint8Array, clientData: Uint8Array;
  try {
    authData = decodeField(body.authenticatorData);
    clientData = decodeField(body.clientDataJSON);
  } catch {
    return json(400, { error: 'malformed passkey response' });
  }
  let cred: Credential;
  try {
    cred = await register(rp(c), ch, str(body, 'credentialId'), authData, clientData);
  } catch (e) {
    if (e instanceof WebAuthnError) return json(400, { error: 'passkey registration failed: ' + e.message });
    throw e;
  }
  let name = str(body, 'name').trim() || 'Passkey';
  if (name.length > 60) name = name.slice(0, 60);
  const r = await c.db
    .prepare('INSERT OR IGNORE INTO passkeys (id, name, x, y, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(cred.id, name, b64url(cred.x), b64url(cred.y), cred.signCount, nowISO())
    .run();
  if (!r.meta.changes) return json(409, { error: 'this passkey is already registered' });
  return json(201, { ok: true, id: cred.id });
}

export async function handlePasskeyLoginBegin(c: Ctx): Promise<Response> {
  const wait = await lockedFor(c, c.ip);
  if (wait > 0) return tooMany(wait);
  if (!(await allowBegin(c))) return tooMany(60e3);
  const ch = await newChallenge(c, 'login');
  const { results } = await c.db.prepare('SELECT id FROM passkeys ORDER BY created_at, rowid').all<{ id: string }>();
  return json(200, {
    challengeId: ch.id,
    challenge: ch.value,
    rpId: rp(c).id,
    allowCredentials: results.map((p) => ({ type: 'public-key', id: p.id })),
    userVerification: 'required',
  });
}

export async function handlePasskeyLoginFinish(c: Ctx): Promise<Response> {
  const wait = await lockedFor(c, c.ip);
  if (wait > 0) return tooMany(wait);
  const body = await readJSON(c.req);
  const ch = await takeChallenge(c, str(body, 'challengeId'), 'login');
  if (!ch) return json(400, { error: 'challenge expired, try again' });
  const row = await c.db.prepare('SELECT * FROM passkeys WHERE id = ?').bind(str(body, 'credentialId')).first<PasskeyRow>();
  if (!row) {
    await failed(c, c.ip, false);
    return json(401, { error: 'unknown passkey' });
  }
  let authData: Uint8Array, clientData: Uint8Array, sig: Uint8Array;
  try {
    authData = decodeField(body.authenticatorData);
    clientData = decodeField(body.clientDataJSON);
    sig = decodeField(body.signature);
  } catch {
    return json(400, { error: 'malformed passkey response' });
  }
  const cred: Credential = { id: row.id, x: unb64url(row.x)!, y: unb64url(row.y)!, signCount: row.sign_count };
  let count: number;
  try {
    count = await assert(rp(c), cred, ch, authData, clientData, sig);
  } catch (e) {
    if (!(e instanceof WebAuthnError)) throw e;
    await failed(c, c.ip, false);
    return json(401, { error: 'passkey verification failed: ' + e.message });
  }
  await c.db.prepare('UPDATE passkeys SET sign_count = ?2 WHERE id = ?1 AND sign_count < ?2').bind(row.id, count).run();
  return json(200, { ok: true }, { 'Set-Cookie': await startSession(c) });
}

export async function handlePasskeyList(c: Ctx): Promise<Response> {
  const { results } = await c.db.prepare('SELECT id, name, created_at FROM passkeys ORDER BY created_at, rowid').all<PasskeyRow>();
  return json(200, results.map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at })));
}

export async function handlePasskeyDelete(c: Ctx, id: string): Promise<Response> {
  const r = await c.db.prepare('DELETE FROM passkeys WHERE id = ?').bind(id).run();
  if (!r.meta.changes) return json(404, { error: 'passkey not found' });
  return json(200, { ok: true });
}

// ---------- API tokens ----------

/** createToken issues a new API token and returns its plaintext once. */
export async function createToken(c: Ctx, rawName: string): Promise<{ id: string; name: string; token: string }> {
  let name = rawName.trim() || 'token';
  if (name.length > 60) name = name.slice(0, 60);
  const secret = 'vt_' + b64url(randomBytes(24));
  const id = newID(5);
  const r = await c.db
    .prepare('INSERT INTO tokens (id, name, hash, prefix, created_at) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM tokens) < 50')
    .bind(id, name, await hashSecret(secret), secret.slice(0, 7), nowISO())
    .run();
  if (!r.meta.changes) throw new HttpError(400, 'too many tokens; delete some first');
  return { id, name, token: secret };
}

export async function handleTokenList(c: Ctx): Promise<Response> {
  const { results } = await c.db
    .prepare('SELECT id, name, prefix, created_at, last_used_at, client_id FROM tokens ORDER BY created_at, rowid')
    .all<{ id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; client_id: string }>();
  return json(200, results.map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, lastUsedAt: t.last_used_at, oauth: t.client_id !== '' })));
}

export async function handleTokenCreate(c: Ctx): Promise<Response> {
  const body = await readJSON(c.req);
  return json(201, await createToken(c, str(body, 'name')));
}

export async function handleTokenDelete(c: Ctx, id: string): Promise<Response> {
  const r = await c.db.prepare('DELETE FROM tokens WHERE id = ?').bind(id).run();
  if (!r.meta.changes) return json(404, { error: 'token not found' });
  return json(200, { ok: true });
}
