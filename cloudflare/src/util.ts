// Small helpers shared by every module: encodings, ids, hashing, JSON
// responses and the validation rules copied from the Go server.
import { Buffer } from 'node:buffer';

export const enc = new TextEncoder();
export const dec = new TextDecoder();

// ---------- encodings ----------

/** Unpadded base64url, Go's base64.RawURLEncoding. */
export function b64url(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64url');
}

/** Strict RawURLEncoding decode: url alphabet, no padding. */
export function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** Go's decodeB64: standard alphabet, padded or (after trimming '=') raw. */
export function decodeB64(s: string): Uint8Array | null {
  s = s.trim();
  const padded = s.length % 4 === 0 && /^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s);
  if (!padded) {
    s = s.replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) return null;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function hex(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('hex');
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase unpadded base32 of n random bytes, like the Go server's newID. */
export function newID(n: number): string {
  const b = randomBytes(n);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function concat(parts: Uint8Array[], total?: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total ?? parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// ---------- hashing ----------

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const d = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', d));
}

/** hex SHA-256, used for API tokens and session ids (hashSecret in Go). */
export async function hashSecret(v: string): Promise<string> {
  return hex(await sha256(v));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

export async function hmac(rawKey: Uint8Array, msg: string): Promise<Uint8Array> {
  const id = b64url(rawKey);
  let key = hmacKeys.get(id);
  if (!key) {
    key = crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(id, key);
  }
  return new Uint8Array(await crypto.subtle.sign('HMAC', await key, enc.encode(msg)));
}

/** Constant-time string comparison (compares digests, so lengths may differ). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(x, y) && a.length === b.length;
}

// ---------- strings ----------

/** Go's truncate: trims, then keeps at most n runes. */
export function truncate(s: string, n: number): string {
  s = s.trim();
  const runes = Array.from(s);
  return runes.length > n ? runes.slice(0, n).join('') : s;
}

/** normTags lowercases, trims, de-duplicates and caps tag lists. */
export function normTags(input: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of input ?? []) {
    for (let t of raw.split(',')) {
      t = t.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-');
      if (t === '' || enc.encode(t).byteLength > 40 || out.includes(t)) continue;
      out.push(t);
      if (out.length === 20) return out;
    }
  }
  return out;
}

const segmentRe = /^[A-Za-z0-9_][A-Za-z0-9._ ()+-]{0,127}$/;

/** cleanName validates an uploaded path such as "assets/chart.png". */
export function cleanName(name: string): string {
  name = name.trim().replaceAll('\\', '/');
  if (name.startsWith('./')) name = name.slice(2);
  if (name === '' || enc.encode(name).byteLength > 300) throw new HttpError(400, 'invalid file name');
  const parts = name.split('/');
  if (parts.length > 8) throw new HttpError(400, 'file path too deep');
  for (const p of parts) {
    if (!segmentRe.test(p) || p.includes('..')) {
      throw new HttpError(400, `invalid file name ${goQuote(name)} (letters, digits, . _ - only)`);
    }
  }
  return parts.join('/');
}

/** Approximates Go's %q for the strings 9artifacts prints. */
export function goQuote(s: string): string {
  return JSON.stringify(s).replace(/\\u([0-9a-f]{4})/g, (_, h: string) => '\\x' + h.slice(2)).replaceAll('\\/', '/');
}

export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i).toLowerCase();
}

export function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
  '.xml': 'application/xml', '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8', '.go': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.sql': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

/** Content type from a fixed table, never from the uploader. */
export function contentType(name: string): string {
  return mimeTypes[extOf(name)] ?? 'application/octet-stream';
}

// ---------- HTTP ----------

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** writeJSON: compact JSON with a trailing newline, never cached. */
export function json(status: number, value: unknown, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(value) + '\n', { status, headers: h });
}

export function jsonError(status: number, msg: string): Response {
  return json(status, { error: msg });
}

/** http.Error: plain text body with a trailing newline. */
export function textError(status: number, msg: string): Response {
  return new Response(msg + '\n', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

export const notFound = (): Response => textError(404, '404 page not found');

export const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 410: 'Gone', 413: 'Request Entity Too Large', 429: 'Too Many Requests', 500: 'Internal Server Error',
};

/** Reads a request body up to limit bytes; larger bodies throw 413. */
export async function readBody(req: Request, limit: number, tooLarge = 'request body too large'): Promise<Uint8Array> {
  const cl = Number(req.headers.get('Content-Length') ?? '');
  if (cl > limit) throw new HttpError(413, tooLarge);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, tooLarge);
    }
    parts.push(value);
  }
  return concat(parts, total);
}

/** readJSON: a JSON object of at most 1 MB, else 400 "invalid JSON body". */
export async function readJSON(req: Request): Promise<Record<string, unknown>> {
  let v: unknown;
  try {
    v = JSON.parse(dec.decode(await readBody(req, 1 << 20)));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'invalid JSON body');
  return v as Record<string, unknown>;
}

/**
 * Go's encoding/json matches object keys to struct fields case-insensitively;
 * field() does the same so clients written against the Go server keep working.
 */
export function field(obj: Record<string, unknown>, name: string): unknown {
  if (name in obj) return obj[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

export function str(obj: Record<string, unknown>, name: string): string {
  const v = field(obj, name);
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'invalid JSON body');
  return v;
}

export function optStr(obj: Record<string, unknown>, name: string): string | undefined {
  const v = field(obj, name);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, 'invalid JSON body');
  return v;
}

export function int(obj: Record<string, unknown>, name: string): number {
  const v = field(obj, name);
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new HttpError(400, 'invalid JSON body');
  return v;
}

export function bool(obj: Record<string, unknown>, name: string): boolean | undefined {
  const v = field(obj, name);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new HttpError(400, 'invalid JSON body');
  return v;
}

export function strList(obj: Record<string, unknown>, name: string): string[] | undefined {
  const v = field(obj, name);
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, 'invalid JSON body');
  return v as string[];
}

/** HTML-escapes like Go's html.EscapeString. */
export function escapeHTML(s: string): string {
  return s.replace(/[&'<>"]/g, (c) => ({ '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '"': '&#34;' })[c]!);
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1 << 20)).toFixed(1)} MB`;
}

export const nowISO = (): string => new Date().toISOString();
