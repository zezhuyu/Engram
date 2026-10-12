/**
 * Fast path for the front matter that Engram itself writes (`YAML.stringify` of the document metadata).
 *
 * It understands only a small, conservative subset of block YAML and returns `undefined` for anything else, in which case the caller uses the full YAML parser:
 * nested block mappings, block sequences of plain scalars or mappings, empty `[]` / `{}`, integers, `true` / `false` / `null` and plain strings.
 * Quoted scalars, block scalars, folded or multi-line scalars, anchors, tags, comments, flow collections with content, tabs, CR, duplicate keys,
 * sequences of anything but plain scalars and simple mappings, ambiguous plain scalars (numbers other than plain integers, yes/no/on/off, `~`) and odd indentation are never interpreted here.
 * A value that this parser returns is, by construction and by differential test, deeply equal to what `YAML.parse` returns for the same text.
 */
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|__proto__)$/i;
/** First character of a plain scalar we accept: a letter, digit, underscore or any non-ASCII character that is not whitespace-like (checked separately). */
const PLAIN_START = new RegExp('^[A-Za-z0-9_\u00A1-\uFFFF]');
/** Characters that could change the meaning or the extent of a plain scalar (control characters, Unicode spaces and line separators, BOM). */
const UNSAFE = new RegExp('[\\u0000-\\u001F\\u007F-\\u00A0\\u1680\\u2000-\\u200F\\u2028-\\u202F\\u205F-\\u206F\\u3000\\uFEFF\\uD800-\\uDFFF]');
const AMBIGUOUS_WORD = /^(?:true|false|null|yes|no|on|off|y|n)$/i;
const INTEGER = /^(?:0|[1-9][0-9]{0,14})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function scalar(text: string): Value | undefined {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (!text || !PLAIN_START.test(text) || UNSAFE.test(text)) return undefined;
  if (text.endsWith(' ') || text.endsWith(':') || text.includes(': ') || text.includes(' #') || text.includes('\t')) return undefined;
  if (AMBIGUOUS_WORD.test(text)) return undefined;
  const first = text.charCodeAt(0);
  if (first >= 48 && first <= 57) { // a leading digit: only a plain integer or the timestamp shape the writer emits is certain to be what the YAML parser returns
    if (INTEGER.test(text)) return Number(text);
    return TIMESTAMP.test(text) ? text : undefined;
  }
  return text;
}

interface Line { indent: number; text: string }

/** Parses the block starting at `lines[at]` with the given indent; returns the value and the index after it, or undefined when anything is outside the subset. */
function block(lines: Line[], at: number, indent: number): { value: Value; next: number } | undefined {
  const first = lines[at]; if (!first || first.indent !== indent) return undefined;
  if (first.text.startsWith('- ') || first.text === '-') {
    const items: Value[] = []; let i = at;
    while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')) {
      const rest = lines[i]!.text.slice(2); const colon = rest.indexOf(':');
      if (colon > 0 && KEY.test(rest.slice(0, colon)) && (colon === rest.length - 1 || rest[colon + 1] === ' ')) { // a mapping item: its first key sits after the dash, the other keys at the same column
        lines[i] = { indent: indent + 2, text: rest }; const parsed = block(lines, i, indent + 2);
        if (!parsed || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) return undefined;
        items.push(parsed.value); i = parsed.next; continue;
      }
      const item = scalar(rest); if (item === undefined) return undefined; items.push(item); i++;
    }
    if (!items.length) return undefined;
    if (i < lines.length && lines[i]!.indent > indent) return undefined; // continuation of a scalar or a mapping item: not ours
    return { value: items, next: i };
  }
  const object: { [key: string]: Value } = {}; let i = at;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!.text; const colon = line.indexOf(':'); if (colon <= 0) return undefined;
    const key = line.slice(0, colon); if (!KEY.test(key) || RESERVED.test(key) || Object.hasOwn(object, key)) return undefined;
    const rest = line.slice(colon + 1);
    if (rest === '') { // nested block: must be indented by exactly two more columns
      const child = lines[i + 1]; if (!child || child.indent !== indent + 2) return undefined;
      const parsed = block(lines, i + 1, indent + 2); if (!parsed) return undefined;
      object[key] = parsed.value; i = parsed.next; continue;
    }
    if (rest[0] !== ' ' || rest.length < 2 || rest[1] === ' ') return undefined;
    const value = scalar(rest.slice(1)); if (value === undefined) return undefined;
    object[key] = value; i++;
    if (i < lines.length && lines[i]!.indent > indent) return undefined; // a deeper line after a scalar is a continuation (folded scalar)
  }
  if (i < lines.length && lines[i]!.indent > indent) return undefined;
  return { value: object, next: i };
}

/** The parsed front matter as a plain object, or undefined when the text is outside the fast subset (the caller then uses the full YAML parser). */
export function parseFrontmatterFast(source: string): Record<string, unknown> | undefined {
  if (source.includes('\r') || source.includes('\t') || source.includes('\n\n') || source.startsWith('\n') || source.endsWith('\n')) return undefined;
  const raw = source.split('\n'); const lines: Line[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i]!; let indent = 0; while (text.charCodeAt(indent) === 32) indent++;
    const body = text.slice(indent); if (!body || body.charCodeAt(0) === 35 /* # */ || body.endsWith(' ')) return undefined;
    lines[i] = { indent, text: body };
  }
  const parsed = block(lines, 0, 0);
  if (!parsed || parsed.next !== lines.length || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) return undefined;
  return parsed.value as Record<string, unknown>;
}
