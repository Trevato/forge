/**
 * "Who can do what" in the terminal, as /audit and MCP `audit` have it: one
 * row per app the viewer can read, read from its `contract.json` at the
 * default branch through the same `audit()`. Under the list, the selected
 * app's doors — resource.verb, then yes, own or no for each identity — and
 * whether outsiders may direct its crew. An app without a contract is listed
 * as "unread", never hidden. Enter opens the app's repository.
 */

import { appsForRepos } from "../../core/apps.ts";
import { listReposVisibleTo } from "../../core/repos.ts";
import { audit, type Audited } from "../../contract/audit.ts";
import { VERBS } from "../../contract/can.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, drawFacts, drawList, hitList, metaOf, plural, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";

/** As many as the page reads. */
const AUDIT_LIMIT = 200;

/** The apps the viewer can read, each read from its contract — the page's set. */
export async function auditedFor(f: Session): Promise<Audited[]> {
  const repos = listReposVisibleTo(f.db, f.user, { limit: AUDIT_LIMIT });
  const records = appsForRepos(f.db, repos.map((r) => r.id));
  return Promise.all(repos.filter((r) => records.has(r.id)).map((repo) => audit(f.app.reposRoot, repo)));
}

const crewWords = (a: Audited): string =>
  a.repo.crewOutsiders ? "outsiders may direct its crew" : "only members direct its crew";

/** One line per app: its name, its standing in a word or two, and who directs its crew. */
export function auditRows(audited: readonly Audited[]): ListRow[] {
  return audited.map((a) => {
    const st = a.standing;
    const standing =
      st.kind === "unread"
        ? "unread"
        : st.kind === "unsound"
          ? `unsound: ${plural(st.problems.length, "problem")}`
          : st.open.length === 0
            ? "closed to strangers"
            : `${plural(st.open.length, "door")} open to anyone`;
    return {
      title: `${a.repo.ownerName}/${a.repo.name}`,
      tone: st.kind === "sound" ? (st.open.length === 0 ? "success" : "attn") : st.kind === "unsound" ? "danger" : "secondary",
      meta: metaOf(standing, crewWords(a)),
    };
  });
}

/** The selected app's doors: [resource.verb, "anon no · member own · owner yes"], or why there are none. */
export function doorLines(a: Audited): [string, string][] {
  const st = a.standing;
  const crew: [string, string] = ["crew", crewWords(a)];
  if (st.kind === "unread") return [["unread", "no contract.json: its doors are written by hand"], crew];
  if (st.kind === "unsound") return [...st.problems.map((p): [string, string] => ["unsound", p]), crew];
  const lines: [string, string][] = [];
  for (const resource of Object.keys(st.contract.resources))
    for (const verb of VERBS)
      lines.push([
        `${resource}.${verb}`,
        st.identities
          .map((as) => `${as} ${st.cells.find((c) => c.resource === resource && c.verb === verb && c.as === as)?.answer ?? "no"}`)
          .join(" · "),
      ]);
  return [crew, ...lines];
}

export function auditScreen(f: Session, ctx: Ctx, audited: readonly Audited[]): Screen {
  const state = new ListState();
  const rows = auditRows(audited);
  const open = (index: number) => {
    const a = audited[index];
    if (a !== undefined) ctx.push(repoScreen(f, ctx, local(f, a.repo)));
  };
  return {
    title: "Who can do what",
    keys: [binding(["enter"], "open repository"), binding(["esc", "q"], "close")],
    render(area, s) {
      const c = ctx.theme.c;
      if (audited.length === 0) {
        emptyState(s, area, c, { title: "No apps to read", body: "No app you can read runs on this forge." });
        return;
      }
      const listH = Math.max(1, Math.min(rows.length, area.h >> 1));
      const list = { x: area.x, y: area.y, w: area.w, h: listH };
      drawList(s, list, c, state, rows);
      hitList(ctx, list, state, audited.length, { open });
      const selected = audited[state.index];
      if (selected === undefined) return;
      drawFacts(s, { x: area.x + 1, y: area.y + listH + 1, w: Math.max(0, area.w - 1), h: Math.max(0, area.h - listH - 1) }, c, doorLines(selected));
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "enter") open(state.index);
      else state.key(e, audited.length);
      return true;
    },
  };
}

/** The audit, as /audit lists it: anyone, a stranger seeing the public apps. */
export const entry: PaletteEntry = {
  id: "audit",
  title: "Who can do what",
  hint: "each app's doors from its contract.json: yes, own or no",
  offered: () => true,
  run: (session, ctx) =>
    runAsync(ctx, async () => {
      ctx.push(auditScreen(session, ctx, await auditedFor(session)));
    }),
};
