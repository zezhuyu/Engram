/** JSON parser for release evidence: rejects ambiguous keys before constructing objects. */
export function parseStrictJson(text: string, label: string, maxDepth = 256): unknown {
  let i = 0;
  const fail = (): never => { throw new Error(`${label}: invalid strict JSON at offset ${i}`); };
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '\0')) i++; };
  const string = (): string => {
    if (text[i] !== '"') return fail();
    const start = i++;
    while (i < text.length) {
      const c = text[i++]!;
      if (c === '"') { try { return JSON.parse(text.slice(start, i)) as string; } catch { return fail(); } }
      if (c === '\\') { if (i >= text.length) return fail(); i++; }
      else if (c.charCodeAt(0) < 0x20) return fail();
    }
    return fail();
  };
  const value = (depth = 0): unknown => {
    ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      if (depth >= maxDepth) throw new Error(`strict JSON: nesting depth exceeded${label ? ` (${label})` : ''}`);
      i++; ws(); const out: Record<string, unknown> = {}; const keys = new Set<string>();
      if (text[i] === '}') { i++; return out; }
      while (true) {
        ws(); const key = string();
        if (key === '__proto__' || keys.has(key)) throw new Error(`${label}: forbidden or duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key); ws(); if (text[i++] !== ':') return fail(); out[key] = value(depth + 1); ws();
        const sep = text[i++]; if (sep === '}') return out; if (sep !== ',') return fail();
      }
    }
    if (text[i] === '[') {
      if (depth >= maxDepth) throw new Error(`strict JSON: nesting depth exceeded${label ? ` (${label})` : ''}`);
      i++; ws(); const out: unknown[] = []; if (text[i] === ']') { i++; return out; }
      while (true) { out.push(value(depth + 1)); ws(); const sep = text[i++]; if (sep === ']') return out; if (sep !== ',') return fail(); }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) if (text.startsWith(token, i)) { i += token.length; return result; }
    // Anchor at the current cursor. An unanchored exec can find a later digit
    // (for example in `[x,1]`) and advance from the wrong position.
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (number) { i += number[0].length; return Number(number[0]); }
    return fail();
  };
  const parsed = value(); ws(); if (i !== text.length) return fail(); return parsed;
}
