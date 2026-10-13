// Port of internal/markdown: renders the everyday subset of Markdown that
// agents write into safe HTML. Raw HTML in the source is escaped, never passed
// through, and only http(s), mailto, fragments and relative URLs are linked.
import { escapeHTML } from './util';

// Go's regexp \s is ASCII whitespace; spell it out so JS matches the same.
const S = '[\\t\\n\\f\\r ]';
const reFence = new RegExp(`^${S}*\`\`\``);
const reHeading = new RegExp(`^(#{1,6})${S}+(.+?)${S}*#*${S}*$`);
const reRule = new RegExp(`^${S}*(?:-{3,}|\\*${S}*\\*${S}*\\*[\\t\\n\\f\\r *]*|_{3,})${S}*$`);
const reQuote = new RegExp(`^${S}*>${S}?`);
const reUL = new RegExp(`^${S}*[-*+]${S}+(.*)$`);
const reOL = new RegExp(`^${S}*\\d+[.)]${S}+(.*)$`);
const reTask = new RegExp(`^\\[([ xX])\\]${S}+`);
const reTableSep = new RegExp(`^${S}*\\|?${S}*:?-{3,}:?${S}*(?:\\|${S}*:?-{3,}:?${S}*)*\\|?${S}*$`);
const reParaBreak = new RegExp(`^${S}*(?:\`\`\`|#{1,6}${S}|>|[-*+]${S}+|\\d+[.)]${S}+)`);
const reCode = /`([^`\n]+)`/g;
const reImage = new RegExp(`!\\[([^\\]]*)\\]\\(([^)\\t\\n\\f\\r \\x00]+)(?:${S}+&quot;[^&]*&quot;)?\\)`, 'g');
const reLink = new RegExp(`\\[([^\\]]+)\\]\\(([^)\\t\\n\\f\\r \\x00]+)(?:${S}+&quot;[^&]*&quot;)?\\)`, 'g');
const reAuto = new RegExp(`(^|[\\t\\n\\f\\r (])(https?://[^\\t\\n\\f\\r <)\\x00]+)`, 'g');
const reStrong = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;
const reEm = /(^|[^*\w])\*([^*\n]+)\*|(^|[^_\w])_([^_\n]+)_/g;
const reStrike = /~~([^~\n]+)~~/g;
const reScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const reLang = /^[A-Za-z0-9_+-]+$/;

/** Reverses escapeHTML (all safeURL ever sees is escapeHTML output). */
function unescapeHTML(s: string): string {
  return s.replace(/&(amp|lt|gt|#39|#34|quot);/g, (_, e: string) =>
    ({ amp: '&', lt: '<', gt: '>', '#39': "'", '#34': '"', quot: '"' })[e]!);
}

function safeURL(escaped: string): string {
  const u = unescapeHTML(escaped.trim());
  if (reScheme.test(u)) {
    const lower = u.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://') && !lower.startsWith('mailto:')) return '';
  }
  return escapeHTML(u);
}

/**
 * inline formats one line. Every generated tag is stashed behind a
 * placeholder before the next pass runs, so later passes (autolinks,
 * emphasis) only ever see escaped text, never markup.
 */
function inline(s: string): string {
  const stash: string[] = [];
  const hide = (html: string) => {
    stash.push(html);
    return '\x00' + (stash.length - 1) + '\x00';
  };
  s = escapeHTML(s.replaceAll('\x00', ''));
  s = s.replace(reCode, (m) => hide('<code>' + m.slice(1, -1) + '</code>'));
  s = s.replace(reImage, (_m, alt: string, url: string) => {
    const u = safeURL(url);
    return u ? hide(`<img src="${u}" alt="${alt}" loading="lazy">`) : alt;
  });
  s = s.replace(reLink, (_m, label: string, url: string) => {
    const u = safeURL(url);
    return u ? hide(`<a href="${u}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`) : label;
  });
  s = s.replace(reAuto, (_m, pre: string, url: string) =>
    pre + hide(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = emphasis(s);
  for (let i = stash.length - 1; i >= 0; i--) s = s.replace('\x00' + i + '\x00', () => stash[i]);
  return s;
}

function emphasis(s: string): string {
  s = s.replace(reStrong, '<strong>$1$2</strong>');
  s = s.replace(reEm, '$1$3<em>$2$4</em>');
  return s.replace(reStrike, '<del>$1</del>');
}

function cells(line: string): string[] {
  line = line.trim();
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|')) line = line.slice(0, -1);
  return line.split('|').map((p) => p.trim());
}

/** Render converts Markdown to an HTML fragment. */
export function render(src: string): string {
  const lines = src.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  let out = '';
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
    } else if (reFence.test(line)) {
      const lang = (line.trim().slice(3) + ' ').split(/\s+/).filter(Boolean);
      i++;
      const code: string[] = [];
      while (i < lines.length && !reFence.test(lines[i])) code.push(lines[i++]);
      i++;
      const cls = lang.length > 0 && reLang.test(lang[0]) ? ` class="language-${lang[0]}"` : '';
      out += `<pre><code${cls}>${escapeHTML(code.join('\n'))}</code></pre>\n`;
    } else if (reHeading.test(line)) {
      const m = reHeading.exec(line)!;
      const n = m[1].length;
      out += `<h${n}>${inline(m[2])}</h${n}>\n`;
      i++;
    } else if (reRule.test(line)) {
      out += '<hr>\n';
      i++;
    } else if (reQuote.test(line)) {
      const q: string[] = [];
      while (i < lines.length && reQuote.test(lines[i])) q.push(lines[i++].replace(reQuote, ''));
      out += '<blockquote>' + render(q.join('\n')) + '</blockquote>\n';
    } else if (reUL.test(line) || reOL.test(line)) {
      const [re, tag] = reOL.test(line) ? [reOL, 'ol'] : [reUL, 'ul'];
      out += `<${tag}>`;
      while (i < lines.length && re.test(lines[i])) {
        let item = re.exec(lines[i])![1];
        const t = reTask.exec(item);
        if (t) {
          const checked = t[1] !== ' ' ? ' checked' : '';
          item = item.replace(reTask, '');
          out += `<li class="task"><input type="checkbox" disabled${checked}> ${inline(item)}</li>`;
        } else {
          out += `<li>${inline(item)}</li>`;
        }
        i++;
      }
      out += `</${tag}>\n`;
    } else if (line.includes('|') && i + 1 < lines.length && reTableSep.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      out += '<div class="table-wrap"><table><thead><tr>';
      for (const c of head) out += `<th>${inline(c)}</th>`;
      out += '</tr></thead><tbody>';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const row = cells(lines[i]);
        out += '<tr>';
        for (let j = 0; j < head.length; j++) out += `<td>${inline(j < row.length ? row[j] : '')}</td>`;
        out += '</tr>';
        i++;
      }
      out += '</tbody></table></div>\n';
    } else {
      const para = [inline(line)];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !reParaBreak.test(lines[i])) para.push(inline(lines[i++]));
      out += '<p>' + para.join('<br>') + '</p>\n';
    }
  }
  return out;
}

/** Title returns the text of the first level-one heading, if any. */
export function title(src: string): string {
  for (const line of src.split('\n')) {
    const m = reHeading.exec(line);
    if (m && m[1].length === 1) return m[2];
  }
  return '';
}
