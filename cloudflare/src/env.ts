// Per-request server context: the Go server's Config and Server fields,
// resolved from Worker vars, secrets and the request.
import { BRAND } from './brand';
import { b64url, randomBytes, unb64url } from './util';

declare global {
  interface Env {
    /** First-run and recovery secret: `wrangler secret put SETUP_TOKEN`. */
    SETUP_TOKEN?: string;
    /** Webhook URLs (comma or space separated); keep it a secret, URLs often embed keys. */
    WEBHOOKS?: string;
  }
}

export interface Ctx {
  env: Env;
  db: D1Database;
  files: R2Bucket;
  req: Request;
  url: URL;
  /** Origin users browse, e.g. https://9artifacts.me.workers.dev (no trailing slash). */
  publicURL: string;
  /** Separate content origin, or "" when content shares the app origin. */
  contentURL: string;
  appHost: string;
  /** Content host, "" in single-origin mode. */
  contHost: string;
  /** True when this request arrived on the content host. */
  onContent: boolean;
  name: string;
  version: string;
  maxUpload: number;
  sharesOnContent: boolean;
  artifactCSP: string;
  webhooks: string[];
  ip: string;
  waitUntil(p: Promise<unknown>): void;
  signKey(): Promise<Uint8Array>;
}

const WORKERS_DEV = '.workers.dev';

function originOf(u: string): URL | null {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x : null;
  } catch {
    return null;
  }
}

/** 9artifacts.me.workers.dev → 9artifacts-content.me.workers.dev */
function contentSibling(u: URL): string {
  const [first, ...rest] = u.hostname.split('.');
  return `${u.protocol}//${first}-content.${rest.join('.')}${u.port ? ':' + u.port : ''}`;
}

/**
 * Resolves the app and content origins. With CONTENT_URL=auto on workers.dev
 * the content Worker is the app Worker's name plus "-content"; requests that
 * arrive there (through the service binding) carry that host.
 */
export function resolveOrigins(env: Env, url: URL): { publicURL: string; contentURL: string } {
  const configured = (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  const mode = (env.CONTENT_URL ?? '').trim().replace(/\/+$/, '');
  let publicURL = configured;
  if (!publicURL) {
    const [first, ...rest] = url.hostname.split('.');
    if (mode === 'auto' && url.hostname.endsWith(WORKERS_DEV) && first.endsWith('-content')) {
      publicURL = `${url.protocol}//${first.slice(0, -'-content'.length)}.${rest.join('.')}${url.port ? ':' + url.port : ''}`;
    } else {
      publicURL = url.origin;
    }
  }
  let contentURL = '';
  if (mode === 'auto') {
    const pub = originOf(publicURL);
    if (pub && pub.hostname.endsWith(WORKERS_DEV)) contentURL = contentSibling(pub);
  } else if (mode) {
    contentURL = mode;
  }
  return { publicURL, contentURL };
}

let signKeyCache: { db: D1Database; key: Promise<Uint8Array> } | null = null;

/** The HMAC key for view tokens, grants and visitor hashes, created once in D1. */
function loadSignKey(db: D1Database): Promise<Uint8Array> {
  if (signKeyCache && signKeyCache.db === db) return signKeyCache.key;
  const key = (async () => {
    await db.prepare(`INSERT OR IGNORE INTO kv (k, v) VALUES ('signing_key', ?)`).bind(b64url(randomBytes(32))).run();
    const row = await db.prepare(`SELECT v FROM kv WHERE k = 'signing_key'`).first<{ v: string }>();
    const raw = row ? unb64url(row.v) : null;
    if (!raw || raw.length < 32) throw new Error('signing key missing');
    return raw;
  })();
  key.catch(() => {
    if (signKeyCache?.key === key) signKeyCache = null;
  });
  signKeyCache = { db, key };
  return key;
}

export function newCtx(req: Request, env: Env, exec: ExecutionContext): Ctx {
  const url = new URL(req.url);
  const { publicURL, contentURL } = resolveOrigins(env, url);
  const pub = originOf(publicURL);
  if (!pub) throw new Error(`invalid PUBLIC_URL ${JSON.stringify(publicURL)}`);
  let contHost = '';
  if (contentURL) {
    const cu = originOf(contentURL);
    if (!cu) throw new Error(`invalid CONTENT_URL ${JSON.stringify(contentURL)}`);
    if (cu.host.toLowerCase() === pub.host.toLowerCase()) throw new Error('CONTENT_URL must use a different host than PUBLIC_URL');
    contHost = cu.host.toLowerCase();
  }
  const sharesOnContent = /^(1|true|on|yes)$/i.test(env.SHARES_ON_CONTENT ?? '');
  if (sharesOnContent && !contentURL) throw new Error('SHARES_ON_CONTENT needs a content origin (CONTENT_URL)');
  const mb = Number(env.MAX_UPLOAD_MB);
  return {
    env,
    db: env.DB,
    files: env.FILES,
    req,
    url,
    publicURL,
    contentURL,
    appHost: pub.host.toLowerCase(),
    contHost,
    onContent: contHost !== '' && url.host.toLowerCase() === contHost,
    name: env.NAME || BRAND,
    version: env.VERSION || 'cf',
    maxUpload: (Number.isFinite(mb) && mb > 0 ? mb : 50) * (1 << 20),
    sharesOnContent,
    artifactCSP: env.ARTIFACT_CSP ?? '',
    webhooks: (env.WEBHOOKS ?? '').split(/[\s,]+/).filter(Boolean),
    ip: req.headers.get('CF-Connecting-IP') ?? 'unknown',
    waitUntil: (p) => exec.waitUntil(p.catch((e) => console.error('background task:', String(e)))),
    signKey: () => loadSignKey(env.DB),
  };
}

/** The origin sandboxed artifact bytes are served from. */
export function contentOrigin(c: Ctx): string {
  return c.contentURL || c.publicURL;
}

export function shareURL(c: Ctx, token: string): string {
  return (c.sharesOnContent ? c.contentURL : c.publicURL) + '/s/' + token;
}

export const isHTTPS = (c: Ctx): boolean => c.publicURL.startsWith('https://');
