/**
 * The full suite as a scheduled report (#7780). A verification after landing
 * (`checks/verify.ts`) runs every shard against main's tip; when it is red,
 * each failing test file gets one issue, labelled {@link REPORT_LABEL} so it
 * is found: the open one is added to when a later run fails the same file,
 * and none is made twice. The report only files. Nothing reads a verification
 * when it decides whether a pull, a batch or a release may go ahead (those
 * look at the default branch's own check), so a red report holds none of them.
 */

import type { App } from "../app.ts";
import type { Database } from "bun:sqlite";
import { addComment, createLabel, getLabel, listIssues, setIssueState, type Label } from "../core/issues.ts";
import { getRepo, type Repo } from "../core/repos.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";
import type { CheckDetail, Run } from "../core/runs.ts";
import { failedTests, fileIssueOnce } from "./flake.ts";

/** The label every report issue carries. */
export const REPORT_LABEL = "full-suite";
const REPORT_COLOR = "d93f0b";
/** The most failing tests a run carries for the report. */
export const MAX_FAILURES = 40;
/** The most tests one issue names. */
const NAMED = 10;

export const reportTitle = (file: string): string => `Full suite red: ${file}`;
/** How every report issue's body opens: with the label and title, what tells it from one a person wrote. */
const FILED_BY = "_Filed by the scheduled full-suite report, not written by a person.";

/** A red verification's detail with the failing tests under its failing files (at most {@link MAX_FAILURES}). */
export function redDetail(
  detail: CheckDetail | undefined,
  files: readonly string[],
  lines: readonly string[],
): CheckDetail | undefined {
  if (files.length === 0) return detail;
  return {
    ...(detail ?? { passed: 0, failed: files.length, names: [] }),
    files,
    failures: failedTests(lines).filter((t) => files.includes(t.file)).slice(0, MAX_FAILURES),
  };
}

function labelOf(app: App, repo: Repo): Label | undefined {
  const made = createLabel(app.db, repo.id, REPORT_LABEL, REPORT_COLOR);
  return made.ok ? made.value : getLabel(app.db, repo.id, REPORT_LABEL);
}

/** The lines for a red verification's log: one per failing file, filed or added to. Empty when green. */
export function reportRed(app: App, repo: Repo, run: Run): string[] {
  if (run.state !== "failed") return [];
  const files = run.checkDetail?.files ?? [];
  const failures = run.checkDetail?.failures ?? [];
  const label = files.length > 0 ? labelOf(app, repo) : undefined;
  const lines: string[] = [];
  for (const file of files) {
    const names = failures.filter((f) => f.file === file).map((f) => f.name);
    const said = names.length === 0 ? "" : `\n\n${names.slice(0, NAMED).map((n) => `- \`${n}\``).join("\n")}`;
    const more = names.length > NAMED ? `\n- and ${names.length - NAMED} more` : "";
    const where = `check run ${run.id}, ${run.commitOid.slice(0, 7)}`;
    const title = reportTitle(file);
    const filed = fileIssueOnce(app.db, app.bus, repo, {
      title,
      body:
        `${FILED_BY} It holds no pull, batch or release._\n\n` +
        `\`${file}\` failed in the full suite on ${repo.defaultBranch} (${where}).` +
        `${said}${more}\n\nFiles: ${file}`,
      ...(label === undefined ? {} : { labelId: label.id }),
    });
    if (filed.number === 0) lines.push(`report: ${file} not filed`);
    else if (filed.opened) lines.push(`report: filed #${filed.number} for ${file}`);
    else {
      const open = app.db
        .query<{ id: string }, [string, number]>("SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2")
        .get(repo.id, filed.number);
      if (open !== null)
        addComment(app.db, {
          issueId: open.id,
          authorId: repo.ownerId,
          body: `Still red in the full suite (${where}).${said}${more}`,
        });
      lines.push(`report: added to #${filed.number} for ${file}`);
    }
  }
  return lines;
}

/**
 * The lines for a finished verification's log: one per open report issue
 * whose file ran and passed every test in it (#9524), commented on and
 * closed as done. `passed` is what the run's own log showed
 * (`verify.ts` `passedFiles`); a file it never printed (a shard that did
 * not run, a run cut short) keeps its issue open. Only an issue the report
 * filed is closed: its label, its exact title, the owner as author and the
 * report's own opening line, never one a person wrote.
 */
export function reportGreen(app: App, repo: Repo, run: Run, passed: readonly string[]): string[] {
  if (run.state !== "ok" && run.state !== "failed") return [];
  if (passed.length === 0) return [];
  const ran = new Map(passed.map((file) => [reportTitle(file), file]));
  const open = app.db
    .query<{ id: string; number: number; title: string; body: string }, [string, string, string]>(
      `SELECT issue.id, issue.number, issue.title, issue.body FROM issue
       WHERE issue.repo_id = ?1 AND issue.kind = 'issue' AND issue.state = 'open'
         AND issue.author_id = ?2
         AND EXISTS (SELECT 1 FROM issue_label JOIN label ON label.id = issue_label.label_id
                     WHERE issue_label.issue_id = issue.id AND label.name = ?3)
       ORDER BY issue.number`,
    )
    .all(repo.id, repo.ownerId, REPORT_LABEL);
  const where = `check run ${run.id}, ${run.commitOid.slice(0, 7)}`;
  const lines: string[] = [];
  for (const issue of open) {
    const file = ran.get(issue.title);
    if (file === undefined || !issue.body.startsWith(FILED_BY)) continue;
    const body = `Green again in the full suite (${where}).`;
    const noted = addComment(app.db, { issueId: issue.id, authorId: repo.ownerId, body });
    if (noted.ok)
      app.bus.append({
        kind: "issue.commented",
        repoId: repo.id,
        actorId: repo.ownerId,
        payload: { number: issue.number, body, commentId: noted.value.id },
      });
    if (setIssueState(app.db, issue.id, "closed", "done") === undefined) continue;
    app.bus.append({
      kind: "issue.closed",
      repoId: repo.id,
      actorId: repo.ownerId,
      payload: { number: issue.number },
    });
    lines.push(`report: closed #${issue.number}, ${file} green again`);
  }
  return lines;
}

/** Where the report's issues are listed: the forge's own repository, filtered by the label. */
export const reportPath = (): string => `/${ownRepoPath()}/issues?label=${REPORT_LABEL}`;

/** One line for the terminal: how many report issues are open and where they are listed. */
export function reportLine(db: Database): string {
  const [owner = "", name = ""] = ownRepoPath().split("/");
  const repo = getRepo(db, owner, name);
  const open = repo === undefined ? 0 : listIssues(db, repo.id, { label: REPORT_LABEL }).length;
  return `Full suite report: ${open} open issue${open === 1 ? "" : "s"} labelled ${REPORT_LABEL} in ${owner}/${name} (the terminal's issue list, key l).`;
}
