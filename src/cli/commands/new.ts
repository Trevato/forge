import { ForgeApi, type ApiError } from "../api.ts";
import type { Args } from "../args.ts";
import { rootDir } from "../config.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { inert, type Out } from "../out.ts";
import { cloneOne } from "../sync.ts";
import { G } from "../../tui/term/screen.ts";
import type { Command } from "./types.ts";

/** A path part from the forge's answer that cannot climb out of the root. */
const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `forge new notes "a notes app"`: make the app as POST /api/v1/apps does,
 * then clone it where `forge sync` would. The clone address is the answer's,
 * never built from the typed name; a refusal prints the forge's own words
 * and clones nothing.
 */
async function newApp(out: Out, args: Args): Promise<number> {
  const [name, ...words] = args.positional;
  if (name === undefined || name.trim() === "") {
    out.err("forge new: what is it called? e.g. forge new notes \"a notes app\"");
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const api = new ForgeApi(loaded.url, loaded.token);
  const description = words.join(" ").trim();
  const owner = args.value("owner");
  const made = await api.newApp({
    name,
    ...(description === "" ? {} : { description }),
    visibility: args.flag("private") ? "private" : "public",
    ...(owner === undefined ? {} : { owner }),
  });
  if (!made.ok) return refusal(out, made.error);

  const { pin, pageUrl, liveUrl } = made.value;
  // Before any of the answer's text reaches the terminal or the disk.
  if (!SAFE_PART.test(pin.owner) || !SAFE_PART.test(pin.name)) {
    out.err("forge new: the forge named a repository this client will not clone");
    return EXIT.failed;
  }
  out.line(
    `${out.paint(G.check, out.c.success)} made ${pin.owner}/${pin.name}`,
  );
  out.line(pageUrl);
  if (liveUrl !== null) out.line(inert(liveUrl));
  const report = await cloneOne(pin, {
    api,
    token: loaded.token,
    root: rootDir(args.value("root")),
  });
  if (report.error !== null || !report.present) {
    out.err(`forge new: made, but not cloned: ${inert(report.error ?? "")}`);
    out.err("  run `forge sync` to try again");
    return EXIT.failed;
  }
  out.line(out.paint(`  cloned to ${report.dir}`, out.c.faint));
  return EXIT.ok;
}

function refusal(out: Out, error: ApiError): number {
  out.err(`forge new: ${inert(error.message)}`);
  if (error.status === 401) return EXIT.notConfigured;
  if (error.status === 403 || error.status === 409 || error.status === 422)
    return EXIT.refused;
  return EXIT.failed;
}

export const command: Command = {
  name: "new",
  usage: {
    synopsis: "forge new <name> [words…]",
    flags: "[--private] [--owner org] [--root DIR]",
  },
  run: (out, args) => newApp(out, args),
};
