/**
 * Syntax highlighting: source → tokens, as pure data (the viewer turns tokens
 * into spans). A small stateful scanner driven by per-language rule tables —
 * Prism's model, not a parser. State (block comments, multi-line strings) is
 * carried line to line, so a comment spanning many lines highlights on every
 * one of them — the multi-line correctness that per-line highlighters miss.
 *
 * Lossless by construction: for every line, the concatenation of its token
 * texts equals the line. A trailing newline in the source yields a final
 * empty line, matching String.split("\n").
 */

export type TokenClass =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "operator"
  | "punctuation"
  | "constant"
  | "meta"
  | "plain";

export interface Token {
  readonly cls: TokenClass;
  readonly text: string;
}

export type Language =
  | "ts"
  | "python"
  | "go"
  | "rust"
  | "json"
  | "css"
  | "shell"
  | "sql"
  | "yaml"
  | "plain";

interface LangSpec {
  lineComment: string[];
  blockComment?: [string, string];
  /** String delimiters; `multiline` ones (template literals, """ etc.) keep the
   * string open across newlines. */
  strings: {
    open: string;
    close: string;
    escape: boolean;
    multiline: boolean;
  }[];
  keywords: Set<string>;
  types: Set<string>;
  constants: Set<string>;
  /** An identifier followed by "(" is rendered as a function. */
  callAsFunction: boolean;
}

const set = (words: string): Set<string> =>
  new Set(words.split(/\s+/).filter(Boolean));

const dq = { open: '"', close: '"', escape: true, multiline: false };
const sq = { open: "'", close: "'", escape: true, multiline: false };
const backtick = { open: "`", close: "`", escape: true, multiline: true };

const SPECS: Partial<Record<Language, LangSpec>> = {
  ts: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [dq, sq, backtick],
    keywords:
      set(`abstract as async await break case catch class const continue debugger default
      delete do else enum export extends finally for from function get if implements import in
      instanceof interface let new of package private protected public readonly return satisfies set
      static super switch this throw try type typeof var void while with yield keyof infer namespace declare`),
    types:
      set(`string number boolean any unknown never void object bigint symbol undefined null Array
      Promise Record Map Set Partial Readonly Pick Omit Date RegExp Error`),
    constants: set(`true false null undefined NaN Infinity this super`),
    callAsFunction: true,
  },
  python: {
    lineComment: ["#"],
    strings: [
      { open: '"""', close: '"""', escape: true, multiline: true },
      { open: "'''", close: "'''", escape: true, multiline: true },
      dq,
      sq,
    ],
    keywords:
      set(`and as assert async await break class continue def del elif else except finally for
      from global if import in is lambda nonlocal not or pass raise return try while with yield match case`),
    types: set(
      `int float str bytes bool list dict tuple set frozenset object type bytearray complex`,
    ),
    constants: set(`True False None NotImplemented Ellipsis self cls`),
    callAsFunction: true,
  },
  go: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [
      dq,
      { open: "`", close: "`", escape: false, multiline: true },
      sq,
    ],
    keywords:
      set(`break case chan const continue default defer else fallthrough for func go goto if
      import interface map package range return select struct switch type var`),
    types:
      set(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune
      string uint uint8 uint16 uint32 uint64 uintptr any`),
    constants: set(`true false nil iota`),
    callAsFunction: true,
  },
  rust: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [dq, sq],
    keywords:
      set(`as async await break const continue crate dyn else enum extern fn for if impl in let
      loop match mod move mut pub ref return self Self static struct super trait type unsafe use where
      while union`),
    types:
      set(`bool char str String Vec Option Result Box Rc Arc i8 i16 i32 i64 i128 isize u8 u16 u32
      u64 u128 usize f32 f64`),
    constants: set(`true false None Some Ok Err`),
    callAsFunction: true,
  },
  json: {
    lineComment: [],
    strings: [dq],
    keywords: set(``),
    types: set(``),
    constants: set(`true false null`),
    callAsFunction: false,
  },
  css: {
    lineComment: [],
    blockComment: ["/*", "*/"],
    strings: [dq, sq],
    keywords: set(``),
    types: set(``),
    constants: set(``),
    callAsFunction: true,
  },
  shell: {
    lineComment: ["#"],
    strings: [dq, sq],
    keywords:
      set(`if then else elif fi for while do done case esac in function select until return
      break continue export local readonly declare set unset echo cd exit`),
    types: set(``),
    constants: set(`true false`),
    callAsFunction: false,
  },
  sql: {
    lineComment: ["--"],
    blockComment: ["/*", "*/"],
    strings: [sq, dq],
    keywords:
      set(`select from where insert into values update set delete create table alter drop index
      join left right inner outer on group by order having limit offset union all as distinct and or
      not null primary key foreign references default unique check constraint returning with`),
    types:
      set(`int integer text varchar char boolean bool date datetime timestamp real float double
      blob numeric decimal serial uuid json jsonb`),
    constants: set(`true false null current_timestamp`),
    callAsFunction: false,
  },
  yaml: {
    lineComment: ["#"],
    strings: [dq, sq],
    keywords: set(``),
    types: set(``),
    constants: set(`true false null yes no on off`),
    callAsFunction: false,
  },
};

const EXT: Record<string, Language> = {
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  mts: "ts",
  cts: "ts",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
};

export function detectLanguage(path: string): Language {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    // No extension (or a dotfile) — a few well-known filenames.
    if (/^(Dockerfile|Makefile)$/i.test(name)) return "shell";
    return "plain";
  }
  return EXT[name.slice(dot + 1).toLowerCase()] ?? "plain";
}

export interface ScanState {
  block: boolean; // inside a block comment
  str: { close: string; escape: boolean } | null; // inside a multi-line string
}

/** The state a scan of the first line of a file starts from. */
export const INITIAL_SCAN: ScanState = { block: false, str: null };

/**
 * Tokenize **one** line, given the state the previous line ended in.
 *
 * `highlightLines` re-tokenizes a whole file, which is right for a page that
 * renders one. An editor is the other case: a keystroke changes one line, and
 * re-scanning ten thousand of them per character is the difference between an
 * editor that feels instant and one that does not. So the primitive the whole
 * file walk is already built on is offered directly, and a caller that keeps a
 * `ScanState[]` beside its lines can re-scan from the edit downward until the
 * state converges — usually one line, unbounded only inside an unterminated
 * block comment.
 */
export function scanOneLine(
  line: string,
  lang: Language,
  state: ScanState,
): { tokens: Token[]; state: ScanState } {
  const spec = SPECS[lang];
  if (!spec) return { tokens: [{ cls: "plain", text: line }], state };
  return scanLine(line, spec, state);
}

export function highlightLines(code: string, lang: Language): Token[][] {
  const spec = SPECS[lang];
  const lines = code.split("\n");
  if (!spec) return lines.map((line) => [{ cls: "plain", text: line }]);

  const out: Token[][] = [];
  let state: ScanState = { block: false, str: null };
  for (const line of lines) {
    const scanned = scanLine(line, spec, state);
    out.push(scanned.tokens);
    state = scanned.state;
  }
  return out;
}

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";
const isSpace = (c: string) => c === " " || c === "\t" || c === "\r";

function scanLine(
  line: string,
  spec: LangSpec,
  initial: ScanState,
): { tokens: Token[]; state: ScanState } {
  const tokens: Token[] = [];
  let state = initial;
  let i = 0;
  const n = line.length;

  const push = (cls: TokenClass, text: string) => {
    if (text === "") return;
    const last = tokens[tokens.length - 1];
    if (last && last.cls === cls)
      tokens[tokens.length - 1] = { cls, text: last.text + text };
    else tokens.push({ cls, text });
  };

  // Continue an open block comment from a previous line.
  if (state.block && spec.blockComment) {
    const end = line.indexOf(spec.blockComment[1]);
    if (end === -1) {
      push("comment", line);
      return { tokens: emptySafe(tokens), state };
    }
    push("comment", line.slice(0, end + spec.blockComment[1].length));
    i = end + spec.blockComment[1].length;
    state = { ...state, block: false };
  }

  // Continue an open multi-line string.
  if (state.str) {
    const consumed = consumeStringBody(line, 0, state.str);
    push("string", line.slice(0, consumed.end));
    if (!consumed.closed) return { tokens: emptySafe(tokens), state };
    i = consumed.end;
    state = { ...state, str: null };
  }

  while (i < n) {
    const c = line[i]!;

    if (isSpace(c)) {
      let j = i + 1;
      while (j < n && isSpace(line[j]!)) j++;
      push("plain", line.slice(i, j));
      i = j;
      continue;
    }

    // Line comment.
    const lc = spec.lineComment.find((p) => line.startsWith(p, i));
    if (lc) {
      push("comment", line.slice(i));
      i = n;
      continue;
    }

    // Block comment.
    if (spec.blockComment && line.startsWith(spec.blockComment[0], i)) {
      const end = line.indexOf(
        spec.blockComment[1],
        i + spec.blockComment[0].length,
      );
      if (end === -1) {
        push("comment", line.slice(i));
        i = n;
        state = { ...state, block: true };
      } else {
        push("comment", line.slice(i, end + spec.blockComment[1].length));
        i = end + spec.blockComment[1].length;
      }
      continue;
    }

    // String.
    const strSpec = spec.strings.find((s) => line.startsWith(s.open, i));
    if (strSpec) {
      const bodyStart = i + strSpec.open.length;
      const consumed = consumeStringBody(line, bodyStart, {
        close: strSpec.close,
        escape: strSpec.escape,
      });
      if (consumed.closed) {
        push("string", line.slice(i, consumed.end));
        i = consumed.end;
      } else if (strSpec.multiline) {
        push("string", line.slice(i));
        i = n;
        state = {
          ...state,
          str: { close: strSpec.close, escape: strSpec.escape },
        };
      } else {
        // Unterminated single-line string: take the rest of the line.
        push("string", line.slice(i));
        i = n;
      }
      continue;
    }

    // Number.
    if (isDigit(c) || (c === "." && i + 1 < n && isDigit(line[i + 1]!))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(line[j]!)) j++;
      push("number", line.slice(i, j));
      i = j;
      continue;
    }

    // Identifier / keyword / type / constant / function.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(line[j]!)) j++;
      const word = line.slice(i, j);
      let cls: TokenClass = "plain";
      if (spec.keywords.has(word)) cls = "keyword";
      else if (spec.constants.has(word)) cls = "constant";
      else if (spec.types.has(word)) cls = "type";
      else if (spec.callAsFunction && line[j] === "(") cls = "function";
      else if (/^[A-Z]/.test(word)) cls = "type"; // Capitalized ⇒ type, heuristically
      push(cls, word);
      i = j;
      continue;
    }

    // Operators and punctuation.
    if (/[{}()[\];,.]/.test(c)) push("punctuation", c);
    else push("operator", c);
    i++;
  }

  return { tokens: emptySafe(tokens), state };
}

/** A blank line still needs one (empty) token so line counts stay aligned. */
function emptySafe(tokens: Token[]): Token[] {
  return tokens.length > 0 ? tokens : [{ cls: "plain", text: "" }];
}

/** Consume a string body from `start`, honoring escapes. Returns where it ends
 * (past the closing delimiter) and whether it closed on this line. */
function consumeStringBody(
  line: string,
  start: number,
  spec: { close: string; escape: boolean },
): { end: number; closed: boolean } {
  let i = start;
  const n = line.length;
  while (i < n) {
    if (spec.escape && line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line.startsWith(spec.close, i)) {
      return { end: i + spec.close.length, closed: true };
    }
    i++;
  }
  return { end: n, closed: false };
}
