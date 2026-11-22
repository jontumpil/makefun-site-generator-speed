// site-generator-speed: a fast drop-in for makefun-site 1.0.0.
// Written from the makefun-site README spec. Behaviour matches the reference
// byte-for-byte; the structure is tuned for speed: a single-pass Markdown
// renderer, hand-rolled template trees, cached slugs, and no per-line regexes
// on the hot paths. Dependency-free ES module: run(input) -> output tree.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------------- text ---------------- */

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** HTML-escape `s`; fast path when nothing needs escaping. */
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ENT[c]) : s;
}

/** Whether code unit `c` is a JS \s whitespace character. */
function isSpaceChar(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const SLUG_MAX = 64;
const slugCache = new Map();

/** The slug of `text` (see the spec's Text section); results cached, pure function. */
function slugify(text) {
  let out = slugCache.get(text);
  if (out !== undefined) return out;
  out = slugifyCompute(text);
  slugCache.set(text, out);
  return out;
}

function slugifyCompute(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  // NFKD + combining-mark removal is the identity on pure ASCII, so skip it there.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  let n = 2;
  while (taken.has(out)) out = `${slug}-${n++}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/* ---------------- front matter ---------------- */

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmStringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? +m[1] : 0;
      const mo = m ? +m[2] : 0;
      const d = m ? +m[3] : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The body is sliced out of the
 * source instead of split-and-joined, so the body text is scanned only once.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // Find the close line: a line that is exactly "---".
  let closeStart = -1;
  let idx = text.indexOf('\n---', 3);
  while (idx !== -1) {
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = idx;
      break;
    }
    idx = text.indexOf('\n---', after);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeStart);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const afterClose = closeStart + 4;
  let body;
  if (afterClose >= text.length) body = '';
  else if (text.charCodeAt(afterClose) === 10) body = text.slice(afterClose + 1);
  else body = text.slice(afterClose);
  return { data, body };
}

/* ---------------- Markdown ---------------- */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/** A line of spaces and tabs only (blank). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null when the line is no fence open. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === n ? lang : null;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let i = d;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let e = line.length;
  while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === i) return null;
  return { depth: d, text: line.slice(i, e) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (c0 === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet-list line's item text, or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered-list line's number and item text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < 9 && i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: +line.slice(0, i), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isSpaceChar(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * A `what` at j is escaped exactly when the run of backslashes right before it
 * (from `from` on) is odd, so indexOf finds the candidates and a short walk
 * back settles each one. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      n++;
      k--;
    }
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      n++;
      k--;
    }
    if (n % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

// One shared scan regex: inline recurses, so the caller saves and restores
// lastIndex around each recursive call instead of allocating a regex per call.
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline, appended to `out`. `link(target)` is a link's href.
 * One pass: the regex scan jumps straight from one markup character to the next,
 * so plain runs are copied verbatim (they hold no escapable character) and
 * only the markup characters are handled one by one.
 */
function inline(s, link, out) {
  const re = INLINE_RE;
  re.lastIndex = 0;
  const n = s.length;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      // backslash: an escapable next character is written (escaped); any other \ is itself.
      const d = s[i + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        if (i > last) out.push(s.slice(last, i));
        out.push(ENT[d] ?? d);
        last = i + 2;
        re.lastIndex = i + 2;
      }
      continue;
    }
    if (c === '`') {
      // code span, closed by the next backtick, with at least one character between.
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > last) out.push(s.slice(last, i));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        last = j + 1;
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > last) out.push(s.slice(last, i));
          out.push('<strong>');
          const saved = re.lastIndex;
          inline(s.slice(i + 2, j), link, out);
          re.lastIndex = saved;
          out.push('</strong>');
          last = j + 2;
          re.lastIndex = j + 2;
        } else re.lastIndex = i + 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > last) out.push(s.slice(last, i));
          out.push('<em>');
          const saved = re.lastIndex;
          inline(s.slice(i + 1, j), link, out);
          re.lastIndex = saved;
          out.push('</em>');
          last = j + 1;
          re.lastIndex = j + 1;
        }
      }
      continue;
    }
    if (c === '[') {
      // [text](target): the first unescaped ] closes the text, ( must follow at once.
      const k = findUnescaped(s, ']', i + 1);
      const j = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = j === -1 ? '' : s.slice(k + 2, j);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > last) out.push(s.slice(last, i));
        out.push('<a href="', esc(link(target)), '">');
        const saved = re.lastIndex;
        inline(s.slice(i + 1, k), link, out);
        re.lastIndex = saved;
        out.push('</a>');
        last = j + 1;
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (i > last) out.push(s.slice(last, i));
    out.push(ENT[c]);
    last = i + 1;
  }
  if (n > last) out.push(s.slice(last, n));
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push('<pre><code' + (lang === '' ? '' : ` class="language-${esc(lang)}"`) + '>');
      for (const l of body) {
        out.push(esc(l));
        out.push('\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      const parts = [];
      inline(h.text, link, parts);
      const html = parts.join('');
      out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inline(body.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bText = bulletOf(line);
    const o = bText === null ? orderedOf(line) : null;
    if (bText !== null || o !== null) {
      const ordered = o !== null;
      const items = [];
      const start = ordered ? o.num : 1;
      while (i < n) {
        const m = ordered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(ordered ? m.text : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(ordered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const parts of items) {
        out.push('<li>');
        inline(parts.join('\n'), link, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    if (excerpt === null) {
      // The first paragraph's HTML is also the excerpt, so it needs its own string.
      const parts = [];
      inline(body.join('\n'), link, parts);
      excerpt = parts.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inline(body.join('\n'), link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

/* ---------------- templates ---------------- */

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Node kinds: 0 text, 1 {{ var }}, 2 {{{ raw }}}, 3 if, 4 for, 5 include.
// A node is an array: [kind, ...fields]. An if is [3, not, path, then, else|null];
// a for is [4, name, path, body]; an include is [5, name].

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ k: 0, node: null, body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) {
      body.push([0, tok.text]);
      continue;
    }
    if (tok.t === 1 || tok.t === 2) {
      body.push([tok.t, tok.path]);
      continue;
    }
    const tag = tok.tag;
    let m;
    if ((m = TPL_FOR.exec(tag)) !== null) {
      const node = [4, m[1], tplPathOf(name, m[2]), []];
      body.push(node);
      const fr = { k: 4, node, body: node[3] };
      stack.push(fr);
      body = fr.body;
    } else if ((m = TPL_IF.exec(tag)) !== null) {
      const node = [3, m[1] !== undefined, tplPathOf(name, m[2]), [], null];
      body.push(node);
      const fr = { k: 3, node, body: node[3] };
      stack.push(fr);
      body = fr.body;
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.k !== 3 || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.node[4] = [];
      top.body = top.node[4];
      body = top.body;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 4 : 3;
      if (stack[stack.length - 1].k !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push([5, m[1]]);
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 3 ? 'if' : 'for'} is not closed`);
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest frame holding it. */
function lookup(frames, path) {
  let v;
  let found = false;
  for (let s = frames.length - 1; s >= 0; s--) {
    if (Object.hasOwn(frames[s], path[0])) {
      v = frames[s][path[0]];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of strings) in the scope chain `frames`
 * (an array of variable frames, innermost last). `ctx.templates` holds the
 * parsed templates. A for-loop reuses one frame object across its iterations:
 * rendering is synchronous, so no iteration can observe the next one's values.
 */
function renderNodes(nodes, frames, ctx, out, depth) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    const k = n[0];
    if (k === 0) {
      out.push(n[1]);
      continue;
    }
    if (k === 1) {
      out.push(esc(textOf(lookup(frames, n[1]))));
      continue;
    }
    if (k === 2) {
      out.push(textOf(lookup(frames, n[1])));
      continue;
    }
    if (k === 3) {
      const v = truthy(lookup(frames, n[2]));
      const branch = v !== n[1] ? n[3] : n[4];
      if (branch !== null) renderNodes(branch, frames, ctx, out, depth);
      continue;
    }
    if (k === 4) {
      const xs = lookup(frames, n[2]);
      if (!Array.isArray(xs)) continue;
      const len = xs.length;
      const frame = {};
      const loop = { index: 0, first: false, last: false, length: len };
      frame[n[1]] = undefined;
      frame.loop = loop;
      frames.push(frame);
      for (let j = 0; j < len; j++) {
        frame[n[1]] = xs[j];
        loop.index = j + 1;
        loop.first = j === 0;
        loop.last = j === len - 1;
        renderNodes(n[3], frames, ctx, out, depth);
      }
      frames.pop();
      continue;
    }
    const t = ctx.templates.get(n[1]);
    if (t !== undefined && depth < INCLUDE_DEPTH) {
      const cached = ctx.cache.get(n[1]);
      if (cached !== undefined) out.push(cached);
      else renderNodes(t, frames, ctx, out, depth + 1);
    }
  }
}

/** Render template `nodes` with root variables `vars`; returns the string. */
function renderTemplate(nodes, vars, ctx) {
  const out = [];
  renderNodes(nodes, [vars], ctx, out, 0);
  return out.join('');
}

/**
 * The first path segments a template reads, following includes transitively.
 * Names bound by the template's own for-loops (the loop variable and `loop`)
 * are local and skipped; a binding never crosses an include boundary, so an
 * included template is always walked with a fresh, empty bound set. A template
 * whose every dependency is one of the build-wide globals (site, tags, recent)
 * renders the same string for every page of a case, so it can be rendered once
 * and reused.
 */
function templateDeps(nodes, templates) {
  const deps = new Set();
  const seen = new Set();
  const walk = (ns, bound) => {
    for (const n of ns) {
      const k = n[0];
      if (k === 1 || k === 2) {
        if (!bound.has(n[1][0])) deps.add(n[1][0]);
      } else if (k === 3) {
        if (!bound.has(n[2][0])) deps.add(n[2][0]);
        walk(n[3], bound);
        if (n[4] !== null) walk(n[4], bound);
      } else if (k === 4) {
        if (!bound.has(n[2][0])) deps.add(n[2][0]);
        const inner = new Set(bound);
        inner.add(n[1]);
        inner.add('loop');
        walk(n[3], inner);
      } else if (k === 5) {
        if (!seen.has(n[1])) {
          seen.add(n[1]);
          const t = templates.get(n[1]);
          if (t !== undefined) walk(t, new Set());
        }
      }
    }
  };
  walk(nodes, new Set());
  return deps;
}

/* ---------------- the build ---------------- */

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A link target with a scheme (https:, mailto: ...). */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** One site's output tree: path -> text. */
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let path = null;
      if (rel !== '') {
        const parts = dirParts.slice();
        let ok = true;
        for (const seg of rel.split('/')) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') {
            if (parts.length === 0) {
              ok = false;
              break;
            }
            parts.pop();
          } else parts.push(seg);
        }
        path = ok ? parts.join('/') : null;
      }
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  // A post's card, as lists show it (built once per source, reused by its layout).
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, cache: new Map() };
  const globals = { site, tags: allTags, recent };
  // Templates that read only the build-wide globals render identically for
  // every page: render each once and reuse the string at every include.
  for (const [name, nodes] of templates) {
    const deps = templateDeps(nodes, templates);
    let constant = true;
    for (const d of deps) {
      if (d !== 'site' && d !== 'tags' && d !== 'recent') {
        constant = false;
        break;
      }
    }
    if (constant) ctx.cache.set(name, renderTemplate(nodes, globals, ctx));
  }
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const cached = ctx.cache.get(name);
    if (cached !== undefined) return cached;
    return renderTemplate(nodes, { site, tags: allTags, recent, ...vars }, ctx);
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
