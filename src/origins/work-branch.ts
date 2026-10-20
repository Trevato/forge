/**
 * The work branch: of a repository's branches, the one its person was
 * working on. A fork keeps the upstream's tree on `main` and the person's
 * app on a branch of their own (`workbench`, four commits ahead), so the
 * source's default branch is not always where the app is. The rule is the
 * one a person would use looking at the list: the branch whose last commit
 * is theirs and newest; when none is theirs, the source's own default.
 *
 * A branch's last commit is read two ways, to the same shape: from a clone
 * already on disk (one `git for-each-ref`, every branch) or from an origin's
 * API before anything is cloned (one listing, then one commit per branch,
 * bounded). Whose a commit is: an account login the origin resolved, or an
 * author email or name that is one of the person's.
 */

import { runGitCapture } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import type { Provider, RemoteCommit } from "./types.ts";

export interface BranchTip {
  readonly name: string;
  readonly oid: string;
  /** The last commit's author date, ISO 8601; "" when not known. */
  readonly date: string;
  readonly subject: string;
  /** Who wrote it, as the page shows it: a login, else the author's name. */
  readonly author: string;
  /** Written by the person migrating. */
  readonly mine: boolean;
}

/** The person, as commits may name them. Compared without case. */
export interface Who {
  readonly logins: readonly string[];
  readonly emails: readonly string[];
}

/** Branches whose last commit an origin is asked for; past it, names alone. */
export const TIP_LOOKUPS = 30;

/**
 * Whether an author is the person: a login the origin resolved, an email
 * of theirs (GitHub's `<id>+<login>@users.noreply.github.com` included),
 * or a name that is one of their logins.
 */
export function isMine(
  author: { readonly name: string; readonly email: string; readonly login?: string },
  who: Who,
): boolean {
  const logins = who.logins.map((l) => l.toLowerCase()).filter((l) => l !== "");
  const emails = who.emails.map((e) => e.toLowerCase()).filter((e) => e !== "");
  const login = (author.login ?? "").toLowerCase();
  const email = author.email.toLowerCase().replace(/^<|>$/g, "");
  const name = author.name.toLowerCase();
  if (login !== "" && logins.includes(login)) return true;
  if (email !== "" && emails.includes(email)) return true;
  const noreply = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
  if (noreply !== null && logins.includes(noreply[1]!)) return true;
  return name !== "" && logins.includes(name);
}

/**
 * The branch to work on: the newest tip that is the person's; else the
 * fallback when it is a branch; else the newest tip of all. ISO dates
 * compare as strings once they share a zone, so they are compared as times.
 */
export function pickWorkBranch(
  tips: readonly BranchTip[],
  fallback: string | undefined,
): string | undefined {
  const newest = (rows: readonly BranchTip[]): BranchTip | undefined =>
    [...rows].sort(
      (a, b) => time(b.date) - time(a.date) || a.name.localeCompare(b.name),
    )[0];
  const mine = newest(tips.filter((t) => t.mine));
  if (mine !== undefined) return mine.name;
  if (fallback !== undefined && tips.some((t) => t.name === fallback))
    return fallback;
  return newest(tips)?.name;
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Every branch's last commit in a repository on disk, newest first. */
export async function localTips(dir: string, who: Who): Promise<BranchTip[]> {
  const listed = await runGitCapture(
    [
      "for-each-ref",
      "--sort=-authordate",
      "--format=%(refname)%00%(objectname)%00%(authordate:iso-strict)%00%(authorname)%00%(authoremail)%00%(contents:subject)",
      "refs/heads/",
    ],
    { cwd: dir },
  );
  if (listed.code !== 0) return [];
  const tips: BranchTip[] = [];
  for (const line of listed.stdout.split("\n")) {
    const [ref, oid, date, name, email, subject] = line.split("\0");
    if (ref === undefined || !ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    tips.push({
      name: branch,
      oid: oid ?? "",
      date: date ?? "",
      subject: subject ?? "",
      author: name ?? "",
      mine: isMine({ name: name ?? "", email: email ?? "" }, who),
    });
  }
  return tips;
}

/**
 * Every branch's last commit as an origin reports it, before any clone —
 * what the picker draws. One listing, then the first {@link TIP_LOOKUPS}
 * branches' commits side by side; the rest come back with no commit.
 * `undefined` when the origin will not list.
 */
export async function remoteTips(
  provider: Provider,
  fullName: string,
  who: Who,
): Promise<BranchTip[] | undefined> {
  const listed = await provider.listBranches(fullName);
  if (!listed.ok) return undefined;
  const branches = listed.value.filter((b) => isSafeRef(b.name));
  return Promise.all(
    branches.map(async (branch, i): Promise<BranchTip> => {
      const bare = {
        name: branch.name,
        oid: branch.oid,
        date: "",
        subject: "",
        author: "",
        mine: false,
      };
      if (i >= TIP_LOOKUPS || branch.oid === "") return bare;
      const page = await provider.listCommits(fullName, branch.oid);
      const last: RemoteCommit | undefined = page.ok ? page.value.items[0] : undefined;
      if (last === undefined) return bare;
      return {
        ...bare,
        date: last.author.date,
        subject: last.message.split("\n")[0] ?? "",
        author: last.author.login ?? last.author.name,
        mine: isMine(last.author, who),
      };
    }),
  );
}

/** How long the picker reuses one repository's tips: a reload, a 422. */
export const TIPS_TTL_MS = 60_000;
const TIPS_KEPT = 64;
const tipsSeen = new Map<string, { readonly at: number; readonly tips: BranchTip[] }>();

/**
 * {@link remoteTips} through a short memory, keyed by origin and repository
 * — an origin belongs to one person, so the key is theirs alone. A reload
 * of the picker costs no requests to the origin, nor its rate limit; a
 * refusal is not remembered. Past {@link TIPS_KEPT} keys the oldest goes.
 */
export async function cachedRemoteTips(
  originId: string,
  provider: Provider,
  fullName: string,
  who: Who,
  now: number = Date.now(),
): Promise<BranchTip[] | undefined> {
  const key = `${originId}\0${fullName}`;
  const seen = tipsSeen.get(key);
  if (seen !== undefined && now - seen.at < TIPS_TTL_MS) return seen.tips;
  const tips = await remoteTips(provider, fullName, who);
  if (tips === undefined) return undefined;
  tipsSeen.delete(key);
  tipsSeen.set(key, { at: now, tips });
  while (tipsSeen.size > TIPS_KEPT) {
    const oldest = tipsSeen.keys().next().value;
    if (oldest === undefined) break;
    tipsSeen.delete(oldest);
  }
  return tips;
}
