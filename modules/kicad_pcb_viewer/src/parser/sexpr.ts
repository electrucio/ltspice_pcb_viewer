/**
 * Minimal S-expression parser for KiCad files.
 *
 * KiCad files are S-expressions: `(token atom atom (nested ...) ...)`.
 * We parse into a generic tree where every list becomes an `SNode`:
 *   - `name`     the head symbol (e.g. "symbol", "wire", "at")
 *   - `values`   the remaining atoms that are NOT child lists (numbers/strings/bare symbols)
 *   - `children` the nested lists
 *
 * Atoms are kept as `string | number`. Quoted strings are unescaped; bare tokens
 * that look numeric become numbers; everything else stays a string symbol.
 */

export type Atom = string | number;

export interface SNode {
  name: string;
  values: Atom[];
  children: SNode[];
}

const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

export function parseSExpr(input: string): SNode {
  let i = 0;
  const n = input.length;

  function skipWs(): void {
    while (i < n && WHITESPACE.has(input[i]!)) i++;
  }

  function parseString(): string {
    // assumes input[i] === '"'
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = input[i]!;
      if (c === "\\") {
        const next = input[i + 1];
        switch (next) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          default: out += next ?? "";
        }
        i += 2;
        continue;
      }
      if (c === '"') {
        i++; // closing quote
        return out;
      }
      out += c;
      i++;
    }
    throw new Error("Unterminated string in S-expression");
  }

  function parseAtomToken(): Atom {
    let start = i;
    while (i < n) {
      const c = input[i]!;
      if (WHITESPACE.has(c) || c === "(" || c === ")" || c === '"') break;
      i++;
    }
    const tok = input.slice(start, i);
    // Numeric? KiCad uses plain decimals incl. negatives and exponents.
    if (tok.length > 0 && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tok)) {
      return Number(tok);
    }
    return tok;
  }

  function parseList(): SNode {
    // assumes input[i] === '('
    i++; // consume '('
    skipWs();
    // head symbol
    let name = "";
    if (i < n && input[i] === '"') {
      name = parseString();
    } else {
      const a = parseAtomToken();
      name = typeof a === "string" ? a : String(a);
    }
    const node: SNode = { name, values: [], children: [] };
    skipWs();
    while (i < n && input[i] !== ")") {
      const c = input[i]!;
      if (c === "(") {
        node.children.push(parseList());
      } else if (c === '"') {
        node.values.push(parseString());
      } else {
        node.values.push(parseAtomToken());
      }
      skipWs();
    }
    if (input[i] !== ")") throw new Error("Unterminated list in S-expression");
    i++; // consume ')'
    return node;
  }

  skipWs();
  if (input[i] !== "(") throw new Error("Expected '(' at start of S-expression");
  return parseList();
}

// ---- small query helpers -------------------------------------------------

export function child(node: SNode, name: string): SNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function children(node: SNode, name: string): SNode[] {
  return node.children.filter((c) => c.name === name);
}

/** First value of a named child, as a string (e.g. `(lib_id "Device:R")`). */
export function childStr(node: SNode, name: string): string | undefined {
  const c = child(node, name);
  if (!c || c.values.length === 0) return undefined;
  return String(c.values[0]);
}

/** First value of a named child, as a number. */
export function childNum(node: SNode, name: string): number | undefined {
  const c = child(node, name);
  if (!c || c.values.length === 0) return undefined;
  const v = c.values[0];
  return typeof v === "number" ? v : Number(v);
}
