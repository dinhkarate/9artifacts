// Share-link passwords. The Go server uses PBKDF2-SHA256 with 600,000
// iterations; a Worker on the free plan has 10 ms of CPU per request (and
// WebCrypto caps PBKDF2 at 100,000 iterations), so this edition uses 10,000.
// That is much weaker against offline guessing if the D1 database leaks;
// online guessing is rate-limited per address like the Go server. The encoded
// format is the Go server's ("pbkdf2-sha256$<iter>$<salt>$<key>").
import { b64url, randomBytes, unb64url } from './util';

export const SHARE_PBKDF2_ITERATIONS = 10_000;
const MAX_ITERATIONS = 100_000;

async function derive(pw: string, salt: Uint8Array, iter: number, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, bytes * 8);
  return new Uint8Array(bits);
}

export async function hashSharePassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pw, salt, SHARE_PBKDF2_ITERATIONS, 32);
  return `pbkdf2-sha256$${SHARE_PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(key)}`;
}

export async function checkSharePassword(pw: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iter = Number(parts[1]);
  const salt = unb64url(parts[2]);
  const want = unb64url(parts[3]);
  if (!Number.isInteger(iter) || iter < 1 || iter > MAX_ITERATIONS || !salt || !want || !want.length) return false;
  const got = await derive(pw, salt, iter, want.length);
  return crypto.subtle.timingSafeEqual(got, want);
}
