import { WORDS_MAX } from "../../core/fence.ts";
import { thinkingOf } from "../../core/talk_work.ts";
import { ForgeApi } from "../api.ts";
import type { Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { inert, type Out } from "../out.ts";
import type { Command } from "./types.ts";

/** Seconds `forge talk` waits for the answer before it says where to read it. */
const WAIT_S = 120;

/** A thought on one line: its first words, ended with an ellipsis when cut. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};

/**
 * `forge talk "words"`: say something to the forge's own agent, as you, and
 * print what it answers. The agent works through the forge's MCP with your
 * permissions; a write it would make is held for your yes.
 */
async function talk(out: Out, args: Args): Promise<number> {
  const text = args.positional.join(" ").trim();
  if (text === "") {
    out.err('forge talk: say something — forge talk "words"');
    return EXIT.usage;
  }
  if (text.length > WORDS_MAX) {
    out.err(`forge talk: the words are 1 to ${WORDS_MAX} characters`);
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const api = new ForgeApi(loaded.url, loaded.token);
  const before = await api.conversation();
  const seen = new Set(before.ok ? before.value.turns.map((t) => t.id) : []);
  const said = await api.talk(text);
  if (!said.ok) {
    out.err(`forge talk: ${inert(said.error.message)}`);
    return said.error.status === 401 ? EXIT.notConfigured : EXIT.failed;
  }
  for (let waited = 0; waited < WAIT_S; waited++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const now = await api.conversation();
    if (!now.ok) continue;
    for (const turn of now.value.turns)
      if (!seen.has(turn.id)) {
        seen.add(turn.id);
        // A thought is one folded line; the steps and links follow the reply, as on the page.
        const thought = thinkingOf(turn);
        if (thought !== undefined) out.line(inert(`thinking: ${oneLine(thought)}`));
        if (turn.role !== "agent") continue;
        out.line(inert(turn.text));
        if (turn.work) {
          out.line(inert(turn.work.steps));
          for (const link of turn.work.links) out.line(inert(link.href));
        }
      }
    if (!now.value.running) return EXIT.ok;
  }
  out.line("the agent is still answering; read it on the feed");
  return EXIT.ok;
}

export const command: Command = {
  name: "talk",
  usage: { synopsis: "forge talk <words…>", flags: "[--]" },
  run: talk,
};
