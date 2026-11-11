/**
 * An app's variants in the terminal: the board the page draws, from a
 * repository's `:` palette. Anyone who can read the repository sees each
 * variant — branch, state, values, what it last made. A person who can
 * write also registers a branch (`r`), sets one value (`s`) or drops one
 * (`u`), retires a variant after a confirm (`x`) and asks for it to become
 * main (`m`), through the same actions as the page, refused in its words.
 */

import {
  makeMain,
  registerVariant,
  retireVariant,
  setVariantValues,
  variantBoard,
  variantRefusalText,
  type VariantCard,
} from "../../actions/app_variants.ts";
import { checkValue } from "../../apps/variant_file.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { VARIANTS_MAX } from "../../core/variants.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, runAsync, type ListRow } from "./common.ts";

/** The palette's "Variants", for anyone who can read a repository that is an app. */
export function variantsCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || getAppByRepo(f.app.db, repo.id) === undefined) return [];
  return [
    {
      id: "app-variants",
      title: `${repo.ownerName}/${repo.name} — Variants`,
      hint: "branches kept running, with values of their own",
      run: () => ctx.push(variantsScreen(f, ctx, repo)),
    },
  ];
}

const valuesLine = (values: Readonly<Record<string, string>>): string =>
  Object.keys(values).length === 0 ? "the app's defaults" : Object.entries(values).map(([n, v]) => `${n}=${v}`).join("  ");

const asLines = (values: Readonly<Record<string, string>>): string =>
  Object.entries(values).map(([n, v]) => `${n}=${v}`).join("\n");

export function variantsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let cards: VariantCard[] = [];
  let note = "";
  let live = 0;
  const writer = (): boolean => f.user !== undefined && f.user.kind !== "agent" && canWrite(f.app.db, repo, f.user);

  const reload = async (): Promise<void> => {
    const board = await variantBoard(f.app, repo);
    cards = board?.cards ?? [];
    live = board?.live ?? 0;
    state.clamp(cards.length);
    ctx.invalidate();
  };
  const say = async (text: string): Promise<void> => {
    note = text;
    await reload();
  };
  runAsync(ctx, reload);

  const refusal = (error: unknown): string =>
    typeof error === "string"
      ? variantRefusalText(error)
      : variantRefusalText("bad_values", (error as { message?: string }).message);

  const register = (): Screen =>
    promptScreen(ctx, screen, {
      title: "Run a branch as a variant",
      label: "branch",
      onSubmit: (branch) => {
        if (branch === "") return "A variant needs a branch.";
        return later(ctx, () =>
          promptScreen(ctx, screen, {
            title: branch,
            label: "label (empty: from the branch name)",
            onSubmit: async (label) => {
              const made = await registerVariant(f.app, f.user, repo, { branch, ...(label === "" ? {} : { label }) });
              await say(made.ok ? `Running ${made.value.branch} as the ${made.value.label} variant.` : refusal(made.error));
            },
          }),
        );
      },
    });

  const save = async (card: VariantCard, values: Record<string, string>, said: string): Promise<void> => {
    const saved = await setVariantValues(f.app, f.user, repo, card.label, asLines(values));
    await say(saved.ok ? said : refusal(saved.error));
  };

  const setOne = (card: VariantCard): Screen =>
    promptScreen(ctx, screen, {
      title: `A value for ${card.label}`,
      label: "NAME=value",
      onSubmit: (line) => {
        const at = line.indexOf("=");
        if (at < 1) return "Type NAME=value.";
        const name = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        const bad = checkValue(name, value);
        if (bad !== undefined) return bad;
        return save(card, { ...card.values, [name]: value }, `${name} is set for ${card.label}.`);
      },
    });

  const dropOne = (card: VariantCard): Screen =>
    promptScreen(ctx, screen, {
      title: `Drop a value of ${card.label}`,
      label: "NAME",
      onSubmit: (name) => {
        if (!(name in card.values)) return `${card.label} has no value ${name.slice(0, 40)}.`;
        const { [name]: _gone, ...rest } = card.values;
        return save(card, rest, `${name} is dropped from ${card.label}.`);
      },
    });

  const retire = (card: VariantCard): Screen =>
    confirmScreen(ctx, screen, {
      title: "Retire this variant",
      body: [`${card.label} on ${card.branch}`, "Its environment and data are removed; the branch is kept."],
      actions: [{ label: "Keep", variant: "ghost" }, { label: "Retire", variant: "danger" }],
      onChoose: (i) => {
        if (i !== 1) return;
        runAsync(ctx, async () => {
          const gone = await retireVariant(f.app, f.user, repo, card.label);
          await say(gone.ok ? `${card.label} is retired. The branch is kept.` : refusal(gone.error));
        });
      },
    });

  const rows = (): ListRow[] =>
    cards.map((c) => ({
      title: c.label,
      ...(c.state === "running" ? { tone: "success" as const } : c.state === "failed" ? { tone: "danger" as const } : {}),
      secondary: c.branch,
      meta: c.state,
      below: [valuesLine(c.values), c.output === undefined ? "nothing made yet" : `last made: ${c.output.title}`],
    }));

  const screen: Screen = {
    title: "Variants",
    get keys() {
      return [
        ...(writer()
          ? [binding(["r"], "run a branch"), binding(["s"], "set a value"), binding(["u"], "drop one"), binding(["x"], "retire"), binding(["m"], "make main")]
          : []),
        binding(["j", "k"], "move cursor"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const text =
        note !== ""
          ? note
          : cards.length === 0
            ? writer() ? "No variants yet. Press r to run a branch as one." : "No variants yet."
            : `${cards.length} of ${VARIANTS_MAX}; ${live} previews running.`;
      const said = wrap(text, Math.max(1, area.w)).slice(0, 3);
      const [head, list] = split(area, "v", [len(said.length), fill(1)]);
      said.forEach((line, i) => s.text(head!.x, head!.y + i, line, style(c.mutedFg, c.bg), head!.x + head!.w));
      drawList(s, list!, c, state, rows());
    },
    key(e) {
      if (state.key(e, cards.length)) return true;
      if (e.ctrl || e.alt || !writer()) return false;
      if (e.key === "r") {
        ctx.push(register());
        return true;
      }
      const card = cards[state.index];
      if (card === undefined) return false;
      if (e.key === "s") ctx.push(setOne(card));
      else if (e.key === "u") ctx.push(dropOne(card));
      else if (e.key === "x") ctx.push(retire(card));
      else if (e.key === "m") {
        runAsync(ctx, async () => {
          const pull = await makeMain(f.app, f.user, repo, card.label);
          await say(pull.ok ? `Pull #${pull.value.number} makes ${card.label} main; merge it to land it.` : refusal(pull.error));
        });
      } else return false;
      return true;
    },
  };
  return screen;
}
