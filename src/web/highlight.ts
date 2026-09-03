/**
 * Syntax highlighting: source → tokens, as pure data (the viewer turns tokens
 * into spans). A small stateful scanner driven by per-language rule tables —
 * Prism's model, not a parser. State (block comments, multi-line strings,
 * heredocs, fenced blocks) is carried line to line, so a construct spanning
 * many lines highlights on every one of them — the multi-line correctness that
 * per-line highlighters miss.
 *
 * Two properties this file must never lose, both proven in `highlight.test.ts`:
 *
 *   **Lossless.** For every line, the concatenation of its token texts equals
 *   the line. A trailing newline yields a final empty line, matching
 *   `String.split("\n")`. Every scanner advances at least one character per
 *   step, so no input can wedge it.
 *
 *   **Linear.** No backtracking regex ever touches a whole line; the hot loops
 *   compare character codes. A 10,000-character line scans in under a
 *   millisecond, which is what makes the editor's per-keystroke re-scan free.
 *
 * ## Two levels of token
 *
 * `cls` is the *colour every consumer knows* — eleven classes, the vocabulary
 * the terminal's theme table is built on. `kind` is a finer distinction the
 * web paints on top (a regex is a string; a tag is a keyword; a property is a
 * keyword). A consumer that knows only `cls` still renders correctly, which is
 * why the richer web palette costs the terminal nothing.
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

/**
 * A refinement of `cls`. Optional by design: dropping it must never make a
 * line wrong, only less specific.
 */
export type TokenKind =
  | "property"
  | "tag"
  | "attribute"
  | "regex"
  | "variable"
  | "decorator"
  | "heading"
  | "emphasis"
  | "link"
  | "inserted"
  | "deleted";

export interface Token {
  readonly cls: TokenClass;
  readonly text: string;
  readonly kind?: TokenKind;
}

export type Language =
  | "ts"
  | "python"
  | "go"
  | "rust"
  | "c"
  | "java"
  | "kotlin"
  | "swift"
  | "ruby"
  | "php"
  | "lua"
  | "zig"
  | "elixir"
  | "nix"
  | "json"
  | "yaml"
  | "toml"
  | "ini"
  | "markdown"
  | "css"
  | "html"
  | "shell"
  | "sql"
  | "dockerfile"
  | "makefile"
  | "diff"
  | "plain";

// ---- tokens ----

function tok(cls: TokenClass, text: string, kind?: TokenKind): Token {
  return kind === undefined ? { cls, text } : { cls, text, kind };
}

/** A blank line still needs one (empty) token so line counts stay aligned. */
function emptySafe(tokens: Token[]): Token[] {
  return tokens.length > 0 ? tokens : [tok("plain", "")];
}

/**
 * The sink every scanner writes through. It merges runs of the same
 * (class, kind) so a line of punctuation is one token, not forty.
 */
class Out {
  readonly tokens: Token[] = [];
  push(cls: TokenClass, text: string, kind?: TokenKind): void {
    if (text === "") return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.cls === cls && last.kind === kind) {
      this.tokens[this.tokens.length - 1] = tok(cls, last.text + text, kind);
      return;
    }
    this.tokens.push(tok(cls, text, kind));
  }
  /** Append another scanner's output (an embedded language's line). */
  take(tokens: readonly Token[]): void {
    for (const t of tokens) this.push(t.cls, t.text, t.kind);
  }
  done(): Token[] {
    return emptySafe(this.tokens);
  }
}

// ---- character classes (charCode, not regex: these run per character) ----

const SPACE = 32,
  TAB = 9,
  CR = 13;
const isSpaceCh = (c: number): boolean => c === SPACE || c === TAB || c === CR;
const isDigitCh = (c: number): boolean => c >= 48 && c <= 57;
const isUpperCh = (c: number): boolean => c >= 65 && c <= 90;
const isAlphaCh = (c: number): boolean =>
  isUpperCh(c) || (c >= 97 && c <= 122) || c > 127;
const isIdentCh = (c: number): boolean =>
  isAlphaCh(c) || isDigitCh(c) || c === 95;

const set = (words: string): Set<string> =>
  new Set(words.split(/\s+/).filter(Boolean));

// ---- state carried across lines ----

interface StrState {
  /** The delimiter that closes it. */
  close: string;
  escape: boolean;
  /** `${…}` (or `#{…}`) inside is code, not string. */
  interpolate?: boolean;
  interpolateAs?: "code" | "variable";
}

interface Heredoc {
  tag: string;
  /** `<<~` / `<<-`: the terminator may be indented. */
  indent: boolean;
}

interface Embed {
  lang: Language;
  /** The fence or closing tag that ends it, matched per language. */
  end: string;
  inner: ScanState;
}

export interface ScanState {
  /** Inside a block comment. */
  readonly block: boolean;
  /** Inside a multi-line string. */
  readonly str: StrState | null;
  /** Waiting for a heredoc terminator. */
  readonly heredoc: Heredoc | null;
  /** A fenced code block, or an HTML `<script>`/`<style>` body. */
  readonly embed: Embed | null;
  /** YAML block scalar: lines indented past this column are string. */
  readonly scalar: number | null;
  /** HTML: inside a tag's attribute list. */
  readonly tag: boolean;
  /** CSS: brace depth, which decides selector context from declaration. */
  readonly depth: number;
}

/** The state a scan of the first line of a file starts from. */
export const INITIAL_SCAN: ScanState = {
  block: false,
  str: null,
  heredoc: null,
  embed: null,
  scalar: null,
  tag: false,
  depth: 0,
};

interface Scanned {
  tokens: Token[];
  state: ScanState;
}

// ---- language specs ----

interface StrSpec {
  open: string;
  close: string;
  escape: boolean;
  /** Stays open across newlines (template literals, `"""`, backticks). */
  multiline: boolean;
  /** `${…}`/`#{…}` inside is code. */
  interpolate?: boolean;
  /** Shell-ish strings paint `$x` as a variable; template literals as code. */
  interpolateAs?: "code" | "variable";
  /** Only opens where a value is expected (regex literals). */
  valueOnly?: boolean;
  /** What to paint it as; strings by default. */
  cls?: TokenClass;
  kind?: TokenKind;
}

interface LangSpec {
  lineComment: string[];
  blockComment?: [string, string];
  strings: StrSpec[];
  keywords: Set<string>;
  types: Set<string>;
  constants: Set<string>;
  /** An identifier followed by "(" is rendered as a function. */
  callAsFunction: boolean;
  /** Capitalized identifiers read as types. False for shells and SQL. */
  capitalIsType?: boolean;
  /** Keywords match regardless of case (SQL). */
  ignoreCase?: boolean;
  /** `/…/` is a regex where a value is expected. */
  regex?: boolean;
  /** `<div …>` is markup where a value is expected (JSX). */
  jsx?: boolean;
  /** Characters that begin a variable: `$`, `@`, `%`. */
  sigils?: string;
  /** `@name` is a decorator/annotation. */
  atDecorator?: boolean;
  /** `#[…]` is an attribute (Rust), `#!…` too. */
  hashAttr?: boolean;
  /** `foo.bar` paints `bar` as a property. */
  dotProperty?: boolean;
  /** `#include`, `#define`: a C preprocessor line. */
  preproc?: boolean;
  /** `'a` is a lifetime, not a character literal (Rust). */
  lifetimes?: boolean;
  /** `name!`/`name?` end an identifier (Ruby, Elixir, Rust macros). */
  identTail?: string;
  /** Extra characters allowed inside an identifier (`-` in CSS-ish langs). */
  identInner?: string;
  /** `:atom` / `:symbol` is a constant. */
  atoms?: boolean;
  /** `<<EOF` opens a heredoc. */
  heredoc?: boolean;
  /** The first word of a command reads as the thing being run. */
  commandPosition?: boolean;
  /** `-v` / `--long` read as flags. */
  flags?: boolean;
  /** The word after these is a definition name. */
  defineAfter?: Set<string>;
  /** The word after these is a type name. */
  typeAfter?: Set<string>;
  /** A word in this set followed by `!` is a macro. */
  macroBang?: boolean;
}

const dq: StrSpec = { open: '"', close: '"', escape: true, multiline: false };
const sq: StrSpec = { open: "'", close: "'", escape: true, multiline: false };
const tick: StrSpec = {
  open: "`",
  close: "`",
  escape: true,
  multiline: true,
  interpolate: true,
};
const tripleD: StrSpec = {
  open: '"""',
  close: '"""',
  escape: true,
  multiline: true,
};
const tripleS: StrSpec = {
  open: "'''",
  close: "'''",
  escape: true,
  multiline: true,
};
const regexLit: StrSpec = {
  open: "/",
  close: "/",
  escape: true,
  multiline: false,
  valueOnly: true,
  cls: "string",
  kind: "regex",
};

const TS_KEYWORDS = `abstract accessor as asserts async await break case catch class const continue
  debugger declare default delete do else enum export extends finally for from function get if
  implements import in infer instanceof interface is keyof let module namespace new of out override
  package private protected public readonly return satisfies set static super switch this throw try
  type typeof unique var void while with yield`;

const TS_TYPES = `string number boolean any unknown never void object bigint symbol undefined null
  Array Promise Record Map Set WeakMap WeakSet Partial Required Readonly Pick Omit Exclude Extract
  Awaited ReturnType Parameters Date RegExp Error Iterable AsyncIterable Uint8Array ArrayBuffer
  Function Symbol BigInt`;

const SPECS: Partial<Record<Language, LangSpec>> = {
  ts: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [dq, sq, tick, regexLit],
    keywords: set(TS_KEYWORDS),
    types: set(TS_TYPES),
    constants: set(
      `true false null undefined NaN Infinity this super arguments`,
    ),
    callAsFunction: true,
    capitalIsType: true,
    regex: true,
    jsx: true,
    atDecorator: true,
    dotProperty: true,
    sigils: "#",
    defineAfter: set(`function class interface type enum namespace`),
    typeAfter: set(`class interface type enum namespace`),
  },
  python: {
    lineComment: ["#"],
    strings: [tripleD, tripleS, dq, sq],
    keywords:
      set(`and as assert async await break case class continue def del elif else except finally for
      from global if import in is lambda match nonlocal not or pass raise return try while with yield`),
    types: set(
      `int float str bytes bool list dict tuple set frozenset object type bytearray complex range
       Any Optional Union Callable Iterable Sequence Mapping`,
    ),
    constants: set(
      `True False None NotImplemented Ellipsis self cls __name__ __main__`,
    ),
    callAsFunction: true,
    capitalIsType: true,
    atDecorator: true,
    dotProperty: true,
    defineAfter: set(`def class`),
    typeAfter: set(`class`),
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
      string uint uint8 uint16 uint32 uint64 uintptr any comparable`),
    constants: set(`true false nil iota`),
    callAsFunction: true,
    capitalIsType: true,
    dotProperty: true,
    defineAfter: set(`func`),
    typeAfter: set(`type struct interface`),
  },
  rust: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [dq, sq],
    keywords:
      set(`as async await break const continue crate dyn else enum extern fn for if impl in let
      loop match mod move mut pub ref return self Self static struct super trait type unsafe use
      where while union yield`),
    types:
      set(`bool char str String Vec Option Result Box Rc Arc RefCell Cell HashMap HashSet BTreeMap
      i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64`),
    constants: set(`true false None Some Ok Err`),
    callAsFunction: true,
    capitalIsType: true,
    lifetimes: true,
    hashAttr: true,
    macroBang: true,
    dotProperty: true,
    defineAfter: set(`fn`),
    typeAfter: set(`struct enum trait type impl union`),
  },
  c: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [dq, sq],
    keywords:
      set(`alignas alignof asm auto bool break case catch char class co_await co_return co_yield
      concept const consteval constexpr continue decltype default delete do double dynamic_cast
      else enum explicit export extern false final float for friend goto if inline int long mutable
      namespace new noexcept nullptr operator override private protected public register
      reinterpret_cast requires restrict return short signed sizeof static static_assert
      static_cast struct switch template this thread_local throw true try typedef typeid typename
      union unsigned using virtual void volatile wchar_t while
      id instancetype nonatomic atomic strong weak copy assign retain nullable nonnull`),
    types:
      set(`int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t ssize_t ptrdiff_t
      FILE va_list std string vector map unordered_map shared_ptr unique_ptr NSString NSArray
      NSDictionary NSInteger NSUInteger BOOL CGFloat`),
    constants: set(`true false NULL nullptr nil YES NO self super __func__`),
    callAsFunction: true,
    capitalIsType: true,
    preproc: true,
    atDecorator: true,
    dotProperty: true,
  },
  java: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [tripleD, dq, sq],
    keywords:
      set(`abstract assert break case catch class const continue default do else enum extends final
      finally for goto if implements import instanceof interface native new package permits private
      protected public record return sealed static strictfp super switch synchronized this throw
      throws transient try var void volatile while yield`),
    types:
      set(`boolean byte char double float int long short String Object Integer Long Double Boolean
      List Map Set Optional Stream`),
    constants: set(`true false null this super`),
    callAsFunction: true,
    capitalIsType: true,
    atDecorator: true,
    dotProperty: true,
    defineAfter: set(`class interface enum record`),
    typeAfter: set(`class interface enum record`),
  },
  kotlin: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [tripleD, dq, sq],
    keywords:
      set(`abstract actual annotation as break by catch class companion const constructor continue
      crossinline data delegate do dynamic else enum expect external final finally for fun get if
      import in infix init inline inner interface internal is lateinit noinline object open operator
      out override package private protected public reified return sealed set super suspend tailrec
      this throw try typealias val var vararg when where while`),
    types:
      set(`Any Boolean Byte Char Double Float Int Long Nothing Number Short String Unit List Map Set
      MutableList MutableMap Array Sequence`),
    constants: set(`true false null this super it`),
    callAsFunction: true,
    capitalIsType: true,
    atDecorator: true,
    dotProperty: true,
    sigils: "$",
    defineAfter: set(`fun class interface object`),
    typeAfter: set(`class interface object`),
  },
  swift: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [tripleD, dq],
    keywords:
      set(`actor as associatedtype async await break case catch class continue convenience default
      defer deinit didSet do else enum extension fallthrough fileprivate final for func get guard if
      import in indirect init inout internal is lazy let mutating nonisolated open operator override
      private protocol public repeat required rethrows return self set some static struct subscript
      super switch throw throws try typealias var weak where while willSet unowned`),
    types:
      set(`Any AnyObject Array Bool Character Dictionary Double Float Int Int8 Int16 Int32 Int64
      Optional Set String UInt UInt8 UInt32 UInt64 Void Result Data URL`),
    constants: set(`true false nil self Self super`),
    callAsFunction: true,
    capitalIsType: true,
    atDecorator: true,
    dotProperty: true,
    defineAfter: set(`func class struct enum protocol extension actor`),
    typeAfter: set(`class struct enum protocol extension actor`),
  },
  ruby: {
    lineComment: ["#"],
    strings: [
      dq,
      sq,
      { open: "%w[", close: "]", escape: false, multiline: false },
    ],
    keywords:
      set(`alias and begin break case class def defined? do else elsif end ensure for if in module
      next nil not or redo rescue retry return self super then undef unless until when while yield
      lambda proc require require_relative include extend attr_accessor attr_reader attr_writer
      private protected public raise puts new`),
    types: set(
      `String Symbol Integer Float Array Hash Struct Class Module Proc Range Time`,
    ),
    constants: set(`true false nil self __FILE__ __dir__`),
    callAsFunction: true,
    capitalIsType: true,
    sigils: "@$",
    atoms: true,
    heredoc: true,
    regex: true,
    identTail: "?!",
    dotProperty: true,
    defineAfter: set(`def`),
    typeAfter: set(`class module`),
  },
  php: {
    lineComment: ["//", "#"],
    blockComment: ["/*", "*/"],
    strings: [dq, sq],
    keywords:
      set(`abstract and array as break callable case catch class clone const continue declare
      default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum
      extends final finally fn for foreach function global goto if implements include include_once
      instanceof insteadof interface isset list match namespace new or print private protected
      public readonly require require_once return static switch throw trait try unset use var while
      xor yield`),
    types: set(
      `int float string bool array object callable iterable void mixed never self static`,
    ),
    constants: set(`true false null TRUE FALSE NULL $this`),
    callAsFunction: true,
    capitalIsType: true,
    sigils: "$",
    atDecorator: true,
    dotProperty: true,
    defineAfter: set(`function class interface trait enum`),
    typeAfter: set(`class interface trait enum`),
  },
  lua: {
    lineComment: ["--"],
    blockComment: ["--[[", "]]"],
    strings: [
      dq,
      sq,
      { open: "[[", close: "]]", escape: false, multiline: true },
    ],
    keywords:
      set(`and break do else elseif end false for function goto if in local nil not or repeat
      return then true until while`),
    types: set(`string table math io os coroutine debug utf8`),
    constants: set(`true false nil self _G _ENV`),
    callAsFunction: true,
    capitalIsType: false,
    dotProperty: true,
    defineAfter: set(`function`),
  },
  zig: {
    lineComment: ["//"],
    strings: [dq, sq],
    keywords:
      set(`align allowzero and anyframe anytype asm async await break callconv catch comptime const
      continue defer else enum errdefer error export extern fn for if inline noalias nosuspend
      opaque or orelse packed pub resume return linksection struct suspend switch test threadlocal
      try union unreachable usingnamespace var volatile while`),
    types:
      set(`bool void noreturn type anyerror comptime_int comptime_float u8 u16 u32 u64 u128 usize
      i8 i16 i32 i64 i128 isize f16 f32 f64 f128 c_int c_uint`),
    constants: set(`true false null undefined`),
    callAsFunction: true,
    capitalIsType: true,
    atDecorator: true,
    dotProperty: true,
    defineAfter: set(`fn`),
  },
  elixir: {
    lineComment: ["#"],
    strings: [tripleD, dq, sq],
    keywords:
      set(`after alias and case catch cond def defdelegate defexception defguard defimpl defmacro
      defmodule defp defprotocol defstruct do else end fn for if import in not or quote raise
      receive require rescue try unless unquote use when with`),
    types: set(
      `Enum Map List String Atom Integer Float Process Task Agent GenServer Supervisor`,
    ),
    constants: set(`true false nil __MODULE__ __ENV__`),
    callAsFunction: true,
    capitalIsType: true,
    sigils: "@",
    atoms: true,
    identTail: "?!",
    dotProperty: true,
    defineAfter: set(`def defp defmacro defmodule defstruct defguard`),
    typeAfter: set(`defmodule defprotocol defimpl`),
  },
  nix: {
    lineComment: ["#"],
    blockComment: ["/*", "*/"],
    strings: [
      {
        open: "''",
        close: "''",
        escape: false,
        multiline: true,
        interpolate: true,
      },
      {
        open: '"',
        close: '"',
        escape: true,
        multiline: false,
        interpolate: true,
      },
    ],
    keywords: set(`assert else if in inherit let or rec then with import`),
    types: set(`builtins pkgs lib stdenv fetchurl mkDerivation`),
    constants: set(`true false null`),
    callAsFunction: false,
    capitalIsType: false,
    identInner: "-",
    dotProperty: true,
  },
  json: {
    // JSON proper has no comments; JSONC does, and a `//` outside a string is
    // never valid JSON anyway, so accepting one costs nothing and helps.
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: [dq],
    keywords: set(``),
    types: set(``),
    constants: set(`true false null`),
    callAsFunction: false,
    capitalIsType: false,
  },
  sql: {
    lineComment: ["--", "#"],
    blockComment: ["/*", "*/"],
    strings: [
      sq,
      { open: "`", close: "`", escape: false, multiline: false },
      dq,
    ],
    keywords:
      set(`select from where insert into values update set delete create table alter drop index
      view trigger procedure function returns begin end join left right full inner outer cross on
      using group by order having limit offset union all as distinct and or not null is primary key
      foreign references default unique check constraint cascade returning with recursive case when
      then else exists in between like ilike asc desc count sum avg min max coalesce cast if temp
      temporary replace grant revoke commit rollback transaction`),
    types:
      set(`int integer bigint smallint text varchar char boolean bool date datetime timestamp time
      real float double blob numeric decimal serial uuid json jsonb bytea interval`),
    constants: set(
      `true false null current_timestamp current_date current_user`,
    ),
    callAsFunction: true,
    capitalIsType: false,
    ignoreCase: true,
  },
  shell: {
    lineComment: ["#"],
    strings: [
      {
        open: '"',
        close: '"',
        escape: true,
        multiline: false,
        interpolate: true,
        interpolateAs: "variable",
      },
      { open: "'", close: "'", escape: false, multiline: false },
    ],
    keywords:
      set(`if then else elif fi for while do done case esac in function select until return break
      continue export local readonly declare typeset set unset shift source alias eval exec trap
      exit time coproc`),
    types: set(``),
    constants: set(`true false`),
    callAsFunction: false,
    capitalIsType: false,
    sigils: "$",
    heredoc: true,
    identInner: "-.",
    commandPosition: true,
    flags: true,
  },
  dockerfile: {
    lineComment: ["#"],
    strings: [dq, sq],
    keywords: set(`as`),
    types: set(``),
    constants: set(``),
    callAsFunction: false,
    capitalIsType: false,
    sigils: "$",
    ignoreCase: true,
    flags: true,
  },
};

/** Shell words after which the next word is a command again. */
const COMMAND_OPENERS = set(
  `then else elif do done fi in time exec sudo command xargs nohup env watch`,
);

/** Dockerfile instructions, which are only keywords at the start of a line. */
const DOCKER_INSTRUCTIONS = set(
  `FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD
   STOPSIGNAL HEALTHCHECK SHELL`,
);

// ---- language detection ----

const EXT: Record<string, Language> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "python",
  pyi: "python",
  pyw: "python",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  hxx: "c",
  m: "c",
  mm: "c",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  lua: "lua",
  zig: "zig",
  ex: "elixir",
  exs: "elixir",
  nix: "nix",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  editorconfig: "ini",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "html",
  svelte: "html",
  xml: "html",
  svg: "html",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  env: "shell",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  mk: "makefile",
  make: "makefile",
};

const FILENAMES: Record<string, Language> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  justfile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  ".gitignore": "shell",
  ".dockerignore": "shell",
  ".gitattributes": "shell",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".env": "shell",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".zprofile": "shell",
  "cargo.lock": "toml",
  "go.mod": "go",
  "go.sum": "plain",
  "cmakelists.txt": "makefile",
};

const SHEBANG: [RegExp, Language][] = [
  [/\b(?:python|python3|python2|uv run)\b/, "python"],
  [/\b(?:node|bun|deno|ts-node)\b/, "ts"],
  [/\bruby\b/, "ruby"],
  [/\b(?:bash|zsh|sh|dash|ksh|fish)\b/, "shell"],
  [/\bphp\b/, "php"],
  [/\blua\b/, "lua"],
  [/\belixir\b/, "elixir"],
  [/\bmake\b/, "makefile"],
];

const MODELINE_ALIASES: Record<string, Language> = {
  javascript: "ts",
  typescript: "ts",
  js: "ts",
  ts: "ts",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  "shell-script": "shell",
  conf: "ini",
  make: "makefile",
  yml: "yaml",
  "c++": "c",
  cpp: "c",
  objc: "c",
  rb: "ruby",
  py: "python",
};

/** Every language this file can highlight — the fence-info vocabulary too. */
export const LANGUAGES: readonly Language[] = [
  "ts",
  "python",
  "go",
  "rust",
  "c",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "php",
  "lua",
  "zig",
  "elixir",
  "nix",
  "json",
  "yaml",
  "toml",
  "ini",
  "markdown",
  "css",
  "html",
  "shell",
  "sql",
  "dockerfile",
  "makefile",
  "diff",
  "plain",
];

/** A language name as a fence info string or a modeline writes it. */
export function languageFromName(name: string): Language {
  const word =
    name
      .trim()
      .toLowerCase()
      .split(/[\s,;:]/)[0] ?? "";
  if (word === "") return "plain";
  const alias = MODELINE_ALIASES[word];
  if (alias) return alias;
  if (Object.hasOwn(EXT, word)) return EXT[word]!;
  if (Object.hasOwn(FILENAMES, word)) return FILENAMES[word]!;
  return LANGUAGES.includes(word as Language) ? (word as Language) : "plain";
}


/**
 * The language of a file. The extension decides where it can; otherwise the
 * bare filename (`Dockerfile`, `Makefile`, `.zshrc`), and only then the first
 * line — a shebang or an editor modeline — which is the one thing a file with
 * no extension can say about itself.
 */
export function detectLanguage(path: string, firstLine?: string): Language {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  const byName = FILENAMES[lower];
  if (byName) return byName;
  // `Dockerfile.dev`, `Makefile.local`: the stem still names the language.
  const stem = lower.split(".")[0] ?? "";
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const byExt = EXT[lower.slice(dot + 1)];
    if (byExt) return byExt;
  }
  if (dot > 0 && FILENAMES[stem] && stem !== "") {
    const byStem = FILENAMES[stem];
    if (byStem === "dockerfile" || byStem === "makefile") return byStem;
  }
  if (firstLine !== undefined) {
    const fromLine = languageFromFirstLine(firstLine);
    if (fromLine !== "plain") return fromLine;
  }
  return "plain";
}

/** A shebang (`#!/usr/bin/env python3`) or a modeline (`vim: ft=ruby`). */
export function languageFromFirstLine(line: string): Language {
  const head = line.slice(0, 200);
  if (head.startsWith("#!")) {
    for (const [pattern, lang] of SHEBANG) if (pattern.test(head)) return lang;
  }
  const vim = /(?:ft|filetype|syntax)=([A-Za-z0-9_+-]+)/.exec(head);
  if (vim) return languageFromName(vim[1]!);
  const emacs = /-\*-\s*(?:mode:\s*)?([A-Za-z0-9_+-]+)/.exec(head);
  if (emacs) return languageFromName(emacs[1]!);
  if (/^<\?xml|^<!doctype html/i.test(head.trim())) return "html";
  return "plain";
}

// ---- the entry points ----

type Scanner = (line: string, state: ScanState) => Scanned;

function scannerFor(lang: Language): Scanner | null {
  switch (lang) {
    case "markdown":
      return scanMarkdown;
    case "yaml":
      return scanYaml;
    case "toml":
      return (line, state) => scanToml(line, state, true);
    case "ini":
      return (line, state) => scanToml(line, state, false);
    case "html":
      return scanHtml;
    case "css":
      return scanCss;
    case "diff":
      return scanDiff;
    case "makefile":
      return scanMakefile;
    case "dockerfile":
      return scanDockerfile;
    default: {
      const spec = SPECS[lang];
      return spec ? (line, state) => scanGeneric(line, spec, state) : null;
    }
  }
}

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
): Scanned {
  const scan = scannerFor(lang);
  if (!scan) return { tokens: [tok("plain", line)], state };
  return scan(line, state);
}

export function highlightLines(code: string, lang: Language): Token[][] {
  const lines = code.split("\n");
  const scan = scannerFor(lang);
  if (!scan) return lines.map((line) => [tok("plain", line)]);

  const out: Token[][] = [];
  let state: ScanState = INITIAL_SCAN;
  for (const line of lines) {
    const scanned = scan(line, state);
    out.push(scanned.tokens);
    state = scanned.state;
  }
  return out;
}

// ---- shared scanning helpers ----

/** Consume a string body from `start`, honouring escapes. */
function consumeStringBody(
  line: string,
  start: number,
  spec: { close: string; escape: boolean },
): { end: number; closed: boolean } {
  let i = start;
  const n = line.length;
  while (i < n) {
    if (spec.escape && line.charCodeAt(i) === 92) {
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

/**
 * Emit a string body, breaking out `${…}`/`#{…}` interpolations so the code
 * inside a template literal is not painted as prose.
 */
function pushString(
  out: Out,
  text: string,
  interpolate: boolean,
  cls: TokenClass = "string",
  kind?: TokenKind,
  as: "code" | "variable" = "code",
): void {
  if (!interpolate || text.length < 2) {
    out.push(cls, text, kind);
    return;
  }
  let i = 0;
  let run = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    const braced =
      (c === 36 || c === 35) && text.charCodeAt(i + 1) === 123; /* { */
    const bare =
      as === "variable" &&
      c === 36 &&
      (isAlphaCh(text.charCodeAt(i + 1)) || text.charCodeAt(i + 1) === 95);
    if (!braced && !bare) {
      i++;
      continue;
    }
    out.push(cls, text.slice(run, i), kind);
    if (bare) {
      const end = readVariable(text, i);
      out.push("meta", text.slice(i, end), "variable");
      i = end;
      run = end;
      continue;
    }
    let depth = 1;
    let j = i + 2;
    while (j < text.length && depth > 0) {
      const d = text.charCodeAt(j);
      if (d === 123) depth++;
      else if (d === 125) depth--;
      j++;
    }
    if (as === "variable") {
      out.push("meta", text.slice(i, j), "variable");
    } else {
      out.push("punctuation", text.slice(i, i + 2));
      out.push("plain", text.slice(i + 2, depth === 0 ? j - 1 : j));
      if (depth === 0) out.push("punctuation", "}");
    }
    i = j;
    run = j;
  }
  out.push(cls, text.slice(run), kind);
}

/** A number literal: hex/binary/octal, separators, exponents, suffixes. */
function scanNumber(line: string, start: number): number {
  const n = line.length;
  let i = start;
  if (
    line.charCodeAt(i) === 48 /* 0 */ &&
    i + 1 < n &&
    /[xXbBoO]/.test(line[i + 1]!)
  ) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(line[i]!)) i++;
  } else {
    while (
      i < n &&
      (isDigitCh(line.charCodeAt(i)) || line.charCodeAt(i) === 95)
    )
      i++;
    if (
      i < n &&
      line.charCodeAt(i) === 46 &&
      isDigitCh(line.charCodeAt(i + 1))
    ) {
      i++;
      while (
        i < n &&
        (isDigitCh(line.charCodeAt(i)) || line.charCodeAt(i) === 95)
      )
        i++;
    }
    if (i < n && (line[i] === "e" || line[i] === "E")) {
      let j = i + 1;
      if (j < n && (line[j] === "+" || line[j] === "-")) j++;
      if (j < n && isDigitCh(line.charCodeAt(j))) {
        i = j;
        while (i < n && isDigitCh(line.charCodeAt(i))) i++;
      }
    }
  }
  // Suffixes: 10n, 1.0f32, 3u8, 100L, 5px is CSS's business, not ours here.
  while (
    i < n &&
    (isAlphaCh(line.charCodeAt(i)) || isDigitCh(line.charCodeAt(i)))
  ) {
    const rest = line.slice(i);
    if (!/^(n|[uif](8|16|32|64|128|size)?|[lLfFdDuU]+)/.test(rest)) break;
    i += /^(n|[uif](8|16|32|64|128|size)?|[lLfFdDuU]+)/.exec(rest)![0].length;
    break;
  }
  return i;
}

/** Where the run of spaces starting at `i` ends. */
function spaceRun(line: string, i: number): number {
  let j = i;
  while (j < line.length && isSpaceCh(line.charCodeAt(j))) j++;
  return j;
}

/** The column of the first non-space character, or -1 for a blank line. */
function indentOf(line: string): number {
  const at = spaceRun(line, 0);
  return at === line.length ? -1 : at;
}

// ---- the generic scanner ----

/**
 * The scanner most languages use: comments, strings, numbers, identifiers
 * classified against the spec's word sets, and everything else as operator or
 * punctuation. `expectValue` tracks whether the next `/` is a regex or a
 * division, and whether a `<` opens JSX — the one piece of grammar a
 * table-driven scanner cannot do without.
 */
function scanGeneric(
  line: string,
  spec: LangSpec,
  initial: ScanState,
): Scanned {
  const out = new Out();
  let state = initial;
  let i = 0;
  const n = line.length;
  let expectValue = true;
  let pendingHeredoc: Heredoc | null = null;
  let lastWord = "";
  // Shell only: the first word of a command is the thing being run.
  let atCommand = true;

  // A heredoc body swallows whole lines until its terminator.
  if (state.heredoc) {
    const hd = state.heredoc;
    const body = hd.indent ? line.trimStart() : line;
    if (body.trimEnd() === hd.tag) {
      out.push("meta", line);
      return { tokens: out.done(), state: { ...state, heredoc: null } };
    }
    pushString(out, line, true, "string", undefined, "variable");
    return { tokens: out.done(), state };
  }

  // Continue an open block comment.
  if (state.block && spec.blockComment) {
    const end = line.indexOf(spec.blockComment[1]);
    if (end === -1) {
      out.push("comment", line);
      return { tokens: out.done(), state };
    }
    out.push("comment", line.slice(0, end + spec.blockComment[1].length));
    i = end + spec.blockComment[1].length;
    state = { ...state, block: false };
  }

  // Continue an open multi-line string.
  if (state.str) {
    const open = state.str;
    const consumed = consumeStringBody(line, 0, open);
    pushString(
      out,
      line.slice(0, consumed.end),
      open.interpolate === true,
      "string",
      undefined,
      open.interpolateAs ?? "code",
    );
    if (!consumed.closed) return { tokens: out.done(), state };
    i = consumed.end;
    state = { ...state, str: null };
  }

  while (i < n) {
    const c = line.charCodeAt(i);

    if (isSpaceCh(c)) {
      const j = spaceRun(line, i);
      out.push("plain", line.slice(i, j));
      i = j;
      continue;
    }

    // A C preprocessor line: `#include <stdio.h>`, `#define X 1`.
    if (
      spec.preproc &&
      c === 35 &&
      out.tokens.every((t) => t.cls === "plain")
    ) {
      const directive = /^#\s*[a-z_]+/.exec(line.slice(i));
      if (directive) {
        out.push("meta", directive[0]);
        i += directive[0].length;
        const angle = /^\s*<[^>\s]*>/.exec(line.slice(i));
        if (angle) {
          out.push("plain", angle[0].slice(0, angle[0].indexOf("<")));
          out.push("string", angle[0].slice(angle[0].indexOf("<")));
          i += angle[0].length;
        }
        continue;
      }
    }

    // Line comment. In shells a `#` only starts one at a word boundary, so
    // `curl http://x#y` and `${x#y}` survive.
    const lc = spec.lineComment.find((p) => line.startsWith(p, i));
    if (
      lc !== undefined &&
      (lc !== "#" || i === 0 || isSpaceCh(line.charCodeAt(i - 1)))
    ) {
      out.push("comment", line.slice(i));
      i = n;
      continue;
    }

    // Block comment.
    if (spec.blockComment && line.startsWith(spec.blockComment[0], i)) {
      const close = spec.blockComment[1];
      const end = line.indexOf(close, i + spec.blockComment[0].length);
      if (end === -1) {
        out.push("comment", line.slice(i));
        i = n;
        state = { ...state, block: true };
      } else {
        out.push("comment", line.slice(i, end + close.length));
        i = end + close.length;
      }
      continue;
    }

    // Rust `#[derive(Debug)]`, and `#![no_std]`.
    if (spec.hashAttr && c === 35 && /^#!?\[/.test(line.slice(i))) {
      const end = line.indexOf("]", i);
      const stop = end === -1 ? n : end + 1;
      out.push("meta", line.slice(i, stop), "decorator");
      i = stop;
      expectValue = true;
      continue;
    }

    // A decorator or annotation: `@Component`, `@staticmethod`, `@interface`.
    if (spec.atDecorator && c === 64 && isAlphaCh(line.charCodeAt(i + 1))) {
      let j = i + 1;
      while (
        j < n &&
        (isIdentCh(line.charCodeAt(j)) || line.charCodeAt(j) === 46)
      )
        j++;
      out.push("meta", line.slice(i, j), "decorator");
      i = j;
      expectValue = false;
      continue;
    }

    // A variable sigil: `$PATH`, `${x}`, `@ivar`, `@@class`.
    if (spec.sigils && spec.sigils.includes(line[i]!)) {
      const j = readVariable(line, i);
      if (j > i + 1) {
        out.push("meta", line.slice(i, j), "variable");
        i = j;
        expectValue = false;
        continue;
      }
    }

    // `:atom` / `:symbol`, but not `::` and not `a ? b : c`.
    if (
      spec.atoms &&
      c === 58 &&
      isAlphaCh(line.charCodeAt(i + 1)) &&
      line.charCodeAt(i - 1) !== 58
    ) {
      let j = i + 1;
      while (j < n && isIdentCh(line.charCodeAt(j))) j++;
      if (spec.identTail && j < n && spec.identTail.includes(line[j]!)) j++;
      out.push("constant", line.slice(i, j));
      i = j;
      expectValue = false;
      continue;
    }

    // A Rust lifetime: `'a` with no closing quote is not a character.
    if (spec.lifetimes && c === 39 && isAlphaCh(line.charCodeAt(i + 1))) {
      let j = i + 1;
      while (j < n && isIdentCh(line.charCodeAt(j))) j++;
      if (line.charCodeAt(j) !== 39) {
        out.push("meta", line.slice(i, j), "variable");
        i = j;
        expectValue = false;
        continue;
      }
    }

    // `/>` closes a JSX tag that an `{expression}` attribute interrupted.
    if (spec.jsx && c === 47 && line.charCodeAt(i + 1) === 62) {
      out.push("punctuation", "/>");
      i += 2;
      expectValue = true;
      continue;
    }

    // JSX/TSX markup, where a value is expected.
    if (spec.jsx && c === 60 && expectValue) {
      const consumed = scanJsxTag(line, i, out);
      if (consumed > i) {
        i = consumed;
        expectValue = true;
        continue;
      }
    }

    // A string, or a regex literal where a value is expected.
    const strSpec = spec.strings.find(
      (s) =>
        line.startsWith(s.open, i) && (s.valueOnly !== true || expectValue),
    );
    if (strSpec) {
      // An empty regex `//` is a comment everywhere it could be one.
      const bodyStart = i + strSpec.open.length;
      const consumed = consumeStringBody(line, bodyStart, strSpec);
      const cls = strSpec.cls ?? "string";
      if (consumed.closed) {
        let end = consumed.end;
        // Regex flags, string suffixes: `/x/gi`, `"a"u8`.
        while (end < n && isAlphaCh(line.charCodeAt(end))) end++;
        pushString(
          out,
          line.slice(i, end),
          strSpec.interpolate === true,
          cls,
          strSpec.kind,
          strSpec.interpolateAs ?? "code",
        );
        i = end;
      } else if (strSpec.multiline) {
        pushString(
          out,
          line.slice(i),
          strSpec.interpolate === true,
          cls,
          strSpec.kind,
          strSpec.interpolateAs ?? "code",
        );
        i = n;
        state = {
          ...state,
          str: {
            close: strSpec.close,
            escape: strSpec.escape,
            ...(strSpec.interpolate === true ? { interpolate: true } : {}),
            ...(strSpec.interpolateAs === undefined
              ? {}
              : { interpolateAs: strSpec.interpolateAs }),
          },
        };
      } else {
        // Unterminated single-line string: take the rest of the line.
        pushString(
          out,
          line.slice(i),
          strSpec.interpolate === true,
          cls,
          strSpec.kind,
          strSpec.interpolateAs ?? "code",
        );
        i = n;
      }
      expectValue = false;
      continue;
    }

    // A heredoc opener: `<<EOF`, `<<-'EOF'`, `<<~HTML`.
    if (spec.heredoc && c === 60 && line.charCodeAt(i + 1) === 60) {
      const opener = /^<<([-~]?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(
        line.slice(i),
      );
      if (opener) {
        out.push("operator", line.slice(i, i + 2 + opener[1]!.length));
        out.push("meta", opener[0].slice(2 + opener[1]!.length));
        i += opener[0].length;
        pendingHeredoc = { tag: opener[3]!, indent: opener[1] !== "" };
        expectValue = false;
        continue;
      }
    }

    // A command-line flag: `-v`, `--long-form`, `-euo`.
    if (
      spec.flags &&
      c === 45 &&
      (i === 0 || isSpaceCh(line.charCodeAt(i - 1))) &&
      !atCommand
    ) {
      const flag = /^--?[A-Za-z][A-Za-z0-9_-]*/.exec(line.slice(i));
      if (flag) {
        out.push("constant", flag[0], "attribute");
        i += flag[0].length;
        expectValue = false;
        continue;
      }
    }

    // Number.
    if (
      isDigitCh(c) ||
      (c === 46 && isDigitCh(line.charCodeAt(i + 1)) && expectValue)
    ) {
      const j = scanNumber(line, i);
      out.push("number", line.slice(i, j));
      i = j;
      expectValue = false;
      continue;
    }

    // Identifier / keyword / type / constant / function.
    if (isAlphaCh(c) || c === 95 || (c === 36 && !spec.sigils)) {
      let j = i + 1;
      while (
        j < n &&
        (isIdentCh(line.charCodeAt(j)) ||
          line.charCodeAt(j) === 36 ||
          (spec.identInner !== undefined && spec.identInner.includes(line[j]!)))
      )
        j++;
      if (spec.identTail && j < n && spec.identTail.includes(line[j]!)) j++;
      const word = line.slice(i, j);
      const probe = spec.ignoreCase === true ? word.toLowerCase() : word;
      const call = line[j] === "(";

      let cls: TokenClass = "plain";
      let kind: TokenKind | undefined;
      if (spec.keywords.has(probe)) cls = "keyword";
      else if (spec.constants.has(probe)) cls = "constant";
      else if (spec.types.has(probe)) cls = "type";
      else if (spec.defineAfter?.has(lastWord)) {
        cls = spec.typeAfter?.has(lastWord) ? "type" : "function";
      } else if (spec.typeAfter?.has(lastWord)) cls = "type";
      else if (spec.macroBang && line[j] === "!" && line[j + 1] !== "=") {
        // `println!` is one thing, not a name and a negation.
        out.push("function", `${word}!`, "decorator");
        lastWord = probe;
        atCommand = false;
        i = j + 1;
        expectValue = true;
        continue;
      } else if (call && spec.callAsFunction) cls = "function";
      else if (
        spec.dotProperty &&
        i > 0 &&
        line.charCodeAt(i - 1) === 46 &&
        line.charCodeAt(i - 2) !== 46
      ) {
        cls = "plain";
        kind = "property";
      } else if (spec.capitalIsType !== false && isUpperCh(c)) cls = "type";
      else if (spec.commandPosition && atCommand)
        cls = line[j] === "=" ? "plain" : "function";
      if (spec.commandPosition && atCommand && line[j] === "=")
        kind = "variable";

      out.push(cls, word, kind);
      lastWord = probe;
      i = j;
      expectValue =
        cls === "keyword" && !spec.constants.has(probe) && probe !== "this";
      atCommand =
        cls === "keyword" && COMMAND_OPENERS.has(probe) ? true : false;
      continue;
    }

    // Operators and punctuation.
    if (c === 123) state = { ...state, depth: state.depth + 1 };
    if (c === 125) state = { ...state, depth: Math.max(0, state.depth - 1) };
    if (
      c === 40 ||
      c === 41 ||
      c === 91 ||
      c === 93 ||
      c === 123 ||
      c === 125 ||
      c === 59 ||
      c === 44 ||
      c === 46
    ) {
      out.push("punctuation", line[i]!);
      expectValue = c !== 41 && c !== 93 && c !== 46;
    } else {
      out.push("operator", line[i]!);
      expectValue = true;
    }
    if (c === 124 || c === 59 || c === 38 || c === 40 || c === 123)
      atCommand = true;
    else if (!isSpaceCh(c)) atCommand = false;
    lastWord = "";
    i++;
  }

  const next: ScanState =
    pendingHeredoc === null ? state : { ...state, heredoc: pendingHeredoc };
  return { tokens: out.done(), state: next };
}

/** `$name`, `${expr}`, `$(cmd)`, `@ivar`, `@@cvar`, `$1`. */
function readVariable(line: string, at: number): number {
  const n = line.length;
  let i = at + 1;
  if (line.charCodeAt(at) === 64 && line.charCodeAt(i) === 64) i++; // @@cvar
  const c = line.charCodeAt(i);
  if (c === 123 /* { */ || c === 40 /* ( */) {
    const close = c === 123 ? 125 : 41;
    let depth = 1;
    i++;
    while (i < n && depth > 0) {
      const d = line.charCodeAt(i);
      if (d === c) depth++;
      else if (d === close) depth--;
      i++;
    }
    return i;
  }
  if (isDigitCh(c) || c === 42 || c === 64 || c === 63 || c === 35)
    return i + 1;
  while (i < n && isIdentCh(line.charCodeAt(i))) i++;
  return i;
}

/**
 * A JSX element's opening or closing tag. Returns where it ends, or `at` if
 * this `<` was not markup after all. Inside the tag, names and attributes get
 * their own colours; a `{` hands control back to the code scanner.
 */
function scanJsxTag(line: string, at: number, out: Out): number {
  const n = line.length;
  let i = at + 1;
  if (line[i] === "/") i++;
  const start = i;
  while (
    i < n &&
    (isIdentCh(line.charCodeAt(i)) || line[i] === "." || line[i] === "-")
  )
    i++;
  // `<>` (a fragment) is markup; `a < b` is not.
  if (i === start && line[at + 1] !== ">") return at;
  out.push("punctuation", line.slice(at, start));
  out.push("keyword", line.slice(start, i), "tag");

  while (i < n) {
    const c = line.charCodeAt(i);
    if (isSpaceCh(c)) {
      const j = spaceRun(line, i);
      out.push("plain", line.slice(i, j));
      i = j;
      continue;
    }
    if (c === 62 /* > */) {
      out.push("punctuation", ">");
      return i + 1;
    }
    if (c === 47 && line.charCodeAt(i + 1) === 62) {
      out.push("punctuation", "/>");
      return i + 2;
    }
    if (c === 123 /* { */) return i; // an expression: back to the code scanner
    if (c === 61 /* = */) {
      out.push("operator", "=");
      i++;
      continue;
    }
    if (c === 34 || c === 39) {
      const quote = line[i]!;
      const consumed = consumeStringBody(line, i + 1, {
        close: quote,
        escape: true,
      });
      out.push("string", line.slice(i, consumed.end));
      i = consumed.end;
      continue;
    }
    if (isAlphaCh(c) || c === 95) {
      let j = i;
      while (
        j < n &&
        (isIdentCh(line.charCodeAt(j)) || line[j] === "-" || line[j] === ":")
      )
        j++;
      out.push("type", line.slice(i, j), "attribute");
      i = j;
      continue;
    }
    out.push("punctuation", line[i]!);
    i++;
  }
  return n;
}

// ---- Markdown ----

const FENCE = /^(\s*)(```+|~~~+)(.*)$/;

/**
 * Markdown, block by block. A fenced block carries its info string's language
 * and scans its body with that language's scanner — the thing that makes a
 * README's code samples look like code and not like prose.
 */
function scanMarkdown(line: string, state: ScanState): Scanned {
  const out = new Out();

  if (state.embed) {
    const embed = state.embed;
    const closing = FENCE.exec(line);
    if (
      closing &&
      closing[2]!.startsWith(embed.end) &&
      closing[3]!.trim() === ""
    ) {
      out.push("plain", closing[1]!);
      out.push("meta", closing[2]! + closing[3]!);
      return { tokens: out.done(), state: { ...state, embed: null } };
    }
    const inner = scanOneLine(line, embed.lang, embed.inner);
    out.take(inner.tokens);
    return {
      tokens: out.done(),
      state: { ...state, embed: { ...embed, inner: inner.state } },
    };
  }

  const fence = FENCE.exec(line);
  if (fence) {
    out.push("plain", fence[1]!);
    out.push("meta", fence[2]!);
    out.push("type", fence[3]!);
    const lang = languageFromName(fence[3]!);
    return {
      tokens: out.done(),
      state: {
        ...state,
        embed: { lang, end: fence[2]!.slice(0, 3), inner: INITIAL_SCAN },
      },
    };
  }

  // An indented code block: four spaces (or a tab) with nothing around it.
  if (/^(\t| {4})\S/.test(line)) {
    out.push("string", line);
    return { tokens: out.done(), state };
  }

  const heading = /^(\s{0,3}#{1,6})(\s.*)?$/.exec(line);
  if (heading) {
    out.push("keyword", line, "heading");
    return { tokens: out.done(), state };
  }
  if (/^\s{0,3}(=+|-{2,})\s*$/.test(line) && line.trim() !== "") {
    out.push("keyword", line, "heading");
    return { tokens: out.done(), state };
  }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
    out.push("punctuation", line);
    return { tokens: out.done(), state };
  }

  let i = 0;
  const quote = /^(\s*(?:>\s?)+)/.exec(line);
  if (quote) {
    out.push("comment", quote[1]!);
    i = quote[1]!.length;
  }
  const bullet = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(line.slice(i));
  if (bullet) {
    out.push("plain", bullet[1]!);
    out.push("punctuation", bullet[2]!);
    out.push("plain", bullet[3]!);
    i += bullet[0].length;
    const task = /^\[[ xX]\]/.exec(line.slice(i));
    if (task) {
      out.push("constant", task[0]);
      i += task[0].length;
    }
  }
  scanMarkdownInline(line.slice(i), out, quote !== null);
  return { tokens: out.done(), state };
}

/** Inline markdown: code spans, emphasis, links, autolinks, table pipes. */
function scanMarkdownInline(text: string, out: Out, quoted: boolean): void {
  const base: TokenClass = quoted ? "comment" : "plain";
  const n = text.length;
  let i = 0;
  let run = 0;
  const flush = (to: number) => {
    out.push(base, text.slice(run, to));
    run = to;
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === 96 /* ` */) {
      let ticks = 0;
      while (text.charCodeAt(i + ticks) === 96) ticks++;
      const close = text.indexOf("`".repeat(ticks), i + ticks);
      if (close !== -1) {
        flush(i);
        const end = close + ticks;
        out.push("string", text.slice(i, end));
        i = end;
        run = end;
        continue;
      }
      i += ticks;
      continue;
    }
    if (c === 42 /* * */ || c === 95 /* _ */) {
      const marker = text[i]!;
      const doubled = text[i + 1] === marker;
      const open = doubled ? marker + marker : marker;
      const close = text.indexOf(open, i + open.length);
      if (close !== -1 && close > i + open.length) {
        flush(i);
        const end = close + open.length;
        out.push("plain", text.slice(i, end), "emphasis");
        i = end;
        run = end;
        continue;
      }
      i += open.length;
      continue;
    }
    if (c === 91 /* [ */ || (c === 33 && text.charCodeAt(i + 1) === 91)) {
      const openAt = c === 33 ? i + 1 : i;
      const close = text.indexOf("]", openAt);
      if (close !== -1 && text[close + 1] === "(") {
        const end = text.indexOf(")", close + 2);
        if (end !== -1) {
          flush(i);
          out.push("punctuation", text.slice(i, openAt + 1));
          out.push("meta", text.slice(openAt + 1, close), "link");
          out.push("punctuation", "](");
          out.push("string", text.slice(close + 2, end), "link");
          out.push("punctuation", ")");
          i = end + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 60 /* < */) {
      const close = text.indexOf(">", i);
      if (
        close !== -1 &&
        /^<(https?:\/\/|mailto:)[^>\s]+>$/.test(text.slice(i, close + 1))
      ) {
        flush(i);
        out.push("meta", text.slice(i, close + 1), "link");
        i = close + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 124 /* | */) {
      flush(i);
      out.push("punctuation", "|");
      i++;
      run = i;
      continue;
    }
    i++;
  }
  flush(n);
}

// ---- YAML ----

const YAML_KEY =
  /^(\s*(?:-\s+)*)((?:"[^"]*"|'[^']*'|[^\s:#][^:#]*?))(\s*:)(\s|$)/;

function scanYaml(line: string, state: ScanState): Scanned {
  const out = new Out();

  // A block scalar's body: everything indented past the introducing line.
  if (state.scalar !== null) {
    const indent = indentOf(line);
    if (indent === -1 || indent > state.scalar) {
      out.push("string", line);
      return { tokens: out.done(), state };
    }
    state = { ...state, scalar: null };
  }

  if (/^\s*#/.test(line)) {
    out.push("comment", line);
    return { tokens: out.done(), state };
  }
  if (/^(---|\.\.\.)\s*$/.test(line)) {
    out.push("meta", line);
    return { tokens: out.done(), state };
  }

  let i = 0;
  const key = YAML_KEY.exec(line);
  if (key) {
    out.push("plain", key[1]!);
    out.push("keyword", key[2]!, "property");
    out.push("punctuation", key[3]!);
    i = key[1]!.length + key[2]!.length + key[3]!.length;
  } else {
    const dash = /^(\s*)(-)(\s|$)/.exec(line);
    if (dash) {
      out.push("plain", dash[1]!);
      out.push("punctuation", "-");
      i = dash[1]!.length + 1;
    }
  }

  // A block scalar indicator ends the line and opens the body.
  const scalar = /^(\s*)([|>][+-]?\d*)\s*(#.*)?$/.exec(line.slice(i));
  if (scalar) {
    out.push("plain", scalar[1]!);
    out.push("operator", scalar[2]!);
    if (scalar[3])
      out.push("comment", line.slice(line.length - scalar[3].length));
    else
      out.push("plain", line.slice(i + scalar[1]!.length + scalar[2]!.length));
    return {
      tokens: out.done(),
      state: { ...state, scalar: Math.max(0, indentOf(line)) },
    };
  }

  scanYamlValue(line, i, out);
  return { tokens: out.done(), state };
}

function scanYamlValue(line: string, from: number, out: Out): void {
  const n = line.length;
  let i = from;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (isSpaceCh(c)) {
      const j = spaceRun(line, i);
      out.push("plain", line.slice(i, j));
      i = j;
      continue;
    }
    if (c === 35 /* # */ && (i === 0 || isSpaceCh(line.charCodeAt(i - 1)))) {
      out.push("comment", line.slice(i));
      return;
    }
    if (c === 34 || c === 39) {
      const consumed = consumeStringBody(line, i + 1, {
        close: line[i]!,
        escape: c === 34,
      });
      out.push("string", line.slice(i, consumed.end));
      i = consumed.end;
      continue;
    }
    if (c === 38 /* & */ || c === 42 /* * */) {
      let j = i + 1;
      while (j < n && isIdentCh(line.charCodeAt(j))) j++;
      if (j > i + 1) {
        out.push("meta", line.slice(i, j), "variable");
        i = j;
        continue;
      }
    }
    if (c === 33 /* ! */) {
      let j = i;
      while (j < n && !isSpaceCh(line.charCodeAt(j))) j++;
      out.push("type", line.slice(i, j));
      i = j;
      continue;
    }
    if (isDigitCh(c) || (c === 45 && isDigitCh(line.charCodeAt(i + 1)))) {
      let j = c === 45 ? i + 1 : i;
      j = scanNumber(line, j);
      // A date reads as a number too: 2026-09-01.
      while (j < n && /[-:.TZ0-9+]/.test(line[j]!)) j++;
      out.push("number", line.slice(i, j));
      i = j;
      continue;
    }
    if (isAlphaCh(c) || c === 95) {
      let j = i;
      while (j < n && (isIdentCh(line.charCodeAt(j)) || line[j] === "-")) j++;
      const word = line.slice(i, j);
      const lower = word.toLowerCase();
      const isConst =
        lower === "true" ||
        lower === "false" ||
        lower === "null" ||
        lower === "yes" ||
        lower === "no" ||
        lower === "on" ||
        lower === "off" ||
        lower === "~";
      out.push(isConst ? "constant" : "plain", word);
      i = j;
      continue;
    }
    if (c === 123 || c === 125 || c === 91 || c === 93 || c === 44)
      out.push("punctuation", line[i]!);
    else out.push("operator", line[i]!);
    i++;
  }
}

// ---- TOML and INI ----

function scanToml(line: string, state: ScanState, toml: boolean): Scanned {
  const out = new Out();

  if (state.str) {
    const consumed = consumeStringBody(line, 0, state.str);
    out.push("string", line.slice(0, consumed.end));
    if (!consumed.closed) return { tokens: out.done(), state };
    scanTomlValue(line, consumed.end, out, toml);
    return { tokens: out.done(), state: { ...state, str: null } };
  }

  const comment = /^(\s*)([#;].*)$/.exec(line);
  if (comment) {
    out.push("plain", comment[1]!);
    out.push("comment", comment[2]!);
    return { tokens: out.done(), state };
  }
  const table = /^(\s*)(\[\[?[^\]]*\]\]?)(.*)$/.exec(line);
  if (table) {
    out.push("plain", table[1]!);
    out.push("type", table[2]!, "heading");
    out.push("plain", table[3]!);
    return { tokens: out.done(), state };
  }
  const assign = /^(\s*)((?:"[^"]*"|[^=\s]+))(\s*=\s*)/.exec(line);
  if (assign) {
    out.push("plain", assign[1]!);
    out.push("keyword", assign[2]!, "property");
    out.push("operator", assign[3]!);
    return scanTomlRest(line, assign[0].length, out, state, toml);
  }
  return scanTomlRest(line, 0, out, state, toml);
}

function scanTomlRest(
  line: string,
  from: number,
  out: Out,
  state: ScanState,
  toml: boolean,
): Scanned {
  if (toml && line.startsWith('"""', from)) {
    const consumed = consumeStringBody(line, from + 3, {
      close: '"""',
      escape: true,
    });
    out.push("string", line.slice(from, consumed.end));
    if (!consumed.closed) {
      return {
        tokens: out.done(),
        state: { ...state, str: { close: '"""', escape: true } },
      };
    }
    scanTomlValue(line, consumed.end, out, toml);
    return { tokens: out.done(), state };
  }
  scanTomlValue(line, from, out, toml);
  return { tokens: out.done(), state };
}

function scanTomlValue(
  line: string,
  from: number,
  out: Out,
  toml: boolean,
): void {
  const n = line.length;
  let i = from;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (isSpaceCh(c)) {
      const j = spaceRun(line, i);
      out.push("plain", line.slice(i, j));
      i = j;
      continue;
    }
    if (c === 35 || (!toml && c === 59)) {
      out.push("comment", line.slice(i));
      return;
    }
    if (c === 34 || c === 39) {
      const consumed = consumeStringBody(line, i + 1, {
        close: line[i]!,
        escape: c === 34,
      });
      out.push("string", line.slice(i, consumed.end));
      i = consumed.end;
      continue;
    }
    if (isDigitCh(c) || (c === 45 && isDigitCh(line.charCodeAt(i + 1)))) {
      let j = scanNumber(line, c === 45 ? i + 1 : i);
      while (j < n && /[-:.TZ0-9+]/.test(line[j]!)) j++;
      out.push("number", line.slice(i, j));
      i = j;
      continue;
    }
    if (isAlphaCh(c) || c === 95) {
      let j = i;
      while (j < n && (isIdentCh(line.charCodeAt(j)) || line[j] === "-")) j++;
      const word = line.slice(i, j);
      out.push(
        word === "true" || word === "false" ? "constant" : "plain",
        word,
      );
      i = j;
      continue;
    }
    if (c === 91 || c === 93 || c === 123 || c === 125 || c === 44)
      out.push("punctuation", line[i]!);
    else out.push("operator", line[i]!);
    i++;
  }
}

// ---- HTML ----

function scanHtml(line: string, state: ScanState): Scanned {
  const out = new Out();
  let i = 0;
  const n = line.length;

  // Inside <script>/<style>: scan with that language until the closing tag.
  if (state.embed) {
    const embed = state.embed;
    const close = line.toLowerCase().indexOf(embed.end);
    if (close === -1) {
      const inner = scanOneLine(line, embed.lang, embed.inner);
      out.take(inner.tokens);
      return {
        tokens: out.done(),
        state: { ...state, embed: { ...embed, inner: inner.state } },
      };
    }
    if (close > 0) {
      const inner = scanOneLine(line.slice(0, close), embed.lang, embed.inner);
      out.take(inner.tokens);
    }
    i = close;
    state = { ...state, embed: null };
  }

  if (state.block) {
    const end = line.indexOf("-->", i);
    if (end === -1) {
      out.push("comment", line.slice(i));
      return { tokens: out.done(), state };
    }
    out.push("comment", line.slice(i, end + 3));
    i = end + 3;
    state = { ...state, block: false };
  }

  while (i < n) {
    if (state.tag) {
      i = scanHtmlAttributes(line, i, out);
      if (i < n || line.endsWith(">")) state = { ...state, tag: false };
      continue;
    }
    const lt = line.indexOf("<", i);
    if (lt === -1) {
      pushHtmlText(out, line.slice(i));
      i = n;
      continue;
    }
    pushHtmlText(out, line.slice(i, lt));
    i = lt;

    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      if (end === -1) {
        out.push("comment", line.slice(i));
        return { tokens: out.done(), state: { ...state, block: true } };
      }
      out.push("comment", line.slice(i, end + 3));
      i = end + 3;
      continue;
    }
    if (line.startsWith("<!", i) || line.startsWith("<?", i)) {
      const end = line.indexOf(">", i);
      const stop = end === -1 ? n : end + 1;
      out.push("meta", line.slice(i, stop));
      i = stop;
      continue;
    }
    const name = /^<\/?([A-Za-z][A-Za-z0-9:-]*)/.exec(line.slice(i));
    if (!name) {
      out.push("punctuation", "<");
      i++;
      continue;
    }
    const lead = name[0].startsWith("</") ? 2 : 1;
    out.push("punctuation", line.slice(i, i + lead));
    out.push("keyword", name[1]!, "tag");
    i += name[0].length;
    const after = scanHtmlAttributes(line, i, out);
    const tag = name[1]!.toLowerCase();
    const closed = line.slice(i, after).includes(">");
    i = after;
    if (!closed) {
      state = { ...state, tag: true };
      continue;
    }
    if (lead === 1 && (tag === "script" || tag === "style")) {
      state = {
        ...state,
        embed: {
          lang: tag === "script" ? "ts" : "css",
          end: `</${tag}`,
          inner: INITIAL_SCAN,
        },
      };
      const rest = line.toLowerCase().indexOf(`</${tag}`, i);
      if (rest === -1) {
        if (i < n) {
          const inner = scanOneLine(
            line.slice(i),
            tag === "script" ? "ts" : "css",
            INITIAL_SCAN,
          );
          out.take(inner.tokens);
        }
        return { tokens: out.done(), state };
      }
      const inner = scanOneLine(
        line.slice(i, rest),
        tag === "script" ? "ts" : "css",
        INITIAL_SCAN,
      );
      out.take(inner.tokens);
      i = rest;
      state = { ...state, embed: null };
    }
  }
  return { tokens: out.done(), state };
}

/** Text between tags, with entities picked out. */
function pushHtmlText(out: Out, text: string): void {
  let run = 0;
  const entity = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
  let match: RegExpExecArray | null;
  while ((match = entity.exec(text)) !== null) {
    out.push("plain", text.slice(run, match.index));
    out.push("constant", match[0]);
    run = match.index + match[0].length;
  }
  out.push("plain", text.slice(run));
}

/** Attributes up to and including the `>` that closes the tag. */
function scanHtmlAttributes(line: string, from: number, out: Out): number {
  const n = line.length;
  let i = from;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (isSpaceCh(c)) {
      const j = spaceRun(line, i);
      out.push("plain", line.slice(i, j));
      i = j;
      continue;
    }
    if (c === 62 /* > */) {
      out.push("punctuation", ">");
      return i + 1;
    }
    if (c === 47 && line.charCodeAt(i + 1) === 62) {
      out.push("punctuation", "/>");
      return i + 2;
    }
    if (c === 61) {
      out.push("operator", "=");
      i++;
      continue;
    }
    if (c === 34 || c === 39) {
      const consumed = consumeStringBody(line, i + 1, {
        close: line[i]!,
        escape: false,
      });
      out.push("string", line.slice(i, consumed.end));
      i = consumed.end;
      continue;
    }
    let j = i;
    while (
      j < n &&
      !isSpaceCh(line.charCodeAt(j)) &&
      line[j] !== "=" &&
      line[j] !== ">"
    )
      j++;
    if (j === i) j++;
    out.push("type", line.slice(i, j), "attribute");
    i = j;
  }
  return n;
}

// ---- CSS (and SCSS/LESS) ----

function scanCss(line: string, initial: ScanState): Scanned {
  const out = new Out();
  let state = initial;
  let i = 0;
  let paren = 0;
  const n = line.length;

  if (state.block) {
    const end = line.indexOf("*/");
    if (end === -1) {
      out.push("comment", line);
      return { tokens: out.done(), state };
    }
    out.push("comment", line.slice(0, end + 2));
    i = end + 2;
    state = { ...state, block: false };
  }

  while (i < n) {
    const c = line.charCodeAt(i);
    if (isSpaceCh(c)) {
      const j = spaceRun(line, i);
      out.push("plain", line.slice(i, j));
      i = j;
      continue;
    }
    if (line.startsWith("//", i)) {
      out.push("comment", line.slice(i));
      break;
    }
    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        out.push("comment", line.slice(i));
        state = { ...state, block: true };
        break;
      }
      out.push("comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (c === 34 || c === 39) {
      const consumed = consumeStringBody(line, i + 1, {
        close: line[i]!,
        escape: true,
      });
      out.push("string", line.slice(i, consumed.end));
      i = consumed.end;
      continue;
    }
    if (c === 64 /* @ */) {
      let j = i + 1;
      while (j < n && (isIdentCh(line.charCodeAt(j)) || line[j] === "-")) j++;
      out.push("keyword", line.slice(i, j));
      i = j;
      continue;
    }
    if (c === 36 /* $ */ || line.startsWith("--", i)) {
      let j = i + (c === 36 ? 1 : 2);
      while (j < n && (isIdentCh(line.charCodeAt(j)) || line[j] === "-")) j++;
      out.push("meta", line.slice(i, j), "variable");
      i = j;
      continue;
    }
    if (c === 33 /* ! */) {
      const bang = /^![a-z-]+/.exec(line.slice(i));
      if (bang) {
        out.push("meta", bang[0]);
        i += bang[0].length;
        continue;
      }
    }
    if (c === 35 /* # */ && /^#[0-9a-fA-F]{3,8}\b/.test(line.slice(i))) {
      const hex = /^#[0-9a-fA-F]{3,8}/.exec(line.slice(i))!;
      out.push("number", hex[0]);
      i += hex[0].length;
      continue;
    }
    if (isDigitCh(c) || (c === 46 && isDigitCh(line.charCodeAt(i + 1)))) {
      let j = scanNumber(line, i);
      const unit = /^(%|[a-zA-Z]+)/.exec(line.slice(j));
      if (unit) j += unit[0].length;
      out.push("number", line.slice(i, j));
      i = j;
      continue;
    }
    if (c === 123) {
      out.push("punctuation", "{");
      state = { ...state, depth: state.depth + 1 };
      i++;
      continue;
    }
    if (c === 125) {
      out.push("punctuation", "}");
      state = { ...state, depth: Math.max(0, state.depth - 1) };
      i++;
      continue;
    }
    if (c === 46 || c === 35 /* .class #id */) {
      const sel = /^[.#][A-Za-z_-][A-Za-z0-9_-]*/.exec(line.slice(i));
      if (sel && state.depth === 0) {
        out.push("function", sel[0]);
        i += sel[0].length;
        continue;
      }
    }
    if (c === 58 /* : */) {
      const pseudo = /^::?[A-Za-z-]+/.exec(line.slice(i));
      if (pseudo && state.depth === 0) {
        out.push("type", pseudo[0]);
        i += pseudo[0].length;
        continue;
      }
    }
    if (isAlphaCh(c) || c === 95 || c === 45) {
      let j = i;
      while (j < n && (isIdentCh(line.charCodeAt(j)) || line[j] === "-")) j++;
      const word = line.slice(i, j);
      const after = spaceRun(line, j);
      if (line[j] === "(") out.push("function", word);
      else if ((state.depth > 0 || paren > 0) && line[after] === ":")
        out.push("keyword", word, "property");
      else if (state.depth > 0) out.push("constant", word);
      else out.push("type", word, "tag");
      i = j;
      continue;
    }
    if (c === 40) paren++;
    if (c === 41) paren = Math.max(0, paren - 1);
    if (c === 44 || c === 59 || c === 40 || c === 41)
      out.push("punctuation", line[i]!);
    else out.push("operator", line[i]!);
    i++;
  }
  return { tokens: out.done(), state };
}

// ---- diff ----

function scanDiff(line: string, state: ScanState): Scanned {
  const out = new Out();
  if (
    /^(diff |index |new file|deleted file|similarity|rename |old mode|new mode)/.test(
      line,
    )
  ) {
    out.push("meta", line);
  } else if (line.startsWith("@@")) {
    out.push("function", line);
  } else if (line.startsWith("+++") || line.startsWith("---")) {
    out.push("meta", line, "heading");
  } else if (line.startsWith("+")) {
    out.push("meta", line, "inserted");
  } else if (line.startsWith("-")) {
    out.push("keyword", line, "deleted");
  } else if (line.startsWith("\\")) {
    out.push("comment", line);
  } else {
    out.push("plain", line);
  }
  return { tokens: out.done(), state };
}

// ---- Makefile ----

function scanMakefile(line: string, state: ScanState): Scanned {
  const out = new Out();
  if (/^\s*#/.test(line)) {
    out.push("comment", line);
    return { tokens: out.done(), state };
  }
  // A recipe line is shell, and reads far better scanned as shell.
  if (line.startsWith("\t")) {
    out.push("punctuation", "\t");
    const inner = scanOneLine(line.slice(1), "shell", INITIAL_SCAN);
    out.take(inner.tokens);
    return { tokens: out.done(), state };
  }
  const target = /^([A-Za-z0-9_./$()%-]+)(\s*:{1,2}=?)(?!=)/.exec(line);
  if (target && !line.slice(0, target[1]!.length).includes("=")) {
    if (target[2]!.includes("=")) {
      out.push("keyword", target[1]!, "property");
    } else {
      out.push("function", target[1]!);
    }
    out.push("operator", target[2]!);
    scanMakeRest(line, target[0].length, out);
    return { tokens: out.done(), state };
  }
  const assign = /^([A-Za-z0-9_.-]+)(\s*[:+?]?=)/.exec(line);
  if (assign) {
    out.push("keyword", assign[1]!, "property");
    out.push("operator", assign[2]!);
    scanMakeRest(line, assign[0].length, out);
    return { tokens: out.done(), state };
  }
  const directive =
    /^(\s*)(include|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|export|unexport|vpath|\.PHONY)\b/.exec(
      line,
    );
  if (directive) {
    out.push("plain", directive[1]!);
    out.push("keyword", directive[2]!);
    scanMakeRest(line, directive[0].length, out);
    return { tokens: out.done(), state };
  }
  scanMakeRest(line, 0, out);
  return { tokens: out.done(), state };
}

function scanMakeRest(line: string, from: number, out: Out): void {
  const n = line.length;
  let i = from;
  let run = from;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 35 /* # */) {
      out.push("plain", line.slice(run, i));
      out.push("comment", line.slice(i));
      return;
    }
    if (c === 36 /* $ */) {
      const end = readVariable(line, i);
      out.push("plain", line.slice(run, i));
      out.push("meta", line.slice(i, end), "variable");
      i = end;
      run = end;
      continue;
    }
    i++;
  }
  out.push("plain", line.slice(run));
}

// ---- Dockerfile ----

function scanDockerfile(line: string, state: ScanState): Scanned {
  const out = new Out();
  if (/^\s*#/.test(line)) {
    out.push(/^\s*#\s*(syntax|escape)=/.test(line) ? "meta" : "comment", line);
    return { tokens: out.done(), state };
  }
  const instruction = /^(\s*)([A-Za-z]+)(\s|$)/.exec(line);
  let from = 0;
  if (instruction && DOCKER_INSTRUCTIONS.has(instruction[2]!.toUpperCase())) {
    out.push("plain", instruction[1]!);
    out.push("keyword", instruction[2]!);
    from = instruction[1]!.length + instruction[2]!.length;
  }
  const spec = SPECS.dockerfile!;
  const rest = scanGeneric(line.slice(from), spec, INITIAL_SCAN);
  out.take(rest.tokens);
  return { tokens: out.done(), state };
}
