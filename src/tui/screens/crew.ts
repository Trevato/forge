/**
 * A repository's crew, in the terminal (#7443): `C` on the About card. The
 * list is read through `crewAsSeen`, so anyone who can read the repository
 * sees who is on it and what each does — the role stays as Settings › Crew
 * sets it.
 *
 * The repository's admin who is a person — never an agent — is offered `a`,
 * which asks for an agent's name, and `d`, which takes off the agent under
 * the cursor. Each says what changes in a confirm and only the confirm
 * applies it, through `addToCrew` and `removeFromCrew`; a refusal is said in
 * Settings › Crew's words (`crew_words.ts`) and changes nothing.
 */

import { addToCrew, crewAsSeen, removeFromCrew, type CrewMember } from "../../actions/crew.ts";
import { crewAddedWords, crewRefusal, crewRemovedWords } from "../../actions/crew_words.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  confirmScreen,
  drawList,
  later,
  plural,
  promptScreen,
  type ListRow,
} from "./common.ts";

export function crewScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  const where = `${repo.ownerName}/${repo.name}`;
  let crew: readonly CrewMember[] = [];
  let note = "";
  // Settings › Crew's gate: an admin of the repository, and a person.
  const mayChange = (): boolean =>
    f.user !== undefined && f.user.kind !== "agent" && canAdmin(f.db, repo, f.user);
  const reload = (): void => {
    const read = crewAsSeen(f.app, f.user, repo);
    crew = read.ok ? read.value : [];
    state.clamp(crew.length);
    ctx.invalidate();
  };
  reload();
  const say = (text: string): void => {
    note = text;
    reload();
  };

  /** Confirm `body`, and on the chosen action run `apply`, saying what it answered. */
  const confirm = (title: string, verb: string, body: string, apply: () => string): void => {
    void later(ctx, () =>
      confirmScreen(ctx, screen, {
        title,
        body: [body],
        actions: [{ label: "Cancel", variant: "ghost" }, { label: verb }],
        selected: 1,
        onChoose: (i) => {
          if (i === 1) say(apply());
        },
      }),
    );
  };

  const add = (): Screen =>
    promptScreen(ctx, screen, {
      title: "Put an agent on the crew",
      label: "the agent's name",
      placeholder: "mason",
      onSubmit: (name) => {
        const who = name.trim();
        if (who === "") return "Name an agent.";
        confirm(
          "Put on the crew",
          "Put on",
          `${who} joins the crew of ${where}: it may read and write this repository, and works what it is assigned.`,
          () => {
            const added = addToCrew(f.app, f.user, repo, who);
            return added.ok ? crewAddedWords(added.value.user.username) : crewRefusal(added.error);
          },
        );
        return undefined;
      },
    });

  const remove = (who: string): void =>
    confirm(
      "Take off the crew",
      "Take off",
      `${who} leaves the crew of ${where}: it no longer reads or writes this repository unless it could anyway.`,
      () => {
        const removed = removeFromCrew(f.app, f.user, repo, who);
        return removed.ok ? crewRemovedWords(who) : crewRefusal(removed.error);
      },
    );

  const screen: Screen = {
    title: "Crew",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        ...(mayChange()
          ? [binding(["a"], "put an agent on"), binding(["d"], "take it off", { disabled: crew.length === 0 })]
          : []),
        binding(["esc"], "back"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const text =
        note !== ""
          ? note
          : crew.length === 0
            ? `Nobody is on the crew of ${where}.${mayChange() ? " Press a to put an agent on." : ""}`
            : `${plural(crew.length, "agent")} on the crew of ${where}; Settings › Crew sets their roles.`;
      const said = wrap(text, Math.max(1, area.w)).slice(0, 3);
      const [head, list] = split(area, "v", [len(said.length), fill(1)]);
      said.forEach((line, i) =>
        s.text(head!.x, head!.y + i, line, style(c.mutedFg, c.bg), head!.x + head!.w),
      );
      const rows: ListRow[] = crew.map((m) => ({
        title: m.username,
        meta: m.role,
        ...(m.displayName !== m.username ? { secondary: m.displayName } : {}),
      }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      if (state.key(e, crew.length)) return true;
      if (e.ctrl || e.alt || !mayChange()) return false;
      if (e.key === "a") {
        ctx.push(add());
        return true;
      }
      const who = crew[state.index]?.username;
      if (e.key === "d" && who !== undefined) {
        remove(who);
        return true;
      }
      return false;
    },
  };
  return screen;
}
