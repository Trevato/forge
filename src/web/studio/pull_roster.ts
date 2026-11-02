/**
 * What a pull lets this reader do, as palette rows, on both of its tabs: one list, plain
 * data in, plain rows out. A row with `p` is a mutation — the palette posts
 * it as the page's own form does (same action, same fields), never a GET;
 * a row without it is a link to where the page does the thing.
 *
 * Each rule below is the rule the page draws its control by. A reader who
 * may not do an action is never handed its row.
 */
import type { PaletteItem } from "../layout.ts";

export interface PullRosterInput {
  /** `/owner/name`. */
  readonly base: string;
  readonly number: number;
  readonly headBranch: string;
  readonly crossRepo: boolean;
  readonly signedIn: boolean;
  /** May write to the repository. */
  readonly writer: boolean;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  /** May close or reopen it: its author or a writer, as `setIssueState` allows. */
  readonly mayState: boolean;
  /** The repository has labels to apply: the page draws its form only then. */
  readonly labels: boolean;
  /** The merge box would offer an enabled Merge (git, review and checks agree). */
  readonly mergeReady: boolean;
  /** The Conversation tab folds its actions away, so its rows are links to them. */
  readonly change?: {
    readonly shippable: boolean;
    /** Shipping would only be refused: the verb is the one that fixes it. */
    readonly conflicted: boolean;
    readonly mayEdit: boolean;
    readonly takeBack: boolean;
  };
}

const GROUP = "This pull";

export function pullRoster(i: PullRosterInput): PaletteItem[] {
  const thread = `${i.base}/pulls/${i.number}`;
  const row = (t: string, h: string, p?: Record<string, string>): PaletteItem => ({
    t,
    h,
    c: GROUP,
    ...(p ? { p } : {}),
  });
  const open = i.state === "open" && !i.merged;
  const out: PaletteItem[] = [
    row("Conversation", thread),
    row("Files", `${thread}/files`),
  ];
  if (!i.crossRepo) {
    const ref = encodeURIComponent(i.headBranch);
    out.push(row("Branch", `${i.base}/tree/${ref}`), row("Commits", `${i.base}/commits?ref=${ref}`));
  }
  const c = i.change;
  if (c?.shippable) out.push(row(c.conflicted ? "Bring up to date" : "Ship", `${thread}#decide`));
  if (i.signedIn && !i.merged) out.push(row("Comment", `${thread}#comment-body`));
  if (!c && open && i.signedIn) out.push(row("Review", `${thread}/files#review-body`));
  if (open && i.writer) {
    if (c) {
      out.push(row("Check again", `${thread}#live-checks`), row("Hold", `${thread}?more=1#hold`));
    } else {
      out.push(row("Check again", `${thread}/checks`, {}));
    }
  }
  // The Files tab's assignee and labels cards are a writer's whatever the pull's state.
  if (!c && i.writer) {
    out.push(row("Assign", `${thread}/files#assignee-now`));
    if (i.labels) out.push(row("Labels", `${thread}/files#labels-now`));
  }
  if (c && open && i.mayState) out.push(row("Close pull request", `${thread}#comment-body`));
  // A closed, unmerged pull: the page's Reopen form posts just this.
  if (i.state === "closed" && !i.merged && i.signedIn && i.mayState)
    out.push(row("Reopen pull request", `${thread}/state`, { state: "open" }));
  if (c?.mayEdit) out.push(row("Edit", `${thread}#edit`));
  if (c?.takeBack) out.push(row("Take it back", `${thread}?more=1#take-back`));
  if (i.mergeReady) out.push(row("Merge pull request", `${thread}/merge`, { strategy: "merge" }));
  return out;
}
