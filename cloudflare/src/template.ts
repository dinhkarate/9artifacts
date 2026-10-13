// A small interpreter for the subset of Go's html/template that web/index.html
// and web/share.html use, so the Worker renders the Go server's templates
// unchanged: {{.Field}}, {{if}}/{{else if}}/{{else}}/{{end}}, {{range}},
// parenthesised calls and the functions eq, ne, or, and, not, len, bytes.
// Every value is HTML-escaped on output, which is safe in the text and
// quoted-attribute contexts these templates use.
import { humanBytes } from './util';

type Node =
  | { t: 'text'; v: string }
  | { t: 'out'; e: Expr }
  | { t: 'if'; branches: { cond: Expr | null; body: Node[] }[] }
  | { t: 'range'; e: Expr; body: Node[]; else: Node[] };

type Expr =
  | { t: 'field'; path: string[] }
  | { t: 'lit'; v: unknown }
  | { t: 'call'; fn: string; args: Expr[] };

const FUNCS: Record<string, (...a: unknown[]) => unknown> = {
  eq: (a, ...b) => b.some((x) => x === a),
  ne: (a, b) => a !== b,
  or: (...a) => a.find(truthy) ?? a[a.length - 1],
  and: (...a) => a.find((x) => !truthy(x)) ?? a[a.length - 1],
  not: (a) => !truthy(a),
  len: (a) => (typeof a === 'string' || Array.isArray(a) ? a.length : a && typeof a === 'object' ? Object.keys(a).length : 0),
  bytes: (a) => humanBytes(Number(a)),
};

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+/g;
  for (const m of src.matchAll(re)) out.push(m[0]);
  return out;
}

function parseExpr(tokens: string[]): Expr {
  let pos = 0;
  const operand = (): Expr => {
    const tok = tokens[pos++];
    if (tok === undefined) throw new Error('template: missing operand');
    if (tok === '(') {
      const e = command(')');
      if (tokens[pos++] !== ')') throw new Error('template: unclosed (');
      return e;
    }
    if (tok === '.') return { t: 'field', path: [] };
    if (tok.startsWith('.')) return { t: 'field', path: tok.slice(1).split('.') };
    if (tok.startsWith('"')) return { t: 'lit', v: JSON.parse(tok) };
    if (/^-?\d+$/.test(tok)) return { t: 'lit', v: Number(tok) };
    if (tok === 'true' || tok === 'false') return { t: 'lit', v: tok === 'true' };
    if (tok in FUNCS) return { t: 'call', fn: tok, args: [] };
    throw new Error(`template: unknown token ${tok}`);
  };
  const command = (stop?: string): Expr => {
    const first = operand();
    if (first.t !== 'call') return first;
    while (pos < tokens.length && tokens[pos] !== stop) first.args.push(operand());
    return first;
  };
  const e = command();
  if (pos !== tokens.length) throw new Error('template: unexpected ' + tokens[pos]);
  return e;
}

export function parse(src: string): Node[] {
  const re = /\{\{(.*?)\}\}/gs;
  const root: Node[] = [];
  // Stack of open blocks; each frame knows where new nodes go.
  type Frame = { node: Extract<Node, { t: 'if' } | { t: 'range' }>; target: Node[]; inElse: boolean };
  const stack: Frame[] = [];
  let target = root;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) target.push({ t: 'text', v: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    const action = m[1].trim();
    const [kw, ...rest] = tokenize(action);
    if (kw === 'if') {
      const node: Node = { t: 'if', branches: [{ cond: parseExpr(rest), body: [] }] };
      target.push(node);
      stack.push({ node, target, inElse: false });
      target = node.branches[0].body;
    } else if (kw === 'range') {
      const node: Node = { t: 'range', e: parseExpr(rest), body: [], else: [] };
      target.push(node);
      stack.push({ node, target, inElse: false });
      target = node.body;
    } else if (kw === 'else') {
      const f = stack[stack.length - 1];
      if (!f || f.inElse) throw new Error('template: unexpected else');
      if (f.node.t === 'range') {
        f.inElse = true;
        target = f.node.else;
      } else if (rest[0] === 'if') {
        const b = { cond: parseExpr(rest.slice(1)), body: [] as Node[] };
        f.node.branches.push(b);
        target = b.body;
      } else {
        f.inElse = true;
        const b = { cond: null, body: [] as Node[] };
        f.node.branches.push(b);
        target = b.body;
      }
    } else if (kw === 'end') {
      const f = stack.pop();
      if (!f) throw new Error('template: unexpected end');
      target = f.target;
    } else {
      target.push({ t: 'out', e: parseExpr(tokenize(action)) });
    }
  }
  if (stack.length) throw new Error('template: missing end');
  if (last < src.length) target.push({ t: 'text', v: src.slice(last) });
  return root;
}

function evalExpr(e: Expr, dot: unknown): unknown {
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'field': {
      let v = dot;
      for (const p of e.path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined;
      return v;
    }
    case 'call':
      return FUNCS[e.fn](...e.args.map((a) => evalExpr(a, dot)));
  }
}

// Go's html/template text escaper.
function escape(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[&'<>"+\0]/g, (c) =>
    ({ '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '"': '&#34;', '+': '&#43;', '\0': '�' })[c]!);
}

function exec(nodes: Node[], dot: unknown): string {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += n.v;
        break;
      case 'out':
        out += escape(evalExpr(n.e, dot));
        break;
      case 'if':
        for (const b of n.branches) {
          if (b.cond === null || truthy(evalExpr(b.cond, dot))) {
            out += exec(b.body, dot);
            break;
          }
        }
        break;
      case 'range': {
        const items = evalExpr(n.e, dot);
        if (Array.isArray(items) && items.length) for (const it of items) out += exec(n.body, it);
        else out += exec(n.else, dot);
        break;
      }
    }
  }
  return out;
}

const cache = new Map<string, Node[]>();

export function renderTemplate(src: string, data: Record<string, unknown>): string {
  let tree = cache.get(src);
  if (!tree) {
    tree = parse(src);
    cache.set(src, tree);
  }
  return exec(tree, data);
}
