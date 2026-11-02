import { parseFrom, TELL_TEXT_MAX } from "../../actions/tell_from.ts";
import { ForgeApi } from "../api.ts";
import type { Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { resolveRepo } from "../here.ts";
import { inert, type Out } from "../out.ts";
import type { Command } from "./types.ts";

/**
 * `forge tell "words"`: tell the crew something about a repository; it
 * becomes an issue. Every rule here is the server's, checked early.
 */
async function tell(out: Out, args: Args): Promise<number> {
  const text = args.positional.join(" ").trim();
  if (text === "") {
    out.err(
      "forge tell: say something — " +
        'forge tell "words" [--repo owner/name] [--variants 1-4] [--from /path]',
    );
    return EXIT.usage;
  }
  if (text.length > TELL_TEXT_MAX) {
    out.err(`forge tell: the words are 1 to ${TELL_TEXT_MAX} characters`);
    return EXIT.usage;
  }
  const only = args.value("repo");
  const rawVariants = args.value("variants");
  const variants = rawVariants === undefined ? undefined : Number(rawVariants);
  if (
    variants !== undefined &&
    !(Number.isInteger(variants) && variants >= 1 && variants <= 4)
  ) {
    out.err("forge tell: --variants is a whole number from 1 to 4");
    return EXIT.usage;
  }
  const from = args.value("from");
  if (from !== undefined && parseFrom(from) === undefined) {
    out.err(
      "forge tell: --from is a path on the workbench, like /alice/notes/pulls/3",
    );
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const ref = await resolveRepo(only, loaded.url);
  if (typeof ref === "string") {
    out.err(`forge tell: ${ref}`);
    return EXIT.usage;
  }
  const told = await new ForgeApi(loaded.url, loaded.token).tell(
    ref.owner,
    ref.name,
    text,
    { variants, from },
  );
  if (!told.ok) {
    out.err(`forge tell: ${inert(told.error.message)}`);
    return told.error.status === 401 ? EXIT.notConfigured : EXIT.failed;
  }
  out.line(
    `told ${ref.owner}/${ref.name}: issue #${told.value.issue}  ${told.value.url}`,
  );
  return EXIT.ok;
}

export const command: Command = {
  name: "tell",
  usage: {
    synopsis: "forge tell <words…>",
    flags: "[--repo owner/name] [--variants 1-4] [--from /path] [--]",
  },
  run: tell,
};
