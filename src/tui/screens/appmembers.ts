/**
 * The people a private app names, in the terminal (#7418): `m` on the
 * deploys screen. The list is read through `readAppMembers`, the settings
 * page's and MCP `app_members`'s action, so it is gated the same way: a
 * person who can write the repository, never an agent — and the deploys
 * screen offers `m` to that person alone.
 *
 * `a` asks for a username and `d` takes out the person under the cursor.
 * Each is planned first (`setAppMembersThrough` with `dryRun`), the plan —
 * who is let in, who is let out — is shown in a confirm, and only the
 * confirm applies it — to the list as it stands then, so a change another
 * writer made meanwhile is kept. An unknown username is refused in the action's words
 * and the prompt stays open.
 */

import {
  readAppMembers,
  setAppMembersThrough,
  type AppMembersError,
} from "../../actions/app_members.ts";
import { SETTING_WORDS } from "../../actions/setting_words.ts";
import type { Repo } from "../../core/repos.ts";
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
  promptScreen,
  type ListRow,
} from "./common.ts";

/** A refusal in MCP `app_members`'s words. */
export function appMembersRefusal(e: AppMembersError): string {
  return e.kind === "invalid"
    ? e.message
    : e.kind === "forbidden" || e.kind === "unauthorized"
      ? SETTING_WORDS.appMembersForbidden
      : "no such app or repository (owner/name)";
}

/** `Let in: carol` / `Let out: dave`, one line each side that moves. */
export function planLines(plan: { added: readonly string[]; removed: readonly string[] }): string[] {
  return [
    ...(plan.added.length > 0 ? [`Let in: ${plan.added.join(", ")}`] : []),
    ...(plan.removed.length > 0 ? [`Let out: ${plan.removed.join(", ")}`] : []),
  ];
}

export function appMembersScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let members: readonly string[] = [];
  // Whether the action reads for this viewer; it decides, not the screen.
  let canChange = false;
  let refusal = "";
  let note = "";
  const reload = (): void => {
    const read = readAppMembers(f.app, f.user, repo);
    canChange = read.ok;
    members = read.ok ? read.value.members : [];
    refusal = read.ok ? "" : appMembersRefusal(read.error);
    state.clamp(members.length);
    ctx.invalidate();
  };
  reload();
  const say = (text: string): void => {
    note = text;
    reload();
  };

  /**
   * The list as it stands now with one person's change made — never the
   * screen's snapshot, so a change another writer made meanwhile (the page,
   * the API, MCP) is kept; `undefined` when it cannot be read.
   */
  const current = (): readonly string[] | undefined => {
    const read = readAppMembers(f.app, f.user, repo);
    return read.ok ? read.value.members : undefined;
  };
  type Change = (now: readonly string[]) => readonly string[];
  const letIn = (who: string): Change => (now) => [...now, who];
  const letOut = (who: string): Change => (now) => now.filter((m) => m !== who);

  /** Plan `change`, or the refusal; on a plan, confirm and apply it to the list as it is then. */
  const propose = (title: string, verb: string, change: Change): string | undefined => {
    const plan = setAppMembersThrough(f.app, f.user, repo, { members: change(current() ?? members), dryRun: true });
    if (!plan.ok) return appMembersRefusal(plan.error);
    const lines = planLines(plan.value);
    if (lines.length === 0) {
      say("Nobody is let in or out: the list already says so.");
      return undefined;
    }
    void later(ctx, () =>
      confirmScreen(ctx, screen, {
        title,
        body: [...lines, `${repo.ownerName}/${repo.name} and its previews.`],
        actions: [{ label: "Cancel", variant: "ghost" }, { label: verb }],
        selected: 1,
        onChoose: (i) => {
          if (i !== 1) return;
          // Read again: the confirm may have stood open while the list moved.
          const now = readAppMembers(f.app, f.user, repo);
          if (!now.ok) return say(appMembersRefusal(now.error));
          const set = setAppMembersThrough(f.app, f.user, repo, { members: change(now.value.members), dryRun: false });
          say(set.ok ? `${planLines(set.value).join(" · ") || "Nobody moved"}.` : appMembersRefusal(set.error));
        },
      }),
    );
    return undefined;
  };

  const add = (): Screen =>
    promptScreen(ctx, screen, {
      title: "Let someone in",
      label: "their username",
      placeholder: "carol",
      onSubmit: (name) => {
        const who = name.trim();
        if (who === "") return "Name a person.";
        return propose("Let in", "Let in", letIn(who));
      },
    });

  const remove = (who: string): void => {
    const refused = propose("Let out", "Let out", letOut(who));
    if (refused !== undefined) say(refused);
  };

  const screen: Screen = {
    title: "Members",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        ...(canChange ? [binding(["a"], "let someone in"), binding(["d"], "let them out")] : []),
        binding(["esc"], "back"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const text =
        note !== ""
          ? note
          : refusal !== ""
            ? refusal
            : members.length === 0
              ? `${repo.ownerName}/${repo.name} names nobody; its writers and crew enter. Press a to let someone in.`
              : `${repo.ownerName}/${repo.name} names ${members.length}: they enter the app and its previews, nothing else.`;
      const said = wrap(text, Math.max(1, area.w)).slice(0, 3);
      const [head, list] = split(area, "v", [len(said.length), fill(1)]);
      said.forEach((line, i) =>
        s.text(head!.x, head!.y + i, line, style(c.mutedFg, c.bg), head!.x + head!.w),
      );
      const rows: ListRow[] = members.map((m) => ({ title: m }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      if (state.key(e, members.length)) return true;
      if (e.ctrl || e.alt || !canChange) return false;
      if (e.key === "a") {
        ctx.push(add());
        return true;
      }
      const who = members[state.index];
      if (e.key === "d" && who !== undefined) {
        remove(who);
        return true;
      }
      return false;
    },
  };
  return screen;
}
