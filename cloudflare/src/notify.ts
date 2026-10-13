// Webhooks (internal/app/notify.go): best-effort POSTs after the response,
// via ctx.waitUntil. Share tokens are never sent, only the private URL.
import { BRAND } from './brand';
import type { Ctx } from './env';
import { goQuote } from './util';

export type EventKind = 'artifact.published' | 'artifact.version' | 'share.created' | 'share.visited';

export interface EventItem {
  id: string;
  title: string;
  url: string;
  version: number;
}

const DESCRIBE: Record<EventKind, string> = {
  'artifact.published': 'New artifact',
  'artifact.version': 'New version',
  'share.created': 'Public link created',
  'share.visited': 'Public link opened',
};

/** hookHost keeps webhook secrets (paths, query strings) out of the log. */
export function hookHost(hook: string): string {
  try {
    return new URL(hook.replace(/^ntfy\+/, '')).host;
  } catch {
    return '?';
  }
}

function validHook(hook: string): boolean {
  try {
    const u = new URL(hook.replace(/^ntfy\+/, ''));
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.host !== '';
  } catch {
    return false;
  }
}

export function notify(c: Ctx, kind: EventKind, it: EventItem, detail: string): void {
  if (!c.webhooks.length) return;
  let msg = `${DESCRIBE[kind]}: ${goQuote(it.title)} v${it.version}`;
  if (detail) msg += ` (${detail})`;
  const ev = { event: kind, text: msg + '\n' + it.url, content: msg + '\n' + it.url, artifact: it, at: new Date().toISOString() };
  for (const hook of c.webhooks) c.waitUntil(deliver(c, hook, ev, msg));
}

async function deliver(c: Ctx, hook: string, ev: { artifact: EventItem }, msg: string): Promise<void> {
  if (!validHook(hook)) {
    console.log(`webhook ${hookHost(hook)}: invalid webhook URL (use https://… or ntfy+https://…)`);
    return;
  }
  const headers: Record<string, string> = { 'User-Agent': BRAND + '/' + c.version };
  let target = hook;
  let body: string;
  if (hook.startsWith('ntfy+')) {
    // ntfy: plain-text message, title and click-through link as headers.
    target = hook.slice(5);
    body = msg;
    headers.Title = c.name;
    headers.Click = ev.artifact.url;
    headers.Tags = 'framed_picture';
  } else {
    body = JSON.stringify(ev);
    headers['Content-Type'] = 'application/json';
  }
  try {
    const resp = await fetch(target, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    await resp.body?.cancel();
    if (resp.status >= 300) console.log(`webhook ${hookHost(hook)}: HTTP ${resp.status}`);
  } catch (e) {
    console.log(`webhook ${hookHost(hook)}: ${(e as Error).name}`);
  }
}
