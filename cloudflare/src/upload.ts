// Uploads: a streaming multipart/form-data parser that writes each file
// straight to R2 (small files in one put, large ones as an R2 multipart upload
// in fixed 8 MiB parts, so memory stays bounded), plus the JSON upload body.
import type { Ctx } from './env';
import type { FileMeta } from './store';
import {
  HttpError, bool, cleanName, concat, contentType, dec, decodeB64, enc, goQuote, optStr, readBody, str, strList, truncate,
} from './util';

export const MAX_FILES_PER_VERSION = 500;
/** JSON and MCP bodies are decoded in memory; large uploads use multipart. */
export const MAX_JSON_BODY = 32 << 20;
const PART_SIZE = 8 << 20;
const MAX_FIELD = 1 << 20;
const MAX_HEADER = 16 << 10;

export interface Meta {
  title?: string;
  tags?: string[];
  note?: string;
  pinned?: boolean;
  entry: string;
  message: string;
  /** New version: carry over files not re-uploaded. */
  keep: boolean;
}

interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<number>;
  abort(): Promise<void>;
}

/** Streams one file into R2, switching to a multipart upload past 8 MiB. */
class R2Sink implements Sink {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private total = 0;
  private upload?: R2MultipartUpload;
  private parts: R2UploadedPart[] = [];

  constructor(private bucket: R2Bucket, private key: string) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (!chunk.byteLength) return;
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    this.total += chunk.byteLength;
    while (this.buffered >= PART_SIZE) {
      const all = concat(this.chunks, this.buffered);
      this.upload ??= await this.bucket.createMultipartUpload(this.key);
      this.parts.push(await this.upload.uploadPart(this.parts.length + 1, all.subarray(0, PART_SIZE)));
      const rest = all.subarray(PART_SIZE);
      this.chunks = rest.byteLength ? [rest] : [];
      this.buffered = rest.byteLength;
    }
  }

  async close(): Promise<number> {
    const rest = concat(this.chunks, this.buffered);
    if (!this.upload) {
      await this.bucket.put(this.key, rest);
    } else {
      if (rest.byteLength) this.parts.push(await this.upload.uploadPart(this.parts.length + 1, rest));
      await this.upload.complete(this.parts);
    }
    this.chunks = [];
    return this.total;
  }

  async abort(): Promise<void> {
    await this.upload?.abort().catch(() => {});
  }
}

const discard: Sink = { write: async () => {}, close: async () => 0, abort: async () => {} };

/**
 * Collects the files of one new version. Names are validated as they arrive;
 * the version number is reserved lazily (reserve()) right before the first
 * write, so failed requests rarely burn one. abort() removes what was written.
 */
export class VersionWriter {
  readonly files: FileMeta[] = [];
  n = 0;
  private seen = new Set<string>();
  private written: string[] = [];
  private order: number[] = [];
  private open?: Sink;

  constructor(
    private c: Ctx,
    readonly id: string,
    private reserve: () => Promise<number>,
    private unreserve: (n: number) => Promise<void> = async () => {},
  ) {}

  get count(): number {
    return this.files.length;
  }

  async version(): Promise<number> {
    if (!this.n) this.n = await this.reserve();
    return this.n;
  }

  /** Starts a file; group orders files like Go's files, file, files[] keys. */
  async begin(rawName: string, group = 0): Promise<{ sink: Sink; done: (size: number) => void }> {
    const name = cleanName(rawName);
    if (this.seen.has(name)) throw new HttpError(400, `duplicate file ${goQuote(name)}`);
    this.seen.add(name);
    if (this.files.length >= MAX_FILES_PER_VERSION) throw new HttpError(400, `at most ${MAX_FILES_PER_VERSION} files per version`);
    const n = await this.version();
    const key = `artifacts/${this.id}/v${n}/${name}`;
    this.written.push(key);
    const sink = new R2Sink(this.c.files, key);
    this.open = sink;
    return {
      sink,
      done: (size) => {
        this.open = undefined;
        this.files.push({ name, size, type: contentType(name) });
        this.order.push(group);
      },
    };
  }

  async put(rawName: string, data: Uint8Array): Promise<void> {
    const { sink, done } = await this.begin(rawName);
    await sink.write(data);
    done(await sink.close());
  }

  /** Files in Go's order: grouped by form key, then upload order. */
  sorted(): FileMeta[] {
    return this.files.map((f, i) => ({ f, g: this.order[i] ?? 0, i })).sort((a, b) => a.g - b.g || a.i - b.i).map((x) => x.f);
  }

  async abort(): Promise<void> {
    await this.open?.abort();
    if (this.written.length) await this.c.files.delete(this.written).catch(() => {});
    if (this.n) await this.unreserve(this.n).catch(() => {});
  }
}

function tooLarge(c: Ctx): HttpError {
  return new HttpError(413, `upload too large: the limit is ${c.maxUpload >> 20} MB (multipart) and 32 MB (JSON); raise it with the MAX_UPLOAD_MB variable`);
}

/**
 * parseUpload reads multipart/form-data (fields: title, tags, note, entry,
 * message, keep, files[]) or JSON ({title, tags, files:[{name, content,
 * encoding}]}) and writes the files through w.
 */
export async function parseUpload(c: Ctx, req: Request, w: VersionWriter): Promise<Meta> {
  const ct = req.headers.get('Content-Type') ?? '';
  const multipart = ct.toLowerCase().startsWith('multipart/form-data');
  const limit = multipart ? c.maxUpload : Math.min(c.maxUpload, MAX_JSON_BODY);
  if (Number(req.headers.get('Content-Length') ?? '') > limit) throw tooLarge(c);
  if (multipart) return parseMultipartUpload(c, req, w, ct);
  if (ct.toLowerCase().startsWith('application/json')) return parseJSONUpload(c, req, w, limit);
  throw new HttpError(400, 'send multipart/form-data or application/json');
}

async function parseJSONUpload(c: Ctx, req: Request, w: VersionWriter, limit: number): Promise<Meta> {
  const raw = await readBody(req, limit, tooLarge(c).message);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(dec.decode(raw));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid JSON body');
  const meta = jsonMeta(body);
  const files = decodeJSONFiles(body.files ?? body.Files);
  if (files.length > MAX_FILES_PER_VERSION) throw new HttpError(400, `at most ${MAX_FILES_PER_VERSION} files per version`);
  for (const f of files) await w.put(f.name, f.data);
  return meta;
}

export function jsonMeta(body: Record<string, unknown>): Meta {
  return {
    title: optStr(body, 'title'),
    tags: strList(body, 'tags'),
    note: optStr(body, 'note'),
    pinned: bool(body, 'pinned'),
    entry: str(body, 'entry'),
    message: str(body, 'message'),
    keep: bool(body, 'keep') ?? false,
  };
}

/** Decodes [{name, content, encoding}] as sent by JSON uploads and MCP. */
export function decodeJSONFiles(v: unknown): { name: string; data: Uint8Array }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'invalid JSON body');
  return v.map((f) => {
    if (f === null || typeof f !== 'object') throw new HttpError(400, 'invalid JSON body');
    const o = f as Record<string, unknown>;
    const name = str(o, 'name');
    const content = str(o, 'content');
    if (str(o, 'encoding') === 'base64') {
      const data = decodeB64(content);
      if (!data) throw new HttpError(400, `file ${goQuote(name)}: invalid base64`);
      return { name, data };
    }
    return { name, data: enc.encode(content) };
  });
}

// ---------- multipart ----------

const FILE_KEYS = ['files', 'file', 'files[]'];

async function parseMultipartUpload(c: Ctx, req: Request, w: VersionWriter, ct: string): Promise<Meta> {
  const boundary = parseHeaderValue(ct).params.boundary;
  if (!boundary || boundary.length > 70) throw new HttpError(400, 'malformed upload: no multipart boundary param in Content-Type');
  const values = new Map<string, string[]>();
  await parseMultipart(req.body, boundary, c.maxUpload, () => tooLarge(c), {
    field(name, value) {
      const list = values.get(name) ?? [];
      list.push(value);
      values.set(name, list);
    },
    async file(name, filename) {
      const group = FILE_KEYS.indexOf(name);
      if (group < 0) return { sink: discard, done: () => {} };
      return w.begin(filename, group);
    },
  });
  const first = (k: string) => values.get(k)?.[0];
  const keep = first('keep');
  return {
    title: first('title'),
    note: first('note'),
    tags: values.get('tags'),
    entry: first('entry') ?? '',
    message: first('message') ?? '',
    keep: keep === '1' || keep === 'true',
  };
}

/** Index of needle in hay at or after from, using native indexOf for the first byte. */
function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const last = hay.length - needle.length;
  for (let i = from; i <= last; i++) {
    i = hay.indexOf(first, i);
    if (i < 0 || i > last) return -1;
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

export interface MultipartHandlers {
  field(name: string, value: string): void;
  file(name: string, filename: string): Promise<{ sink: Sink; done: (size: number) => void }>;
}

const malformed = (why: string) => new HttpError(400, 'malformed upload: ' + why);

/** Streams a multipart body; file parts go to sinks chunk by chunk. */
export async function parseMultipart(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
  limit: number,
  tooBig: () => Error,
  h: MultipartHandlers,
): Promise<void> {
  if (!body) throw malformed('empty body');
  const reader = body.getReader();
  const delim = enc.encode('\r\n--' + boundary);
  const CRLF = enc.encode('\r\n');
  // A leading CRLF makes the first boundary look like every later one.
  let buf: Uint8Array = CRLF;
  let total = 0;
  let eof = false;
  const more = async (): Promise<boolean> => {
    if (eof) return false;
    const { done, value } = await reader.read();
    if (done) {
      eof = true;
      return false;
    }
    total += value.byteLength;
    if (total > limit) throw tooBig();
    buf = buf.byteLength ? concat([buf, value]) : value;
    return true;
  };
  try {
    // Preamble.
    for (;;) {
      const i = indexOf(buf, delim);
      if (i >= 0) {
        buf = buf.subarray(i + delim.length);
        break;
      }
      if (buf.byteLength > MAX_HEADER) buf = buf.subarray(buf.byteLength - delim.length);
      if (!(await more())) throw malformed('no multipart boundary found');
    }
    for (;;) {
      // After a boundary: "--" ends the body, else optional spaces then CRLF.
      while (buf.byteLength < 2) if (!(await more())) throw malformed('unexpected end of body');
      if (buf[0] === 0x2d && buf[1] === 0x2d) break;
      let eol: number;
      while ((eol = indexOf(buf, CRLF)) < 0) {
        if (buf.byteLength > 256 || !(await more())) throw malformed('bad boundary line');
      }
      if (buf.subarray(0, eol).some((b) => b !== 0x20 && b !== 0x09)) throw malformed('bad boundary line');
      buf = buf.subarray(eol + 2);
      // Part headers.
      let headerEnd: number;
      for (;;) {
        if (buf.byteLength >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) {
          headerEnd = 0;
          break;
        }
        headerEnd = indexOf(buf, enc.encode('\r\n\r\n'));
        if (headerEnd >= 0) {
          headerEnd += 2;
          break;
        }
        if (buf.byteLength > MAX_HEADER) throw malformed('part headers too large');
        if (!(await more())) throw malformed('unexpected end of body');
      }
      const headers = dec.decode(buf.subarray(0, headerEnd));
      buf = buf.subarray(headerEnd + 2);
      let disposition = '';
      for (const line of headers.split('\r\n')) {
        const k = line.indexOf(':');
        if (k > 0 && line.slice(0, k).trim().toLowerCase() === 'content-disposition') disposition = line.slice(k + 1).trim();
      }
      const { params } = parseHeaderValue(disposition);
      const name = params.name ?? '';
      const filename = params.filename;
      // Part body.
      let target: { sink: Sink; done: (size: number) => void } | null = null;
      const valueParts: Uint8Array[] = [];
      let valueSize = 0;
      if (filename) target = await h.file(name, filename);
      const emit = async (chunk: Uint8Array) => {
        if (!chunk.byteLength) return;
        if (target) return target.sink.write(chunk);
        valueSize += chunk.byteLength;
        if (valueSize > MAX_FIELD) throw malformed(`field ${name} too large`);
        valueParts.push(chunk);
      };
      for (;;) {
        const i = indexOf(buf, delim);
        if (i >= 0) {
          await emit(buf.subarray(0, i));
          buf = buf.subarray(i + delim.length);
          break;
        }
        const keep = delim.length - 1;
        if (buf.byteLength > keep) {
          await emit(buf.subarray(0, buf.byteLength - keep));
          buf = buf.subarray(buf.byteLength - keep);
        }
        if (!(await more())) throw malformed('unexpected end of body');
      }
      if (target) target.done(await target.sink.close());
      else h.field(name, dec.decode(concat(valueParts, valueSize)));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Parses `type; key=value; key="quoted"; key*=UTF-8''pct` like mime.ParseMediaType. */
export function parseHeaderValue(v: string): { type: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const semi = v.indexOf(';');
  const type = (semi < 0 ? v : v.slice(0, semi)).trim().toLowerCase();
  let rest = semi < 0 ? '' : v.slice(semi + 1);
  const extended: Record<string, string> = {};
  while (rest.length) {
    rest = rest.replace(/^[\s;]+/, '');
    const m = /^([^\s=;]+)\s*=\s*/.exec(rest);
    if (!m) break;
    const key = m[1].toLowerCase();
    rest = rest.slice(m[0].length);
    let value = '';
    if (rest.startsWith('"')) {
      let i = 1;
      for (; i < rest.length && rest[i] !== '"'; i++) {
        if (rest[i] === '\\' && i + 1 < rest.length) i++;
        value += rest[i];
      }
      rest = rest.slice(i + 1);
    } else {
      const end = rest.search(/[;\s]/);
      value = end < 0 ? rest : rest.slice(0, end);
      rest = end < 0 ? '' : rest.slice(end);
    }
    if (key.endsWith('*')) {
      const ext = /^([^']*)'[^']*'(.*)$/.exec(value);
      if (ext) {
        try {
          extended[key.slice(0, -1)] = /^utf-8$/i.test(ext[1]) || ext[1] === '' ? decodeURIComponent(ext[2]) : unescape(ext[2]);
        } catch {
          /* ignore malformed */
        }
      }
    } else if (!(key in params)) {
      params[key] = value;
    }
  }
  return { type, params: { ...params, ...extended } };
}

/** Merges meta into an artifact update, like the Go server's applyMeta. */
export function metaUpdates(m: Meta): { title?: string; tags?: string[]; note?: string; pinned?: boolean } {
  const u: { title?: string; tags?: string[]; note?: string; pinned?: boolean } = {};
  if (m.title !== undefined && m.title.trim() !== '') u.title = truncate(m.title, 160);
  if (m.tags !== undefined) u.tags = m.tags;
  if (m.note !== undefined) u.note = truncate(m.note, 4000);
  if (m.pinned !== undefined) u.pinned = m.pinned;
  return u;
}
