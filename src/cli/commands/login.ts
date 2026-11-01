import { ForgeApi } from "../api.ts";
import type { Args } from "../args.ts";
import {
  configPath,
  normalizeUrl,
  PLAIN_HTTP_REFUSAL,
  plainHttpRemote,
  saveConfig,
} from "../config.ts";
import { EXIT } from "../exit.ts";
import type { Out } from "../out.ts";
import { G } from "../../tui/term/screen.ts";
import type { Command } from "./types.ts";

async function login(out: Out, args: Args): Promise<number> {
  const raw = args.positional[0] ?? args.value("url");
  if (raw === undefined) {
    out.err("forge login: which forge? e.g. forge login forge.example.com");
    return EXIT.usage;
  }
  const url = normalizeUrl(raw);
  // Before the token is asked for, let alone sent: nothing crosses the
  // network in clear unless the person said this host is one they trust.
  const insecure = args.flag("insecure");
  if (plainHttpRemote(url) && !insecure) {
    out.err(`forge login: ${PLAIN_HTTP_REFUSAL}`);
    return EXIT.usage;
  }
  const token = args.value("token") ?? (await askSecret(`Token for ${url}: `));
  if (token === "") {
    out.err("forge login: no token given");
    return EXIT.usage;
  }

  // Verify before storing: a config that does not work is worse than none.
  const api = new ForgeApi(url, token);
  const me = await api.whoami();
  if (!me.ok) {
    out.err(`forge login: ${me.error.message}`);
    return me.error.status === 401 ? EXIT.notConfigured : EXIT.failed;
  }
  const stored = await saveConfig({ url, token }, { insecure });
  out.line(
    `${out.paint(G.check, out.c.success)} signed in to ${url} as ${me.value.username}`,
  );
  out.line(
    out.paint(
      stored.keychain
        ? `  token in your login keychain; ${configPath()} holds only the URL`
        : `  token in ${configPath()} (0600)`,
      out.c.faint,
    ),
  );
  return EXIT.ok;
}

/**
 * A secret, read without echo. Raw mode is the only way to stop the terminal
 * printing it, and it is restored on every path — including ctrl+c, which
 * here means "no token", not "leave the tty broken".
 */
async function askSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true) {
    // Piped input: read one line. `echo $TOKEN | forge login url` is a
    // legitimate way to do this from a script.
    const text = await new Response(Bun.stdin.stream()).text();
    return text.split("\n")[0]?.trim() ?? "";
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve) => {
    let value = "";
    const finish = (result: string): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) return finish(""); // ctrl+c
        if (byte === 13 || byte === 10) return finish(value.trim());
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 0x20) value += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

export const command: Command = {
  name: "login",
  usage: { synopsis: "forge login <url>", flags: "[--token T] [--insecure]" },
  run: login,
};
