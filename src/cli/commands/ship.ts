import { ForgeApi, type ApiError } from "../api.ts";
import type { Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { resolveRepo } from "../here.ts";
import type { Io } from "../io.ts";
import { inert, type Out } from "../out.ts";
import { G } from "../../tui/term/screen.ts";
import type { Command } from "./types.ts";

/**
 * `forge ship 12`: read the pull, show it, ask, merge. The merge route's
 * rules stay the server's — this adds none and retries nothing; a refusal
 * prints the forge's own words.
 */
async function ship(out: Out, args: Args, io: Io): Promise<number> {
  const raw = args.positional[0];
  const number = raw === undefined ? NaN : Number(raw.replace(/^#/, ""));
  if (!Number.isSafeInteger(number) || number < 1) {
    out.err("forge ship: which pull? e.g. forge ship 12");
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const ref = await resolveRepo(args.value("repo"), loaded.url);
  if (typeof ref === "string") {
    out.err(`forge ship: ${ref}`);
    return EXIT.usage;
  }
  const api = new ForgeApi(loaded.url, loaded.token);
  const pull = await api.pull(ref.owner, ref.name, number);
  if (!pull.ok) return shipError(out, pull.error);
  const check = await api.pullCheck(ref.owner, ref.name, number);
  const p = pull.value;
  out.line(`${ref.owner}/${ref.name}#${p.number}  ${inert(p.title)}`);
  const facts = [
    `check ${check.ok ? inert(check.value) : "unknown"}`,
    p.merged
      ? "already merged"
      : p.state !== "open"
        ? p.state
        : p.mergeable === false
          ? "not mergeable"
          : p.mergeable === true
            ? "mergeable"
            : "mergeable unknown",
    ...(p.held ? ["held"] : []),
  ];
  out.line(out.paint(`  ${facts.join(" · ")}`, out.c.faint));

  if (!args.flag("yes")) {
    const answer = await io.ask(`Ship #${p.number}? [y/N] `);
    if (answer === null) {
      out.err("forge ship: not a terminal — pass --yes to ship without asking");
      return EXIT.usage;
    }
    if (answer.trim().toLowerCase() !== "y") {
      out.line("not shipped");
      return EXIT.ok;
    }
  }

  const merged = await api.merge(ref.owner, ref.name, number);
  if (!merged.ok) return shipError(out, merged.error);
  out.line(
    `${out.paint(G.check, out.c.success)} shipped #${p.number} as ${merged.value.mergeOid.slice(0, 7)}`,
  );
  out.line(api.pullUrl(ref.owner, ref.name, number));
  return EXIT.ok;
}

function shipError(out: Out, error: ApiError): number {
  out.err(`forge ship: ${inert(error.message)}`);
  if (error.status === 401) return EXIT.notConfigured;
  if (error.status === 403 || error.status === 409 || error.status === 422)
    return EXIT.refused;
  return EXIT.failed;
}

export const command: Command = {
  name: "ship",
  usage: { synopsis: "forge ship <number>", flags: "[--repo owner/name] [--yes]" },
  run: (out, args, _help, io) => ship(out, args, io),
};
