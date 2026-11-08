/**
 * The argument parser. Forty lines, because a CLI with eight verbs does not
 * need a parser framework — and a dependency here would be the first one in
 * the whole forge.
 *
 * The only genuine ambiguity in `--key value` is whether `--key` takes a
 * value at all, so each command declares its value flags. Everything else is
 * a boolean flag or a positional, and `--` ends the flags for good.
 */

export interface Args {
  /** The subcommand, or undefined when none was given. */
  readonly command: string | undefined;
  readonly positional: readonly string[];
  flag(name: string): boolean;
  value(name: string): string | undefined;
}

export interface Spec {
  /** Flags that consume the following token: `--root ~/src`. */
  readonly values?: readonly string[];
}

export function parseArgs(argv: readonly string[], spec: Spec = {}): Args {
  const values = new Set(spec.values ?? []);
  const flags = new Set<string>();
  const named = new Map<string, string>();
  const positional: string[] = [];
  let rest = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (rest || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      rest = true;
      continue;
    }
    // `-h` and `-v` are the only short flags: two spellings of one idea are
    // fine, a whole short-flag grammar is not.
    if (!arg.startsWith("--")) {
      for (const ch of arg.slice(1)) flags.add(ch);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      named.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (values.has(body) && next !== undefined && !next.startsWith("-")) {
      named.set(body, next);
      i++;
      continue;
    }
    flags.add(body);
  }

  const [command, ...operands] = positional;
  return {
    command,
    positional: operands,
    flag: (name) => flags.has(name) || named.has(name),
    value: (name) => named.get(name),
  };
}

/** "5m", "90s", "2h", or a bare number of seconds. Milliseconds out. */
export function parseDuration(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "h":
      return n * 3_600_000;
    case "m":
      return n * 60_000;
    default:
      return n * 1000;
  }
}

/** `owner/name`, rejected as a pair rather than guessed at. */
export function parseRepoRef(
  text: string | undefined,
): { owner: string; name: string } | undefined {
  if (text === undefined) return undefined;
  const parts = text.trim().split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    return undefined;
  }
  return { owner: parts[0]!, name: parts[1]! };
}
