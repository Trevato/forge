/**
 * `E` — your own `$EDITOR`, running on the forge host, over a real pty.
 *
 * ## The security posture, first, because it decides everything else
 *
 * Running nvim server-side is **arbitrary code execution as the forge process
 * user**. Not in theory: `:!sh`, `:terminal`, `:w /etc/anything`, and
 * `~/.config/nvim/init.lua` executing on startup are all first-class features,
 * and CVE-2019-12735 was remote code execution in Neovim from *merely opening
 * a file* with an attacker-controlled modeline — which is the exact shape of a
 * git host whose job is displaying files other people wrote.
 *
 * That is coherent under exactly one framing, and this is it:
 *
 * > This is the operator's own single-user workbench. The person on the SSH
 * > channel is the person who owns the host account. The editor is not a
 * > feature of the forge; it is the operator's shell, reached through it.
 *
 * So the gating is:
 *
 * - **Opt-in, absent otherwise.** With `FORGE_EDITOR` unset the feature does
 *   not exist — no spawn, no temp file, one line of explanation and nothing
 *   else. Not "disabled with a message"; there is no code path.
 * - **argv, never a shell.** `FORGE_EDITOR` is a binary name or an absolute
 *   path, resolved once with `Bun.which`, and spawned as `[bin, file]`. git
 *   passes `$EDITOR` through a shell so that `"code -w"` works; that is a
 *   command-injection surface with no upside for one operator.
 * - **One at a time per session.** `ctx.suspend` refuses a nested handoff,
 *   which is the failure mode behind every "my TUI wedged after I shelled
 *   out" bug report.
 * - **Nothing is written to the repository by this file.** The editor edits a
 *   temp copy; the bytes come back through the commit dialog and reach git the
 *   one way anything does, `actions/contents.ts`.
 *
 * ## The pty
 *
 * `Bun.Terminal` gives a real pty. Three measured facts shape the code:
 * `name:` does **not** set the child's `TERM` (Bun defaults it to `dumb` when
 * an explicit `env` omits it, so `TERM` is passed by hand); the `exit`
 * callback is a pty lifecycle event and not the process's exit status (so we
 * await `proc.exited`); and a live `Terminal` refs the event loop, so it is
 * closed in a `finally` or the process never exits.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../app/app.ts";
import type { RawHost } from "../app/app.ts";
import type { Session } from "../session.ts";
import { message, runAsync } from "./common.ts";

/** The env var that turns the feature on. A binary name or absolute path. */
export const EDITOR_ENV = "FORGE_EDITOR";

let resolved: { name: string; bin: string } | null | undefined;

/** Resolve once. `null` caches "asked, and there is no such binary". */
function resolveEditor(): { name: string; bin: string } | null {
  if (resolved !== undefined) return resolved;
  const name = process.env[EDITOR_ENV];
  if (name === undefined || name.trim() === "") {
    resolved = null;
    return null;
  }
  // A name with an argument in it ("code -w") is refused rather than split:
  // splitting is the first step toward a shell, and the shell is the hole.
  if (/\s/.test(name.trim())) {
    resolved = null;
    return null;
  }
  const bin = Bun.which(name.trim());
  resolved = bin === null ? null : { name: name.trim(), bin };
  return resolved;
}

/** For tests: forget the cached resolution after changing the environment. */
export function forgetEditor(): void {
  resolved = undefined;
}

export function hasExternalEditor(): boolean {
  return resolveEditor() !== null;
}

/** The one line `E` prints when the feature is off. */
export function editorHint(): string {
  const name = process.env[EDITOR_ENV];
  if (name === undefined || name.trim() === "")
    return `set ${EDITOR_ENV}=nvim on the forge host to edit with your own editor`;
  return `${EDITOR_ENV}=${name} is set, but no such program is on the host's PATH`;
}

export interface ExternalEditOptions {
  readonly path: string;
  readonly body: Uint8Array;
  /** Called only when the bytes actually changed. */
  onEdited(bytes: Uint8Array): void;
  /**
   * The screen's own abort signal. It fires when the session ends, and a
   * session that ends mid-edit must take the editor with it: the child owns
   * a pty nobody is attached to any more, and a live pty refs the event loop
   * forever. Without this, every dropped SSH connection leaks an nvim.
   */
  readonly signal?: AbortSignal;
}

/**
 * Write the file to a temp directory, hand the terminal over, and bring back
 * whatever the editor left behind.
 */
export function externalEditor(
  f: Session,
  ctx: Ctx,
  o: ExternalEditOptions,
): void {
  const editor = resolveEditor();
  if (editor === null) {
    ctx.toast(editorHint(), "attn");
    return;
  }
  runAsync(ctx, async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-edit-"));
    const name = o.path.slice(o.path.lastIndexOf("/") + 1) || "file";
    const file = join(dir, name);
    try {
      await writeFile(file, o.body);
      // The audit trail this deserves is an outbox event; appending one from
      // an adapter would break invariant 5, and there is no action for it
      // yet, so it is a log line and a named gap (see docs/DESIGN.md).
      f.app.log.warn("external editor launched", {
        user: f.user?.username ?? "guest",
        editor: editor.bin,
        path: o.path,
      });
      const code = await ctx.suspend((host) =>
        runEditor(host, editor.bin, file, dir, o.signal),
      );
      if (code === undefined) {
        ctx.toast("an editor is already running on this session", "attn");
        return;
      }
      const after = new Uint8Array(await readFile(file));
      if (code !== 0) ctx.toast(`${editor.name} exited with ${code}`, "attn");
      if (sameBytes(o.body, after)) {
        ctx.toast("no changes", "default");
        return;
      }
      o.onEdited(after);
    } catch (error) {
      ctx.toast(message(error), "danger");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/** The pty loop. Returns the editor's real exit code. */
export async function runEditor(
  host: RawHost,
  bin: string,
  file: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<number> {
  const terminal = new Bun.Terminal({
    cols: Math.max(1, host.cols),
    rows: Math.max(1, host.rows),
    // pty → client, verbatim and immediately. `session.write` queues against
    // the SSH window on its own; anything we added here would be latency.
    data: (_t, chunk) => host.write(chunk),
  });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined) env[k] = v;
  // `name:` names the pty, it does not populate the child's environment.
  env["TERM"] = host.term ?? "xterm-256color";
  env["COLORTERM"] = env["COLORTERM"] ?? "truecolor";
  env["LANG"] = env["LANG"] ?? "en_US.UTF-8";

  const proc = Bun.spawn([bin, file], { terminal, env, cwd });
  // The far end went away: there is nobody to edit for. SIGHUP is what a
  // closing terminal sends, and every editor treats it as "save-and-leave
  // what you can, then go"; the pty is closed once the process has.
  const hangup = (): void => {
    try {
      proc.kill("SIGHUP");
    } catch {
      /* already gone */
    }
  };
  if (signal?.aborted === true) hangup();
  else signal?.addEventListener("abort", hangup, { once: true });
  host.onData((chunk) => {
    // A write after close throws rather than no-opping, and client bytes
    // routinely arrive in the window between the editor exiting and us
    // noticing — so this guard is load-bearing, not defensive.
    if (!terminal.closed) {
      try {
        terminal.write(chunk);
      } catch {
        /* the editor is gone; the keystroke has nowhere to go */
      }
    }
  });
  host.onResize((cols, rows) => {
    if (!terminal.closed) {
      try {
        terminal.resize(Math.max(1, cols), Math.max(1, rows));
      } catch {
        /* same race, same answer */
      }
    }
  });
  try {
    // `proc.exited`, never the pty's own `exit` callback: that one is a pty
    // lifecycle event whose code is 0-for-EOF / 1-for-error, and it fires
    // after `close()`, i.e. after this has already resolved.
    return await proc.exited;
  } finally {
    signal?.removeEventListener("abort", hangup);
    terminal.close();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
