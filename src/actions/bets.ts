/**
 * Bets (#8713): the planner proposes them from open work, the owner backs
 * one with a tap and a share, the crew finishes them. A bet that spends its
 * appetite stops — never extended by itself — and the lead says in one line
 * what is left, for the owner to re-back, cut or end. Every change is an
 * event; only a person who administers the repository decides.
 */

import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import {
  type Bet, betRuns, betScopes, getBet, insertBet, listBets, markBacked, markEnded, setLeftLine, setTryUrl, setVerdict,
} from "../core/bets.ts";
import { notesOfRepo } from "../core/app_notes.ts";
import { themeWords, groupByWords } from "../core/bet_themes.ts";
import { getIssuesByNumbers, labelsForIssues, numberKey } from "../core/issues.ts";
import { isStructural, LATER, pillarsOf, servedBy } from "../core/pillars.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { AUTO_SHARE, autoStarts, budgetSeconds, mayBack, spentSeconds, spentUp } from "../crew/bets.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type BetError = "forbidden" | "not_found" | "refused";
type Answer = Result<Bet, { error: BetError; message: string }>;

const refuse = (error: BetError, message: string): Answer => err({ error, message });
const NAME_MAX = 80;
const LINE_MAX = 240;
export const oneLine = (s: string, max = LINE_MAX): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

/** A person (never an agent) who administers the repository. */
function owns(app: App, repo: Repo, user: User): boolean {
  return user.kind !== "agent" && canAdmin(app.db, repo, user);
}

function load(app: App, repo: Repo, id: string): Bet | undefined {
  const bet = getBet(app.db, id);
  return bet !== undefined && bet.repoId === repo.id ? bet : undefined;
}

const backed = (app: App, repo: Repo) => listBets(app.db, repo.id).filter((b) => b.state === "backed");

/**
 * The planner's proposals: open issues in no live bet, grouped by their first
 * label, else the pillar they hold up, else the title words they share (the
 * theme; no model, the same state gives the same proposals). A note written by
 * the repo's owner or an admin joins a group when its issue is held there, it
 * names one of the group's issues as #N, or it shares two words with the
 * group's name and titles; it is quoted in the bet. Visitors' notes never join. Each group becomes a bet with
 * a modest share and the issues as scopes, led by the crew's first builder.
 * Run again it adds only what is new. At most five.
 */
export function proposeBets(app: App, repo: Repo, now = new Date()): Bet[] {
  const live = new Set(
    app.db
      .query<{ issue_id: string }, [string]>(
        `SELECT bi.issue_id FROM bet_issue bi JOIN bet b ON b.id = bi.bet_id
          WHERE b.repo_id = ?1 AND b.state IN ('proposed','backed','stopped')`,
      )
      .all(repo.id)
      .map((r) => r.issue_id),
  );
  const open = app.db
    .query<{ id: string; number: number; title: string }, [string]>(
      "SELECT id, number, title FROM issue WHERE repo_id = ?1 AND state = 'open' AND kind = 'issue' ORDER BY number",
    )
    .all(repo.id)
    .filter((i) => !live.has(i.id));
  const labels = labelsForIssues(app.db, open.map((i) => i.id));
  type Item = (typeof open)[number];
  const themes = new Map<string, Item[]>();
  const add = (theme: string, i: Item) => themes.set(theme, [...(themes.get(theme) ?? []), i]);
  // 1. The first label; 2. the pillar an unlabelled issue holds up; 3. title words the rest share.
  const loose: Item[] = [];
  const set = pillarsOf(app.db, repo);
  const served = servedBy(app.db, set);
  for (const i of open) {
    const label = (labels.get(i.id) ?? [])[0]?.name ?? "";
    const pillar = served.get(i.id);
    if (label !== "") add(label, i);
    else if (pillar === LATER || isStructural(set, i.id)) continue;
    else if (pillar !== undefined) add(pillar, i);
    else loose.push(i);
  }
  for (const [word, items] of groupByWords(loose)) for (const i of items) add(word, i);
  // The owner's and admins' notes (a visitor's never): each is the issue its words became. A note joins the theme
  // that holds its issue, names one of its issues as #N, or shares two words with its name and its issues' titles;
  // its issue joins too when no theme holds it.
  const byNumber = new Map(open.map((i) => [i.number, i]));
  const trusted = new Map<string, boolean>();
  const mayNote = (visitor: string): boolean => {
    let ok = trusted.get(visitor);
    if (ok === undefined) {
      const user = visitor.startsWith("u:") ? getUserById(app.db, visitor.slice(2)) : undefined;
      ok = user !== undefined && (user.isAdmin || canAdmin(app.db, repo, user));
      trusted.set(visitor, ok);
    }
    return ok;
  };
  const written = notesOfRepo(app.db, repo.id).filter((n) => mayNote(n.visitor));
  const found = getIssuesByNumbers(app.db, written.map((n) => ({ repoId: repo.id, number: n.issueNumber })));
  const notes = written.flatMap((n) => {
    const issue = found.get(numberKey(repo.id, n.issueNumber));
    return issue === undefined ? [] : [{ issue, text: `${issue.title}\n${issue.body}` }];
  });
  const quoted = new Map<string, string[]>();
  const held = new Set([...themes.values()].flat().map((i) => i.id));
  for (const [theme, issues] of [...themes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const own = new Set(issues.map((i) => i.id));
    const wanted = new Set([theme, ...issues.map((i) => i.title)].flatMap(themeWords));
    for (const n of notes) {
      const named = [...n.text.matchAll(/#(\d+)/g)].some((m) => own.has(byNumber.get(Number(m[1]))?.id ?? ""));
      const shares = themeWords(n.text).filter((w) => wanted.has(w)).length >= 2;
      if (!own.has(n.issue.id) && !named && !shares) continue;
      quoted.set(theme, [...(quoted.get(theme) ?? []), n.issue.title]);
      const mine = byNumber.get(n.issue.number);
      if (mine !== undefined && !held.has(mine.id)) {
        held.add(mine.id);
        add(theme, mine);
      }
    }
  }
  const named = new Set(listBets(app.db, repo.id).filter((b) => b.state !== "cut" && b.state !== "done").map((b) => b.name));
  const lead = listCrewRoles(app.db, repo.id).find((c) => c.role === "builder")?.agent.user.id ?? null;
  const made: Bet[] = [];
  for (const [theme, issues] of [...themes].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const name = oneLine(theme[0]!.toUpperCase() + theme.slice(1), NAME_MAX);
    if (made.length >= 5 || issues.length < 2 || named.has(name)) continue;
    named.add(name);
    const journeys = [
      ...issues.slice(0, 3).map((i) => `Someone can ${oneLine(i.title, 100)}`),
      ...(quoted.get(theme) ?? []).slice(0, 2).map((t) => `The owner's note: "${oneLine(t, 100)}"`),
    ].join("\n");
    const bet = insertBet(app.db, { repoId: repo.id, name, journeys, appetite: 20, leadId: lead, issueIds: issues.map((i) => i.id) }, now);
    app.bus.append({ kind: "bet.proposed", repoId: repo.id, payload: { bet: bet.id, name } });
    made.push(bet);
  }
  return made;
}

/** The owner backs a proposed or stopped bet with a share of the week. */
export function backBet(app: App, user: User, repo: Repo, id: string, share: number, now = new Date()): Answer {
  if (!owns(app, repo, user)) return refuse("forbidden", "only the owner backs a bet");
  const bet = load(app, repo, id);
  if (bet === undefined) return refuse("not_found", "no such bet");
  if (bet.state === "done" || bet.state === "cut") return refuse("refused", "that bet has ended");
  const others = backed(app, repo).filter((b) => b.id !== id);
  const why = mayBack(others, share);
  if (why !== null) return refuse("refused", why);
  markBacked(app.db, id, share, "owner", now);
  app.bus.append({ kind: "bet.backed", repoId: repo.id, actorId: user.id, payload: { bet: id, share, by: "owner" } });
  return ok(getBet(app.db, id)!);
}

/** One tap stops a bet, whoever started it: it keeps its scopes and can be backed again. */
export function stopBet(app: App, user: User, repo: Repo, id: string, now = new Date()): Answer {
  if (!owns(app, repo, user)) return refuse("forbidden", "only the owner stops a bet");
  const bet = load(app, repo, id);
  if (bet === undefined) return refuse("not_found", "no such bet");
  if (bet.state !== "backed") return refuse("refused", "that bet is not running");
  markEnded(app.db, id, "stopped", now, bet.leftLine === "" ? "Stopped by the owner." : bet.leftLine);
  app.bus.append({ kind: "bet.stopped", repoId: repo.id, actorId: user.id, payload: { bet: id, why: "owner" } });
  return ok(getBet(app.db, id)!);
}

/** Cut (drop what is left) any live bet, or end a stopped one as done. */
export function endBet(app: App, user: User, repo: Repo, id: string, how: "cut" | "done", now = new Date()): Answer {
  if (!owns(app, repo, user)) return refuse("forbidden", "only the owner ends a bet");
  const bet = load(app, repo, id);
  if (bet === undefined) return refuse("not_found", "no such bet");
  if (bet.state === "done" || bet.state === "cut") return ok(bet);
  // Only a bet that stopped is called done by hand; a running one finishes when its scopes do.
  if (how === "done" && bet.state !== "stopped") return refuse("refused", "only a stopped bet can be ended as done; a running one finishes when every scope closes");
  markEnded(app.db, id, how, now);
  if (how === "done" && bet.tryUrl === "") setTryUrl(app.db, id, `/${repo.ownerName}/${repo.name}`);
  app.bus.append({ kind: `bet.${how === "cut" ? "cut" : "finished"}`, repoId: repo.id, actorId: user.id, payload: { bet: id } });
  return ok(getBet(app.db, id)!);
}

/** The lead (or the owner) writes what is left, in one line. */
export function writeLeft(app: App, user: User, repo: Repo, id: string, line: string): Answer {
  const bet = load(app, repo, id);
  if (bet === undefined) return refuse("not_found", "no such bet");
  if (user.id !== bet.leadId && !owns(app, repo, user)) return refuse("forbidden", "only the lead writes what is left");
  const text = oneLine(line);
  if (text === "") return refuse("refused", "say what is left in one line");
  setLeftLine(app.db, id, text);
  app.bus.append({ kind: "bet.left", repoId: repo.id, actorId: user.id, payload: { bet: id } });
  return ok(getBet(app.db, id)!);
}

/** The owner's word on a finished bet: "feels done", or "not yet" and why (it returns to stopped with that reason). */
export function giveVerdict(app: App, user: User, repo: Repo, id: string, verdict: "done" | "not_yet", why: string, now = new Date()): Answer {
  if (!owns(app, repo, user)) return refuse("forbidden", "only the owner says whether it feels done");
  const bet = load(app, repo, id);
  if (bet === undefined) return refuse("not_found", "no such bet");
  if (bet.state !== "done") return refuse("refused", "that bet has not finished");
  const reason = oneLine(why);
  if (verdict === "not_yet" && reason === "") return refuse("refused", "say why it is not yet");
  setVerdict(app.db, id, verdict, reason);
  if (verdict === "not_yet") markEnded(app.db, id, "stopped", now, reason);
  app.bus.append({ kind: "bet.verdict", repoId: repo.id, actorId: user.id, payload: { bet: id, verdict } });
  return ok(getBet(app.db, id)!);
}

/**
 * The bets' turn, once per tick: a backed bet whose scopes are all closed is
 * finished (the owner is asked to try it); one that has spent its appetite
 * stops with the open scopes as its left line, never extended; and when
 * nothing is backed a day after the first proposal, the top proposals start
 * at a modest share, marked as the planner's.
 */
export function tickBets(app: App, repo: Repo, now = new Date()): { finished: number; stopped: number; started: number } {
  const out = { finished: 0, stopped: 0, started: 0 };
  for (const bet of backed(app, repo)) {
    const scopes = betScopes(app.db, bet.id);
    const open = scopes.filter((s) => !s.closed);
    if (scopes.length > 0 && open.length === 0) {
      markEnded(app.db, bet.id, "done", now);
      setTryUrl(app.db, bet.id, `/${repo.ownerName}/${repo.name}`);
      app.bus.append({ kind: "bet.finished", repoId: repo.id, payload: { bet: bet.id } });
      out.finished++;
      continue;
    }
    const spent = spentSeconds(betRuns(app.db, bet.id, bet.backedAt ?? bet.proposedAt), now);
    if (spentUp(spent, budgetSeconds(bet.appetite, repo.autonomySlots))) {
      const line = bet.leftLine !== "" ? bet.leftLine : `Left: ${open.slice(0, 5).map((s) => `#${s.number} ${oneLine(s.title, 50)}`).join("; ")}.`;
      markEnded(app.db, bet.id, "stopped", now, line);
      app.bus.append({ kind: "bet.stopped", repoId: repo.id, payload: { bet: bet.id, why: "appetite" } });
      out.stopped++;
    }
  }
  const all = listBets(app.db, repo.id);
  const running = all.filter((b) => b.state === "backed").length;
  const proposed = all.filter((b) => b.state === "proposed");
  for (const id of autoStarts(proposed, all.some((b) => b.backedBy !== "") ? 1 : running, now)) {
    markBacked(app.db, id, AUTO_SHARE, "planner", now);
    app.bus.append({ kind: "bet.backed", repoId: repo.id, payload: { bet: id, share: AUTO_SHARE, by: "planner" } });
    out.started++;
  }
  return out;
}
