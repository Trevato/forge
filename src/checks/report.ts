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
import { addComment, createLabel, getLabel, listIssues, type Label } from "../core/issues.ts";
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
        `_Filed by the scheduled full-suite report, not written by a person. It holds no pull, batch or release._\n\n` +
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

/** Where the report's issues are listed: the forge's own repository, filtered by the label. */
export const reportPath = (): string => `/${ownRepoPath()}/issues?label=${REPORT_LABEL}`;

/** One line for the terminal: how many report issues are open and where they are listed. */
export function reportLine(db: Database): string {
  const [owner = "", name = ""] = ownRepoPath().split("/");
  const repo = getRepo(db, owner, name);
  const open = repo === undefined ? 0 : listIssues(db, repo.id, { label: REPORT_LABEL }).length;
  return `Full suite report: ${open} open issue${open === 1 ? "" : "s"} labelled ${REPORT_LABEL} in ${owner}/${name} (the terminal's issue list, key l).`;
}
