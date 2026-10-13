// A minimal Model Context Protocol server (internal/app/mcp.go): streamable
// HTTP transport, JSON responses, no server-initiated messages.
// Authenticate with "Authorization: Bearer vt_...".
import { addVersion, createArtifact, createShare, deleteArtifact, listArtifacts, nextVersionWriter, restoreVersion, revokeShare } from './api';
import { tokenAuth } from './auth';
import type { Ctx } from './env';
import { DESIGN_MD, TEMPLATE_HTML } from './generated/web';
import { fileKey, getArtifact, getVersion } from './store';
import { MAX_JSON_BODY, type Meta, VersionWriter, decodeJSONFiles } from './upload';
import { HttpError, cleanName, dec, field, goQuote, json, newID, readBody } from './util';

const INSTRUCTIONS = `vitrine is the user's private, self-hosted artifact gallery.
Publish finished HTML, Markdown, SVG, images or PDFs here and give the user the private URL.
Before writing an artifact, call get_design_guide and follow it so the result matches the owner's style.
To change an artifact, publish again with its id: the URL stays the same and open viewers refresh.
Never create public share links unless the user explicitly asks for one.`;

function schema(props: Record<string, unknown>, ...required: string[]) {
  return { type: 'object', properties: props, required };
}

const strProp = { type: 'string' };
const fileList = {
  type: 'array',
  description: 'Files of the artifact. Use index.html (or a single .md) as the entry; siblings like style.css or img/chart.png are referenced relatively.',
  items: schema(
    {
      name: { type: 'string', description: 'Relative path, e.g. index.html or assets/logo.png' },
      content: { type: 'string', description: 'File content' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'utf8 (default) for text, base64 for binary' },
    },
    'name',
    'content',
  ),
};

export const MCP_TOOLS = [
  { name: 'get_design_guide', description: "Get the owner's design guide (design.md) and starter HTML template. Call this before writing a new artifact.", inputSchema: schema({}) },
  {
    name: 'publish_artifact',
    description: 'Publish a new artifact, or a new version of an existing one when id is given (the URL stays the same). Returns the private URL for the user.',
    inputSchema: schema(
      {
        id: { type: 'string', description: 'Existing artifact id to update; omit to create a new artifact' },
        title: strProp,
        files: fileList,
        tags: { type: 'array', items: strProp },
        note: { type: 'string', description: 'Private note shown only to the owner' },
        message: { type: 'string', description: 'Short description of what changed in this version' },
        replace_all_files: { type: 'boolean', description: 'When updating: drop files not sent in this call. Default false keeps them, so you can resend only the changed files.' },
      },
      'files',
    ),
  },
  { name: 'list_artifacts', description: 'List artifacts, newest first.', inputSchema: schema({ query: strProp, tag: strProp, limit: { type: 'integer' } }) },
  {
    name: 'read_artifact',
    description: 'Read the text content of an artifact file (default: the entry file of the latest version), e.g. to edit and republish it.',
    inputSchema: schema({ id: strProp, file: strProp, version: { type: 'integer' } }, 'id'),
  },
  {
    name: 'share_artifact',
    description: 'Create a PUBLIC expiring link anyone can open. Only call this when the user explicitly asks to share publicly.',
    inputSchema: schema(
      {
        id: strProp,
        ttl: { type: 'string', enum: ['1h', '24h', '7d', '30d'] },
        note: { type: 'string', description: 'Public note shown on the share page' },
        max_views: { type: 'integer', description: 'Stop working after this many distinct visitors (omit for unlimited)' },
        password: { type: 'string', description: 'Only when the user gives one: viewers must enter it' },
      },
      'id',
      'ttl',
    ),
  },
  { name: 'revoke_share', description: 'Revoke a public share link immediately.', inputSchema: schema({ id: strProp, token: strProp }, 'id', 'token') },
  {
    name: 'restore_version',
    description: 'Publish an earlier version again as the new latest version (history is kept). Use when the user wants to undo changes.',
    inputSchema: schema({ id: strProp, version: { type: 'integer', description: 'Version number to restore' } }, 'id', 'version'),
  },
  { name: 'delete_artifact', description: 'Permanently delete an artifact and all its versions. Only when the user explicitly asks.', inputSchema: schema({ id: strProp }, 'id') },
];

interface RPCRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMCP(c: Ctx): Promise<Response> {
  if (!(await tokenAuth(c))) {
    return json(401, { error: 'send Authorization: Bearer <vitrine API token>' }, { 'WWW-Authenticate': 'Bearer realm="vitrine"' });
  }
  let raw: string;
  try {
    raw = dec.decode(await readBody(c.req, Math.min(c.maxUpload, MAX_JSON_BODY))).trim();
  } catch {
    return json(413, { error: 'request larger than 32 MB; use the REST API with multipart/form-data for big files' });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(200, rpcError(null, -32700, 'parse error'));
  }
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const req of body) {
      const resp = await dispatch(c, req as RPCRequest);
      if (resp) out.push(resp);
    }
    return out.length ? json(200, out) : new Response(null, { status: 202 });
  }
  if (body === null || typeof body !== 'object') return json(200, rpcError(null, -32700, 'parse error'));
  const resp = await dispatch(c, body as RPCRequest);
  return resp ? json(200, resp) : new Response(null, { status: 202 });
}

/** dispatch returns null for notifications, which get no response. */
async function dispatch(c: Ctx, req: RPCRequest): Promise<unknown> {
  if (req === null || typeof req !== 'object' || req.id === undefined || req.id === null) return null;
  const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
  switch (req.method) {
    case 'initialize': {
      const pv = typeof params.protocolVersion === 'string' && params.protocolVersion ? params.protocolVersion : '2025-06-18';
      return ok({ protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'vitrine', version: c.version }, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: MCP_TOOLS });
    case 'tools/call': {
      if (typeof params.name !== 'string' && params.name !== undefined) return rpcError(req.id, -32602, 'invalid params');
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      try {
        const text = await call(c, String(params.name ?? ''), args);
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        if (!(e instanceof HttpError)) console.error('mcp tool error:', String(e));
        return ok({ content: [{ type: 'text', text: 'Error: ' + (e as Error).message }], isError: true });
      }
    }
  }
  return rpcError(req.id, -32601, 'method not found: ' + String(req.method));
}

// Lenient argument readers: Go ignores type errors for most tools.
const s = (a: Record<string, unknown>, k: string) => {
  const v = field(a, k);
  return typeof v === 'string' ? v : '';
};
const n = (a: Record<string, unknown>, k: string) => {
  const v = field(a, k);
  return typeof v === 'number' && Number.isInteger(v) ? v : 0;
};

const utcMinute = (iso: string) => iso.slice(0, 16).replace('T', ' ');

async function call(c: Ctx, name: string, a: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'get_design_guide':
      return DESIGN_MD + '\n\n# Starter template (template.html)\n\n```html\n' + TEMPLATE_HTML + '\n```';

    case 'publish_artifact': {
      const files = decodeJSONFiles(field(a, 'files'));
      const tags = field(a, 'tags');
      const title = field(a, 'title');
      const note = field(a, 'note');
      const m: Meta = {
        title: typeof title === 'string' ? title : undefined,
        tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : undefined,
        note: typeof note === 'string' ? note : undefined,
        entry: '',
        message: s(a, 'message'),
        keep: field(a, 'replace_all_files') !== true,
      };
      const id = s(a, 'id');
      if (id && !(await getArtifact(c, id))) throw new HttpError(404, 'artifact not found');
      const w = id ? nextVersionWriter(c, id) : new VersionWriter(c, newID(8), async () => 1);
      try {
        for (const f of files) await w.put(f.name, f.data);
      } catch (e) {
        await w.abort();
        throw e;
      }
      const out = id ? await addVersion(c, id, m, w) : await createArtifact(c, m, w);
      return `Published ${goQuote(out.title)} (id ${out.id}, version ${out.version}).\nPrivate URL (owner login required): ${out.url}`;
    }

    case 'list_artifacts': {
      const query = s(a, 'query').toLowerCase();
      const tag = s(a, 'tag').toLowerCase();
      let limit = n(a, 'limit');
      if (limit <= 0 || limit > 200) limit = 50;
      const lines: string[] = [];
      for (const { a: art, latest } of await listArtifacts(c)) {
        const hay = `${art.title} ${art.tags.join(' ')}`.toLowerCase();
        if (query && !hay.includes(query)) continue;
        if (tag && !art.tags.includes(tag)) continue;
        if (lines.length >= limit) break;
        lines.push(`- ${art.id} — ${goQuote(art.title)} v${latest.n} [${art.tags.join(', ')}] updated ${utcMinute(art.updatedAt)} ${c.publicURL}/a/${art.id}\n`);
      }
      return lines.length ? lines.join('') : 'No artifacts found.';
    }

    case 'read_artifact': {
      const id = s(a, 'id');
      const [art, v] = await Promise.all([getArtifact(c, id), getVersion(c, id, n(a, 'version'))]);
      if (!art || !v) throw new HttpError(404, 'artifact or version not found');
      const file = s(a, 'file') || v.entry;
      const clean = cleanName(file);
      const names = v.files.map((f) => f.name);
      const f = v.files.find((x) => x.name === clean);
      if (!f) throw new HttpError(404, `no file ${goQuote(file)}; files: ${names.join(', ')}`);
      const obj = await c.files.get(fileKey(id, v.n, f));
      if (!obj) throw new HttpError(404, `${clean}: file missing from storage`);
      const bytes = new Uint8Array(await obj.arrayBuffer());
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        throw new HttpError(400, `${clean} is binary (${bytes.length} bytes)`);
      }
      if (bytes.length > 400_000) text = dec.decode(bytes.subarray(0, 400_000));
      return `Artifact ${goQuote(art.title)} v${v.n}, file ${clean} (files: ${names.join(', ')})\n\n${text}`;
    }

    case 'share_artifact': {
      const sh = await createShare(c, s(a, 'id'), { ttl: s(a, 'ttl'), note: s(a, 'note'), version: 0, maxViews: n(a, 'max_views'), password: s(a, 'password') });
      return `Public link (expires ${utcMinute(sh.expiresAt as string)} UTC): ${sh.url}\nRevoke token: ${sh.token}`;
    }

    case 'revoke_share':
      await revokeShare(c, s(a, 'id'), s(a, 'token'));
      return 'Share revoked.';

    case 'restore_version': {
      const version = n(a, 'version');
      const out = await restoreVersion(c, s(a, 'id'), version);
      return `Restored v${version} as v${out.version}: ${out.url}`;
    }

    case 'delete_artifact':
      await deleteArtifact(c, s(a, 'id'));
      return 'Artifact deleted.';
  }
  throw new HttpError(400, `unknown tool ${goQuote(name)}`);
}
