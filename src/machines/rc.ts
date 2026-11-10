/**
 * What a machine's shell opens to (#10547): a greeting, a prompt with the
 * repository and branch, and history that is there next session.
 *
 * The rc file is a constant in this source, written into the cell's home; no
 * text from a request ever reaches it. What varies — which repository, which
 * machine, the app's own `tty` command — travels as environment variables
 * and a greeting file of plain text the rc only prints (`cat`), never
 * evaluates. The names are validated before they get here; the tty command
 * is stripped of control bytes.
 *
 * History lives in the person's own home, which is under
 * `FORGE_APP_DATA/machines/<repo>/<machine>/<person>/home`: per person,
 * repository and machine, and written after every command so a tab closed
 * mid-session loses nothing.
 */
import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "../git/env.ts";

export const RC_FILE = ".forge_rc";
export const GREETING_FILE = ".forge_greeting";
export const HISTORY_FILE = ".forge_history";
/** The checkout's directory under the person's workspace. */
export const CHECKOUT_DIR = "checkout";

/** The rc file: constant. Reads FORGE_REPO, FORGE_MACHINE and the greeting file. */
export const RC = `# The forge's machine shell rc. Written by the forge; edits are replaced.
case $- in *i*) ;; *) return ;; esac
export HISTFILE="$HOME/${HISTORY_FILE}"
export HISTSIZE=100000
export HISTFILESIZE=100000
export HISTCONTROL=ignoredups
shopt -s histappend checkwinsize
PROMPT_COMMAND='history -a'
alias ls='ls --color=auto'
alias ll='ls -lA --color=auto'
alias la='ls -A --color=auto'
alias grep='grep --color=auto'
forge_branch() {
  git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null
}
PS1='\\[\\e[1;36m\\]$FORGE_REPO\\[\\e[0m\\]:\\[\\e[1;33m\\]$(forge_branch)\\[\\e[0m\\] \\w \\$ '
if [ -d "$FORGE_CHECKOUT" ]; then cd "$FORGE_CHECKOUT"; fi
if [ -f "$HOME/${GREETING_FILE}" ]; then cat "$HOME/${GREETING_FILE}"; fi
`;

/** A one-line, printable form of text that may come from a repository's file. */
function plain(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "").slice(0, 200);
}

export interface GreetingFacts {
  readonly repo: string;
  readonly machine: string;
  /** Whether tmux holds the session, so detaching keeps it. */
  readonly detaches: boolean;
  /** Whether the checkout exists; without it the shell starts in home and says so. */
  readonly checkout: boolean;
  /** The app's own `tty` command from forge.json, when it has one. */
  readonly tty: string | null;
}

/** The greeting, in plain words: where you are and how to leave. */
export function greeting(facts: GreetingFacts): string {
  const leave = facts.detaches
    ? "To leave and keep this shell running, detach: press Ctrl-b then d. To end it, type exit."
    : "To leave, type exit (this shell ends with it).";
  const lines = [
    `This is the machine "${plain(facts.machine)}" of ${plain(facts.repo)}. ${facts.checkout ? "You are in its checkout, with bun and git on the path." : "Its checkout could not be made, so you are in your home directory; bun and git are on the path."}`,
    leave,
  ];
  if (facts.tty !== null && plain(facts.tty) !== "")
    lines.push(`The app's own terminal command: ${plain(facts.tty)}`);
  return `${lines.join("\n")}\n\n`;
}

/** Where a person's history is kept, under the data directory. */
export function historyPath(home: string): string {
  return join(home, HISTORY_FILE);
}

/** Write the rc and greeting into `home`, and make the history file exist. */
export function prepareHome(home: string, facts: GreetingFacts): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, RC_FILE), RC);
  writeFileSync(join(home, GREETING_FILE), greeting(facts));
  if (!existsSync(historyPath(home))) writeFileSync(historyPath(home), "");
}

/** How long a first clone may take before git is killed and the shell starts in home. */
export const CLONE_MS = 30_000;
/** First clones running at once across the forge; past it a shell starts in home. */
export const MAX_CLONES = 4;

const inflight = new Map<string, Promise<boolean>>();

/**
 * The person's checkout of the repository, cloned once from the bare
 * repository on the default branch; later sessions find it as they left it.
 *
 * Single-flight per target: a second handshake for the same person and
 * machine waits on the first clone rather than racing it. The clone goes to
 * a sibling directory and is renamed into place only when git finished, so
 * a half-made checkout is never mistaken for one. git is killed after
 * `timeoutMs` (which also bounds how much a huge repository can write), and
 * at most `MAX_CLONES` run at once; either way the answer is no, and the
 * greeting says the shell is in home. The clone runs beside the event loop.
 */
export function ensureCheckout(bareDir: string, dir: string, timeoutMs = CLONE_MS): Promise<boolean> {
  const target = join(dir, CHECKOUT_DIR);
  const running = inflight.get(target);
  if (running !== undefined) return running;
  if (existsSync(join(target, ".git"))) return Promise.resolve(true);
  if (inflight.size >= MAX_CLONES) return Promise.resolve(false);
  const flight = clone(bareDir, target, timeoutMs).finally(() => inflight.delete(target));
  inflight.set(target, flight);
  return flight;
}

async function clone(bareDir: string, target: string, timeoutMs: number): Promise<boolean> {
  const partial = `${target}.partial`;
  rmSync(partial, { recursive: true, force: true });
  let code = 1;
  try {
    const proc = Bun.spawn(["git", "clone", "--quiet", "--", bareDir, partial], {
      env: gitEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    code = await proc.exited;
  } catch {
    code = 1;
  }
  if (code === 0 && existsSync(join(partial, ".git"))) {
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
    return true;
  }
  rmSync(partial, { recursive: true, force: true });
  return false;
}

/** What the pty runs, and whether leaving it keeps the session (tmux holds it). */
export interface ShellPlan {
  readonly command: string;
  readonly detaches: boolean;
}

/**
 * The shell the pty runs: bash on the rc, in tmux where the machine has it.
 * Without bash, `/bin/sh` still prints the greeting and starts in the
 * checkout with a repository prompt, but has no branch in the prompt and no
 * persistent history (sh has neither).
 */
export function shellPlan(hasTmux: boolean, hasBash: boolean): ShellPlan {
  const sh = `if [ -d "$FORGE_CHECKOUT" ]; then cd "$FORGE_CHECKOUT"; fi; ` +
    `if [ -f "$HOME/${GREETING_FILE}" ]; then cat "$HOME/${GREETING_FILE}"; fi; PS1='$FORGE_REPO $ '; export PS1; exec /bin/sh -i`;
  const inner = hasBash ? `bash --rcfile "$HOME/${RC_FILE}" -i` : `/bin/sh -c '${sh.replace(/'/g, "'\\''")}'`;
  return hasTmux
    ? { command: `exec tmux -L forge new-session -A -s shell '${inner.replace(/'/g, "'\\''")}'`, detaches: true }
    : { command: `exec ${inner}`, detaches: false };
}
