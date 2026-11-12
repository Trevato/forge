/**
 * A conflicted pull's blocks in the terminal, the page's twin: a cursor over
 * the blocks, `o`/`t`/`b` to take ours, theirs or both, `e` for your own
 * text, and per file "N of M resolved" with the merged file beneath. The choices
 * live in this screen only until `f` finishes them: the caller commits them.
 */

import type { PullConflicts } from "../../actions/conflicts.ts";
import {
  applyChoices,
  resolvedCount,
  type Choice,
} from "../../git/conflicts.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Proposal } from "../../crew/proposal.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { fill, len, split } from "../ui/layout.ts";
import { Scroll, drawLines, hitScroll, plural } from "./common.ts";
import { Composer } from "./thread.ts";

type Line = { text: string; style: ReturnType<typeof style> }[];

const NAMES = { ours: "Ours", theirs: "Theirs", both: "Both", text: "Mine" };

/** Commit one file's choices; the answer is what to tell the person. */
export type Finish = (
  path: string,
  choices: readonly (Choice | undefined)[],
) => Promise<{ ok: boolean; message: string }>;

/** The crew's door: what its latest proposal is, and the ask for another. */
export interface CrewDoor {
  proposal: () => Promise<Proposal>;
  propose: () => Promise<{ ok: boolean; message: string }>;
}

/** A proposal in the words the page uses, one row each. */
function proposalRows(seen: Proposal | undefined): string[] {
  if (seen === undefined || seen.kind === "none") return [];
  if (seen.kind === "working")
    return [`The crew is working on a proposal (${seen.state}). Press r to look again.`];
  if (seen.kind === "failed")
    return [`The last proposal did not land (${seen.state}): ${seen.summary}`];
  return [
    `The crew proposed a resolution, committed as ${seen.oid.slice(0, 7)} on ${seen.branch}.`,
    ...(seen.note === undefined ? [] : seen.note.split("\n")),
    ...(seen.files.length === 0 ? [] : [`Edit by hand: ${seen.files.join(", ")}`]),
  ];
}

export function conflictScreen(
  ctx: Ctx,
  read: PullConflicts,
  finish?: Finish,
  crew?: CrewDoor,
): Screen {
  /** The crew's latest proposal, read when the screen opens and after each ask. */
  let seen: Proposal | undefined;
  const look = (): Promise<void> =>
    crew === undefined
      ? Promise.resolve()
      : crew.proposal().then((p) => {
          seen = p;
        });
  const scroll = new Scroll();
  const composer = new Composer();
  /** choices[file][block] */
  const choices: (Choice | undefined)[][] = read.files.map((f) =>
    f.blocks.map(() => undefined),
  );
  const flat = read.files.flatMap((f, fi) => f.blocks.map((_, bi) => [fi, bi] as const));
  let at = 0;
  /** The line each block's header sits on, for keeping the cursor in view. */
  let heads: number[] = [];

  const rows = (side: string, max = 12): string[] =>
    side.split("\n").slice(0, side.endsWith("\n") ? -1 : undefined).slice(0, max);

  const lines = (): Line[] => {
    const c = ctx.theme.c;
    const plain = style(c.fg, c.bg);
    const muted = style(c.mutedFg, c.bg);
    const out: Line[] = [];
    heads = [];
    const say = (text: string, st = plain): void => {
      out.push([{ text, style: st }]);
    };
    const total = flat.length;
    say(`${plural(total, "conflict block")} in ${plural(read.files.length, "file")}`);
    say(`n/p block · o ours · t theirs · b both · e your own text · f finish (commit to the branch)${crew ? " · c have the crew propose" : ""}`, muted);
    const crewRows = proposalRows(seen);
    if (crewRows.length > 0) {
      say("");
      say("The crew");
      for (const row of crewRows) say(`  ${row}`, muted);
    }
    let n = 0;
    read.files.forEach((file, fi) => {
      const mine = choices[fi]!;
      say("");
      say(
        `${file.path} · ${resolvedCount(mine, file.blocks.length)} of ${file.blocks.length} resolved`,
      );
      if (file.blocks.length === 0)
        say("  no text blocks to choose between", muted);
      file.blocks.forEach((block, bi) => {
        const here = n === at;
        const pick = mine[bi];
        heads[n++] = out.length;
        say(
          `${here ? "▸" : " "} block ${bi + 1} of ${file.blocks.length}${pick ? ` · ${NAMES[pick.kind]}` : ""}`,
          here ? plain : muted,
        );
        for (const [name, side] of [
          [read.ours, block.ours],
          [read.theirs, block.theirs],
        ] as const) {
          say(`    ${name}`, muted);
          for (const row of rows(side)) say(`      ${row}`);
        }
      });
      if (file.blocks.length > 0) {
        say("  Merged file", muted);
        const merged = applyChoices(file.parsed, mine, {
          ours: read.ours,
          theirs: read.theirs,
        });
        for (const row of rows(merged, 200))
          say(`    ${row}`);
      }
    });
    return out;
  };

  const set = (choice: Choice): void => {
    const target = flat[at];
    if (target) choices[target[0]]![target[1]] = choice;
  };
  const move = (by: number): void => {
    if (flat.length === 0) return;
    at = Math.max(0, Math.min(flat.length - 1, at + by));
    const all = lines();
    // Only when the block's header is out of sight: scrolling to a header that
    // already shows would hide the file's "N of M resolved" row above it.
    const head = heads[at] ?? 0;
    if (head < scroll.top || head >= scroll.top + scroll.height) scroll.to(head, all.length);
  };

  return {
    title: "Conflicts",
    keys: [
      binding(["n", "p"], "block"),
      binding(["o", "t", "b"], "ours / theirs / both"),
      binding(["e"], "your text"),
      binding(["f"], "finish"),
      ...(crew ? [binding(["c"], "have the crew propose"), binding(["r"], "look at the crew's proposal")] : []),
      binding(["j", "k"], "scroll"),
      binding(["esc", "q"], "back"),
    ],
    load: look,
    render(area, s) {
      const [body, comp] = split(area, "v", [fill(1), len(composer.height())]);
      const all = lines();
      drawLines(s, body!, ctx.theme.c, scroll, all);
      hitScroll(ctx, body!, scroll, all.length);
      if (composer.height() > 0) composer.render(s, comp!, ctx.theme.c, ctx);
    },
    paste: (text) => composer.paste(text),
    key(e) {
      if (composer.open) {
        const out = composer.key(e);
        if (out === "submit") {
          const text = composer.value.replace(/\r\n?/g, "\n");
          set({ kind: "text", text: text === "" || text.endsWith("\n") ? text : text + "\n" });
          composer.close();
        } else if (out === "cancel") composer.close();
        return true;
      }
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      if (!e.ctrl && !e.alt && e.key === "f" && finish && read.files[0]) {
        const path = read.files[0].path;
        void finish(path, choices[0]!).then((done) => {
          ctx.toast(done.message, done.ok ? "success" : "danger");
          if (done.ok) ctx.pop();
        });
        return true;
      }
      // Looking costs nothing and never asks; `c` is the only key that spends.
      if (!e.ctrl && !e.alt && e.key === "r" && crew) {
        void look().catch(() => ctx.toast("the crew's proposal could not be read", "danger"));
        return true;
      }
      if (!e.ctrl && !e.alt && e.key === "c" && crew) {
        void crew
          .propose()
          .then(async (done) => {
            ctx.toast(done.message, done.ok ? "success" : "danger");
            await look();
          })
          .catch(() => ctx.toast("the crew could not be asked", "danger"));
        return true;
      }
      if (!e.ctrl && !e.alt && flat.length > 0) {
        if (e.key === "n") return move(1), true;
        if (e.key === "p") return move(-1), true;
        if (e.key === "o") return set({ kind: "ours" }), true;
        if (e.key === "t") return set({ kind: "theirs" }), true;
        if (e.key === "b") return set({ kind: "both" }), true;
        if (e.key === "e") {
          const target = flat[at]!;
          const was = choices[target[0]]![target[1]];
          composer.start("Your text", was?.kind === "text" ? was.text : "");
          return true;
        }
      }
      return scroll.key(e, lines().length);
    },
  };
}
