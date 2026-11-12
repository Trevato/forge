/**
 * The efficiency watcher's pass (#7558): record this hour's readings, judge each cause against its
 * baseline, and keep one issue per cause — filed when it stands, commented while it does, closed
 * with a note once it has been back under for 24 hours.
 */

import type { App } from "../app.ts";
import { addComment, openIssue, setIssueState } from "../actions/issues.ts";
import { getIssueById } from "../core/issues.ts";
import { getRepo } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import type { DutyResult, Finding } from "../maintain/duty.ts";
import { HOUR_MS, hourStart } from "./baseline.ts";
import { CAUSES } from "./causes.ts";
import { bodyOf, closingNote, commentOf, numbers, titleOf } from "./finding.ts";
import { isBad, standing, hourVerdict } from "./judge.ts";
import { readNow, type Readings } from "./readings.ts";
import { dropStanding, pruneSamples, putSample, putStanding, readSeries, standingOf } from "./store.ts";

export const CLEAR_AFTER_MS = 24 * HOUR_MS;

export function watch(app: App, now: number, readings: Readings = readNow(app.db, now)): DutyResult {
  const { db } = app;
  const hour = hourStart(now);
  const findings: Finding[] = [];
  const actions: string[] = [];
  const [owner = "", name = ""] = (app.config.forgeRepo ?? "").split("/");
  const repo = owner && name ? getRepo(db, owner, name) : undefined;
  const actor = repo ? getUserById(db, repo.ownerId) : undefined;

  for (const c of CAUSES) {
    const reading = readings[c.id];
    if (reading !== undefined) putSample(db, c.id, hour, reading);
    const series = readSeries(db, c.id, hour);
    const stands = standing(c, series, hour);
    const kept = standingOf(db, c.id);
    const issue = kept ? getIssueById(db, kept.issueId) : undefined;
    const open = issue !== undefined && issue.state === "open";

    if (stands !== undefined) {
      findings.push({
        summary: `${c.label}: ${numbers(c, stands.now, stands.why)}`,
        probe: { kind: "measurement", what: `${c.label} (${c.unit}) in the hour from ${new Date(hour).toISOString()}`, number: stands.now.value, at: new Date(now).toISOString() },
      });
      if (repo === undefined || actor === undefined) continue;
      if (open && kept !== undefined) {
        // One comment per hour: a second pass in the same hour adds nothing.
        if (kept.lastBad < hour) {
          addComment(app, actor, repo, issue, commentOf(c, stands.now, stands.why));
          putStanding(db, { ...kept, lastBad: hour });
          actions.push(`commented on #${issue.number} (${c.id})`);
        }
        continue;
      }
      const filed = openIssue(app, actor, repo, { title: titleOf(c), body: bodyOf(c, stands.now, stands.why) });
      if (filed.ok) {
        putStanding(db, { cause: c.id, issueId: filed.value.id, lastBad: hour });
        actions.push(`filed #${filed.value.number} (${c.id})`);
      }
      continue;
    }

    if (kept === undefined) continue;
    if (!open) {
      dropStanding(db, c.id); // someone closed it: the next standing cost files anew
      continue;
    }
    const lastBad = isBad(hourVerdict(c, series, hour)) ? hour : kept.lastBad;
    if (lastBad !== kept.lastBad) putStanding(db, { ...kept, lastBad });
    if (repo !== undefined && actor !== undefined && now - lastBad >= CLEAR_AFTER_MS) {
      addComment(app, actor, repo, issue, closingNote(c));
      setIssueState(app, actor, repo, issue, "closed");
      dropStanding(db, c.id);
      actions.push(`closed #${issue.number} (${c.id}) after 24 hours clear`);
    }
  }
  pruneSamples(db, now);
  if (findings.length > 0 && (repo === undefined || actor === undefined)) {
    const why = !app.config.forgeRepo
      ? "FORGE_REPO is not set"
      : !owner || !name
        ? `FORGE_REPO "${app.config.forgeRepo}" is not owner/name`
        : repo === undefined
          ? `FORGE_REPO "${app.config.forgeRepo}" names no repository on this forge`
          : "the repository's owner is not a user";
    actions.push(`filed nothing: ${why}, so there is no repository to file ${findings.length} finding(s) in`);
  }
  return { findings, actions };
}
