// Passkey registration and assertion for a single relying party, ported from
// internal/webauthn. ES256 (P-256) only, verified with WebCrypto.
import { b64url, safeEqual, sha256, unb64url } from './util';

export interface Credential {
  id: string; // base64url credential id
  x: Uint8Array;
  y: Uint8Array;
  signCount: number;
}

export interface RP {
  id: string; // rpId, a host name
  origin: string; // exact origin reported in clientDataJSON
}

export class WebAuthnError extends Error {}

const fail = (msg: string): never => {
  throw new WebAuthnError(msg);
};

/** Decode parses an unpadded base64url field from the browser. */
export function decodeField(s: unknown): Uint8Array {
  if (typeof s !== 'string' || s === '' || s.length > 8192) return fail('invalid base64url field');
  const b = unb64url(s);
  return b ?? fail('invalid base64url field');
}

async function checkClientData(rp: RP, raw: Uint8Array, typ: string, challenge: string): Promise<void> {
  let cd: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    cd = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return fail('invalid clientDataJSON');
  }
  if (cd === null || typeof cd !== 'object') return fail('invalid clientDataJSON');
  if (cd.type !== typ) fail('wrong ceremony type');
  if (typeof cd.challenge !== 'string' || !(await safeEqual(cd.challenge, challenge))) fail('challenge mismatch');
  if (cd.origin !== rp.origin) fail(`origin mismatch: got ${JSON.stringify(String(cd.origin ?? ''))}`);
}

async function checkAuthData(rp: RP, authData: Uint8Array): Promise<{ flags: number; signCount: number }> {
  if (authData.length < 37) fail('authenticator data truncated');
  const want = await sha256(rp.id);
  if (!crypto.subtle.timingSafeEqual(authData.subarray(0, 32), want)) fail('rpId mismatch');
  const flags = authData[32];
  if ((flags & 0x01) === 0) fail('user not present');
  if ((flags & 0x04) === 0) fail('user not verified');
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  return { flags, signCount };
}

/** Verifies a navigator.credentials.create() response; returns the new credential. */
export async function register(rp: RP, challenge: string, credentialID: string, authData: Uint8Array, clientData: Uint8Array): Promise<Credential> {
  await checkClientData(rp, clientData, 'webauthn.create', challenge);
  const { flags, signCount } = await checkAuthData(rp, authData);
  if ((flags & 0x40) === 0 || authData.length < 55) fail('no attested credential data');
  const idLen = (authData[53] << 8) | authData[54];
  if (authData.length < 55 + idLen) fail('credential id truncated');
  const credID = authData.subarray(55, 55 + idLen);
  if (b64url(credID) !== credentialID) fail('credential id mismatch');
  let key: unknown;
  try {
    [key] = decodeCBOR(authData, 55 + idLen, 0);
  } catch (e) {
    return fail('public key: ' + (e as Error).message);
  }
  const { x, y } = await coseES256(key);
  return { id: credentialID, x, y, signCount };
}

/** Verifies a navigator.credentials.get() response; returns the new counter. */
export async function assert(rp: RP, cred: Credential, challenge: string, authData: Uint8Array, clientData: Uint8Array, sig: Uint8Array): Promise<number> {
  await checkClientData(rp, clientData, 'webauthn.get', challenge);
  const { signCount } = await checkAuthData(rp, authData);
  const pub = await publicKey(cred.x, cred.y);
  const cdHash = await sha256(clientData);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(cdHash, authData.length);
  if (!(await verifySig(pub, signed, sig))) fail('signature invalid');
  // Authenticators that do not count always report 0; once a credential has
  // counted, the value must strictly increase.
  if (cred.signCount > 0 && signCount <= cred.signCount) fail('signature counter did not increase (cloned authenticator?)');
  return signCount;
}

/**
 * WebAuthn mandates ASN.1 DER signatures; WebCrypto verifies raw r||s. Like
 * the Go code, a raw 64-byte r||s is accepted too, for lenient clients.
 */
async function verifySig(pub: CryptoKey, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const alg = { name: 'ECDSA', hash: 'SHA-256' };
  const raw = derToRaw(sig);
  if (raw && (await crypto.subtle.verify(alg, pub, raw, data))) return true;
  return sig.length === 64 && crypto.subtle.verify(alg, pub, sig, data);
}

/** Parses SEQUENCE { INTEGER r, INTEGER s } into 64-byte r||s, or null. */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  let p = 0;
  const byte = () => (p < der.length ? der[p++] : -1);
  if (byte() !== 0x30) return null;
  let len = byte();
  if (len === 0x81) len = byte();
  if (len < 0 || len !== der.length - p) return null;
  const out = new Uint8Array(64);
  for (let i = 0; i < 2; i++) {
    if (byte() !== 0x02) return null;
    let n = byte();
    if (n <= 0 || p + n > der.length) return null;
    let v = der.subarray(p, p + n);
    p += n;
    if (v[0] & 0x80) return null; // negative integers are invalid here
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    n = v.length;
    if (n > 32) return null;
    out.set(v, i * 32 + 32 - n);
  }
  return p === der.length ? out : null;
}

async function publicKey(x: Uint8Array, y: Uint8Array): Promise<CryptoKey> {
  if (x.length !== 32 || y.length !== 32) fail('malformed EC public key');
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 33);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return fail('public key is not on P-256');
  }
}

async function coseES256(v: unknown): Promise<{ x: Uint8Array; y: Uint8Array }> {
  if (!(v instanceof Map)) return fail('COSE key is not a map');
  if (v.get(1) !== 2 || v.get(3) !== -7 || v.get(-1) !== 1) fail('only ES256 (EC2 P-256) passkeys are supported');
  const x = v.get(-2);
  const y = v.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) return fail('malformed EC public key');
  await publicKey(x, y);
  return { x, y };
}

/**
 * Decodes the subset of CBOR used by COSE keys: integers, byte and text
 * strings, arrays, maps and simple values. Integers become numbers (COSE
 * labels and the values glasshelf reads are small).
 */
export function decodeCBOR(b: Uint8Array, pos: number, depth: number): [unknown, number] {
  if (depth > 8) throw new Error('cbor nesting too deep');
  if (pos >= b.length) throw new Error('cbor truncated');
  const major = b[pos] >> 5;
  const ai = b[pos] & 31;
  pos++;
  if (major === 7) {
    switch (ai) {
      case 20: return [false, pos];
      case 21: return [true, pos];
      case 22: case 23: return [null, pos];
    }
    throw new Error('unsupported cbor simple value');
  }
  let arg = 0n;
  if (ai < 24) {
    arg = BigInt(ai);
  } else if (ai <= 27) {
    const n = 1 << (ai - 24);
    if (pos + n > b.length) throw new Error('cbor truncated');
    for (const c of b.subarray(pos, pos + n)) arg = (arg << 8n) | BigInt(c);
    pos += n;
  } else {
    throw new Error('indefinite cbor length not supported');
  }
  if (arg > 1n << 20n && major >= 2) throw new Error('cbor item too large');
  const num = (v: bigint) => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
  switch (major) {
    case 0: return [num(arg), pos];
    case 1: return [num(-1n - arg), pos];
    case 2: case 3: {
      const end = pos + Number(arg);
      if (end > b.length) throw new Error('cbor truncated');
      if (major === 3) return [new TextDecoder().decode(b.subarray(pos, end)), end];
      return [b.slice(pos, end), end];
    }
    case 4: {
      const arr: unknown[] = [];
      for (let i = 0n; i < arg; i++) {
        const [v, next] = decodeCBOR(b, pos, depth + 1);
        arr.push(v);
        pos = next;
      }
      return [arr, pos];
    }
    case 5: {
      const m = new Map<unknown, unknown>();
      for (let i = 0n; i < arg; i++) {
        const [k, next] = decodeCBOR(b, pos, depth + 1);
        const [v, next2] = decodeCBOR(b, next, depth + 1);
        if (typeof k !== 'number' && typeof k !== 'bigint' && typeof k !== 'string') throw new Error('unsupported cbor map key');
        m.set(k, v);
        pos = next2;
      }
      return [m, pos];
    }
  }
  throw new Error('unsupported cbor type');
}

