import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { b64url, sha256, unb64url } from '../src/util';
import { type Credential, assert, decodeCBOR, derToRaw, register } from '../src/webauthn';
import { APP, Client, body, fresh } from './helpers';

const SETUP = 'test-setup-token-0123456789';

/** A software authenticator: ES256 key, COSE public key, DER signatures. */
class Authenticator {
  count = 0;
  constructor(public keys: CryptoKeyPair, public id = new TextEncoder().encode('credential-id-123')) {}

  static async create(id?: Uint8Array) {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return new Authenticator(keys, id);
  }

  async authData(rpID: string, flags: number, attested: boolean): Promise<Uint8Array> {
    const out: number[] = [...(await sha256(rpID)), flags, (this.count >>> 24) & 255, (this.count >>> 16) & 255, (this.count >>> 8) & 255, this.count & 255];
    if (attested) {
      out.push(...new Uint8Array(16), this.id.length >> 8, this.id.length & 255, ...this.id);
      const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
      // COSE_Key map {1:2, 3:-7, -1:1, -2:x, -3:y}
      out.push(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...unb64url(jwk.x!)!, 0x22, 0x58, 0x20, ...unb64url(jwk.y!)!);
    }
    return new Uint8Array(out);
  }

  async sign(authData: Uint8Array, cd: Uint8Array, der = true): Promise<Uint8Array> {
    const msg = new Uint8Array([...authData, ...(await sha256(cd))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, msg));
    return der ? rawToDer(raw) : raw;
  }
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = [...b.subarray(i)];
    if (v[0] & 0x80) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const clientData = (type: string, challenge: string, origin: string) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));

describe('webauthn verification (port of the Go tests)', () => {
  const rp = { id: 'art.example.com', origin: 'https://art.example.com' };

  it('registers and asserts, enforcing the counter and every check', async () => {
    const a = await Authenticator.create();
    const credID = b64url(a.id);
    const cred: Credential = await register(rp, 'chal-1', credID, await a.authData(rp.id, 0x45, true), clientData('webauthn.create', 'chal-1', rp.origin));
    expect(cred.id).toBe(credID);

    a.count = 5;
    let ad = await a.authData(rp.id, 0x05, false);
    const cd = clientData('webauthn.get', 'chal-2', rp.origin);
    expect(await assert(rp, cred, 'chal-2', ad, cd, await a.sign(ad, cd))).toBe(5);
    // Raw r||s signatures are accepted too.
    expect(await assert(rp, cred, 'chal-2', ad, cd, await a.sign(ad, cd, false))).toBe(5);
    cred.signCount = 5;
    await expect(assert(rp, cred, 'chal-2', ad, cd, await a.sign(ad, cd))).rejects.toThrow(/counter/);

    a.count = 6;
    ad = await a.authData(rp.id, 0x05, false);
    const cases: Record<string, () => Promise<unknown>> = {
      'wrong origin': async () => {
        const cd = clientData('webauthn.get', 'c', 'https://evil.example.com');
        return assert(rp, cred, 'c', ad, cd, await a.sign(ad, cd));
      },
      'wrong challenge': async () => {
        const cd = clientData('webauthn.get', 'other', rp.origin);
        return assert(rp, cred, 'c', ad, cd, await a.sign(ad, cd));
      },
      'wrong rpId': async () => {
        const bad = await a.authData('evil.example.com', 0x05, false);
        const cd = clientData('webauthn.get', 'c', rp.origin);
        return assert(rp, cred, 'c', bad, cd, await a.sign(bad, cd));
      },
      'no user verification': async () => {
        const bad = await a.authData(rp.id, 0x01, false);
        const cd = clientData('webauthn.get', 'c', rp.origin);
        return assert(rp, cred, 'c', bad, cd, await a.sign(bad, cd));
      },
      'bad signature': async () => {
        const cd = clientData('webauthn.get', 'c', rp.origin);
        const sig = await a.sign(ad, cd);
        sig[sig.length - 1] ^= 1;
        return assert(rp, cred, 'c', ad, cd, sig);
      },
      'create used for get': async () => {
        const cd = clientData('webauthn.create', 'c', rp.origin);
        return assert(rp, cred, 'c', ad, cd, await a.sign(ad, cd));
      },
    };
    for (const [name, fn] of Object.entries(cases)) await expect(fn(), name).rejects.toThrow();
  });

  it('rejects a mismatched credential id and counter rollback', async () => {
    const lrp = { id: 'localhost', origin: 'http://localhost:8080' };
    const a = await Authenticator.create();
    await expect(register(lrp, 'c', 'not-the-id', await a.authData(lrp.id, 0x45, true), clientData('webauthn.create', 'c', lrp.origin))).rejects.toThrow(/mismatch/);
    const cred = await register(lrp, 'c', b64url(a.id), await a.authData(lrp.id, 0x45, true), clientData('webauthn.create', 'c', lrp.origin));
    cred.signCount = 7;
    const ad = await a.authData(lrp.id, 0x05, false);
    const cd = clientData('webauthn.get', 'c', lrp.origin);
    await expect(assert(lrp, cred, 'c', ad, cd, await a.sign(ad, cd))).rejects.toThrow(/counter/);
  });

  it('CBOR decoding has limits', () => {
    for (const input of [[], [0x5f], [0x59, 0xff, 0xff], [0xa1], [0xa1, 0xa0, 0x01]]) {
      expect(() => decodeCBOR(new Uint8Array(input), 0, 0), JSON.stringify(input)).toThrow();
    }
    expect(derToRaw(new Uint8Array([0x30, 0x02, 0x05, 0x00]))).toBeNull();
  });
});

describe('passkey-only owner sign-in over HTTP', () => {
  const browser = new Client();
  let authn: Authenticator;

  beforeAll(fresh);

  async function registerPasskey(c: Client, a: Authenticator, name: string) {
    const begin = await body(await c.browser('POST', '/api/passkeys/begin', {}));
    expect(begin.rp).toEqual({ id: 'localhost', name: 'vitryn' });
    expect(begin.authenticatorSelection).toEqual({ residentKey: 'preferred', userVerification: 'required' });
    expect(begin.user.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const ad = await a.authData('localhost', 0x45, true);
    return c.browser('POST', '/api/passkeys/finish', {
      challengeId: begin.challengeId, credentialId: b64url(a.id), name,
      authenticatorData: b64url(ad), clientDataJSON: b64url(clientData('webauthn.create', begin.challenge, APP)),
    });
  }

  async function login(c: Client, a: Authenticator) {
    const begin = await body(await c.fetch('/api/auth/passkey/login/begin', { method: 'POST', body: '{}' }));
    a.count++;
    const ad = await a.authData(begin.rpId, 0x05, false);
    const cd = clientData('webauthn.get', begin.challenge, APP);
    return c.fetch('/api/auth/passkey/login/finish', {
      method: 'POST',
      body: JSON.stringify({ challengeId: begin.challengeId, credentialId: b64url(a.id), authenticatorData: b64url(ad), clientDataJSON: b64url(cd), signature: b64url(await a.sign(ad, cd)) }),
    });
  }

  it('starts in setup mode', async () => {
    const me = await body(await browser.fetch('/api/me'));
    expect(me).toMatchObject({ authenticated: false, needsSetup: true, hasPasskeys: false, publicUrl: APP, contentOrigin: APP, separateContentOrigin: false });
  });

  it('a wrong setup token is refused; the right one opens a session', async () => {
    const wrong = await browser.fetch('/api/auth/setup', { method: 'POST', body: JSON.stringify({ code: 'nope', password: '' }) });
    expect(wrong.status).toBe(403);
    const ok = await browser.fetch('/api/auth/setup', { method: 'POST', body: JSON.stringify({ code: SETUP, password: '' }) });
    expect(ok.status).toBe(201);
    const cookie = ok.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/^vitryn_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    browser.keepCookie(ok);
    // Signed in without a passkey: the SPA goes on to Settings, not back to setup.
    expect(await body(await browser.fetch('/api/me', { headers: { Cookie: browser.cookie } }))).toMatchObject({ authenticated: true, needsSetup: false });
  });

  it('session writes need the CSRF header; sessions cannot be used without it', async () => {
    expect((await browser.browser('POST', '/api/tokens', { name: 'x' }, false)).status).toBe(401);
    expect((await browser.browser('GET', '/api/tokens', undefined, false)).status).toBe(200);
  });

  it('registers a passkey, then setup is closed', async () => {
    authn = await Authenticator.create(new TextEncoder().encode('laptop-key'));
    const r = await registerPasskey(browser, authn, 'Laptop');
    expect(r.status).toBe(201);
    expect(await body(r)).toEqual({ ok: true, id: b64url(authn.id) });
    const dup = await registerPasskey(browser, authn, 'Again');
    expect(dup.status).toBe(409);
    const list = await body<any[]>(await browser.browser('GET', '/api/passkeys'));
    expect(list.map((p) => p.name)).toEqual(['Laptop']);
    const begin = await body(await browser.browser('POST', '/api/passkeys/begin', {}));
    expect(begin.excludeCredentials).toEqual([{ type: 'public-key', id: b64url(authn.id) }]);
    expect((await browser.fetch('/api/auth/setup', { method: 'POST', body: JSON.stringify({ code: SETUP }) })).status).toBe(409);
    expect(await body(await new Client().fetch('/api/me'))).toMatchObject({ needsSetup: false, hasPasskeys: true, authenticated: false });
  });

  it('a challenge is single-use and kind-bound', async () => {
    const begin = await body(await browser.browser('POST', '/api/passkeys/begin', {}));
    const ad = await authn.authData('localhost', 0x45, true);
    const finish = { challengeId: begin.challengeId, credentialId: b64url(authn.id), authenticatorData: b64url(ad), clientDataJSON: b64url(clientData('webauthn.get', begin.challenge, APP)) };
    const first = await body(await browser.browser('POST', '/api/passkeys/finish', finish));
    expect(first.error).toBe('passkey registration failed: wrong ceremony type');
    const again = await body(await browser.browser('POST', '/api/passkeys/finish', finish));
    expect(again.error).toBe('challenge expired, try again');
  });

  it('logs out, then signs in with the passkey', async () => {
    expect((await browser.browser('POST', '/api/auth/logout', {})).headers.get('Set-Cookie')).toMatch(/^vitryn_session=; Path=\/; Max-Age=0/);
    expect(await body(await browser.fetch('/api/me', { headers: { Cookie: browser.cookie } }))).toMatchObject({ authenticated: false });
    const r = await login(browser, authn);
    expect(r.status).toBe(200);
    browser.keepCookie(r);
    expect(await body(await browser.fetch('/api/me', { headers: { Cookie: browser.cookie } }))).toMatchObject({ authenticated: true });
    const row = await env.DB.prepare('SELECT sign_count FROM passkeys').first<{ sign_count: number }>();
    expect(row?.sign_count).toBe(1);
  });

  it('rejects a replayed counter and an unknown passkey, and locks out after 5 failures', async () => {
    const attacker = new Client();
    const clone = new Authenticator(authn.keys, authn.id); // count 0 → 1, not above 1
    expect((await body(await login(attacker, clone))).error).toMatch(/counter did not increase/);
    const stranger = await Authenticator.create(new TextEncoder().encode('stranger'));
    for (let i = 0; i < 4; i++) expect((await login(attacker, stranger)).status).toBe(401);
    const locked = await attacker.fetch('/api/auth/passkey/login/begin', { method: 'POST', body: '{}' });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('Retry-After'))).toBeGreaterThan(800);
    // The owner, on another address, is unaffected.
    expect((await login(new Client(), authn)).status).toBe(200);
  });

  it('API tokens are managed with a session only, and work for the API', async () => {
    const t = await body(await browser.browser('POST', '/api/tokens', { name: 'claude-code on laptop' }));
    expect(t.token).toMatch(/^vt_[A-Za-z0-9_-]{32}$/);
    const list = await body<any[]>(await browser.browser('GET', '/api/tokens'));
    expect(list).toEqual([{ id: t.id, name: 'claude-code on laptop', prefix: t.token.slice(0, 7), createdAt: expect.any(String), lastUsedAt: null, oauth: false }]);
    const agent = new Client(undefined, t.token);
    expect((await agent.api('GET', '/api/artifacts')).status).toBe(200);
    // Agents cannot mint tokens or touch passkeys.
    expect((await agent.api('POST', '/api/tokens', { name: 'x' })).status).toBe(401);
    expect((await agent.api('GET', '/api/passkeys')).status).toBe(401);
    expect((await browser.browser('DELETE', `/api/tokens/${t.id}`)).status).toBe(200);
    expect((await agent.api('GET', '/api/artifacts')).status).toBe(401);
    // Passwords do not exist in this edition.
    expect((await browser.browser('POST', '/api/password', { current: 'x', password: 'y' })).status).toBe(400);
  });

  it('the setup token works as a rate-limited recovery code on the sign-in form', async () => {
    const lost = new Client();
    const ok = await lost.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: SETUP }) });
    expect(ok.status).toBe(200);
    lost.keepCookie(ok);
    // ...so the owner can add a new passkey.
    const fresh = await Authenticator.create(new TextEncoder().encode('new-phone'));
    expect((await registerPasskey(lost, fresh, 'Phone')).status).toBe(201);

    const guesser = new Client();
    for (let i = 0; i < 4; i++) expect((await guesser.fetch('/api/auth/login', { method: 'POST', body: '{"password":"guess"}' })).status).toBe(401);
    const fifth = await guesser.fetch('/api/auth/login', { method: 'POST', body: '{"password":"guess"}' });
    expect(fifth.status).toBe(429);
    expect((await body(fifth)).retryAfter).toBeGreaterThan(800);
    expect((await guesser.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: SETUP }) })).status).toBe(429);
  });

  it('without a SETUP_TOKEN secret, setup explains what to do', async () => {
    const noSecret = new Client({ PUBLIC_URL: APP, CONTENT_URL: '', SETUP_TOKEN: 'short' });
    const r = await noSecret.fetch('/api/auth/login', { method: 'POST', body: '{"password":"short"}' });
    expect(r.status).toBe(409);
    expect((await body(r)).error).toMatch(/wrangler secret put SETUP_TOKEN/);
  });

  it('uses a __Host- cookie on HTTPS', async () => {
    const https = new Client({ PUBLIC_URL: 'https://art.example.com', CONTENT_URL: '' });
    const r = await https.fetch('https://art.example.com/api/auth/login', { method: 'POST', body: JSON.stringify({ password: SETUP }) });
    expect(r.headers.get('Set-Cookie')).toMatch(/^__Host-vitryn_session=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
  });
});
