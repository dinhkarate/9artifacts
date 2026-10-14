// Test helpers: call the Worker's fetch handler directly (so each test can set
// its own vars), with a fresh client address per Client.
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index';
import { hashSecret } from '../src/util';

export const APP = 'http://localhost:8080';
export const CONTENT = 'http://content.localhost:8080';

/** Empties D1 and R2 and re-applies the migrations. */
export async function fresh(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

let ipSeq = 1;

export class Client {
  ip: string;
  cookie = '';
  constructor(
    public vars: Partial<Env> = { PUBLIC_URL: APP, CONTENT_URL: '' },
    public token = '',
  ) {
    this.ip = `198.51.100.${ipSeq++ % 250}`;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', this.ip);
    const req = new Request(url.startsWith('http') ? url : (this.vars.PUBLIC_URL || APP) + url, { ...init, headers, redirect: 'manual' });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, ...this.vars } as Env, ctx);
    await waitOnExecutionContext(ctx);
    return resp;
  }

  /** Bearer-token request with an optional JSON body. */
  api(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + this.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return this.fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** Browser-style request with the session cookie and CSRF header. */
  browser(method: string, path: string, body?: unknown, csrf = true): Promise<Response> {
    const headers: Record<string, string> = { Cookie: this.cookie };
    if (csrf) headers['X-9artifacts'] = '1';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return this.fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** Multipart upload like `curl -F` or the Go CLI. */
  upload(path: string, fields: Record<string, string>, files: Record<string, string | Uint8Array>): Promise<Response> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const [name, content] of Object.entries(files)) fd.append('files', new File([content], name, { type: 'application/octet-stream' }));
    return this.fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + this.token }, body: fd });
  }

  keepCookie(resp: Response): void {
    const set = resp.headers.get('Set-Cookie');
    if (set) this.cookie = set.split(';')[0];
  }
}

/** Creates an API token directly in D1 and returns its plaintext. */
export async function makeToken(name = 'test'): Promise<string> {
  const secret = 'vt_test_' + crypto.randomUUID().replaceAll('-', '');
  await env.DB.prepare('INSERT INTO tokens (id, name, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID().slice(0, 8), name, await hashSecret(secret), secret.slice(0, 7), new Date().toISOString())
    .run();
  return secret;
}

export async function body<T = Record<string, any>>(resp: Response): Promise<T> {
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HTTP ${resp.status}: not JSON: ${text.slice(0, 300)}`);
  }
}

/** Path part of an absolute URL. */
export const pathOf = (u: string) => new URL(u).pathname + new URL(u).search;
