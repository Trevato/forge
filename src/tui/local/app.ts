/**
 * Booting the local UI on the forge's own terminal runtime.
 *
 * The same `App`, the same widgets, the same themes and key conventions as
 * the screens that talk to a workbench — the only difference is what is
 * underneath: a work tree instead of a database. That reuse is the whole
 * reason this is worth building as part of the forge rather than beside it.
 *
 * The terminal is passed in, never reached for, so the harness drives these
 * screens exactly as it drives the server's.
 */

import { ForgeApi } from "../../cli/api.ts";
import type { Config } from "../../cli/config.ts";
import { App, type Ctx, type Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import { stdioTerminal, type Terminal } from "../term/terminal.ts";
import type { ThemeName } from "../ui/theme.ts";
import type { Local } from "./common.ts";
import { reposScreen } from "./repos.ts";

export interface LocalOpts {
  readonly root: string;
  readonly config?: Config;
  readonly terminal?: Terminal;
  readonly theme?: ThemeName;
  readonly exitHooks?: boolean;
}

export interface LocalApp {
  readonly app: App;
  readonly local: Local;
}

export function createLocalApp(opts: LocalOpts): LocalApp {
  const terminal = opts.terminal ?? stdioTerminal();
  const api =
    opts.config === undefined
      ? null
      : new ForgeApi(opts.config.url, opts.config.token);

  const local: Local = {
    root: opts.root,
    api,
    copy: (text) => copyToClipboard(terminal, text),
  };

  const app = new App({
    terminal,
    root: (ctx: Ctx): Screen => reposScreen(local, ctx),
    commands: (ctx: Ctx): Command[] => commands(local, ctx),
    ...(opts.theme === undefined ? {} : { theme: opts.theme }),
    ...(opts.exitHooks === undefined ? {} : { exitHooks: opts.exitHooks }),
  });
  return { app, local };
}

/**
 * The stdio entry point `forge` with no arguments lands on.
 *
 * Quitting is observed through the transport rather than by reading the
 * app's private state: `App.stop()` releases the terminal, so wrapping
 * `close()` is a public, exact signal that the session is over — and it
 * leaves the CLI's exit code ours to choose.
 */
export async function runLocalTui(opts: LocalOpts): Promise<void> {
  const terminal = opts.terminal ?? stdioTerminal();
  let finished = (): void => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const watched: Terminal = {
    ...terminal,
    write: (bytes) => terminal.write(bytes),
    close: () => {
      terminal.close();
      finished();
    },
  };
  const { app } = createLocalApp({
    ...opts,
    terminal: watched,
    exitHooks: true,
  });
  app.start();
  await done;
}

function commands(local: Local, ctx: Ctx): Command[] {
  return [
    {
      id: "repos",
      title: "Your repositories",
      run: () => ctx.replace(reposScreen(local, ctx)),
    },
  ];
}

/**
 * OSC 52. The terminal itself puts the text on the system clipboard, which is
 * the only mechanism that works over SSH and in tmux alike — and the reason
 * the local screens take a `copy` from the session rather than reaching for
 * a clipboard binary that would not exist on the far side of a connection.
 */
function copyToClipboard(terminal: Terminal, text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  terminal.write(new TextEncoder().encode(`\x1b]52;c;${encoded}\x07`));
}
