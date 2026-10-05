/**
 * The first-login card of a spawned forge (#600, `core/next-steps.ts`). The
 * path: the person a forge was made for claims it and lands home; this card
 * says, first, that their crew is already at work and on what, then three
 * steps that tick themselves done — the first not yet done is the one
 * primary action. Make your everyday account carries the form itself (it
 * replaces #803's separate card here); open your apps lists them; tell the
 * crew something points at the composer just below. The card goes once
 * all three are done.
 */

import { getIssueById } from "../../core/issues.ts";
import {
  nextStepsFor,
  spawnedRepos,
  type NextStep,
} from "../../core/next-steps.ts";
import { getUserById, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { btn, card } from "../ui.ts";
import { everydayAsk } from "./everyday.ts";
import { EVERYDAY_WHY } from "../../core/everyday.ts";

/** One line per app whose crew has its direction: who, on what, and how far. */
function crewAtWork(
  ctx: Ctx,
  repos: Awaited<ReturnType<typeof spawnedRepos>>,
): Html[] {
  const lines: Html[] = [];
  for (const repo of repos) {
    if (repo.directionIssueId === null) continue;
    const issue = getIssueById(ctx.app.db, repo.directionIssueId);
    if (!issue || issue.state !== "open" || issue.assigneeId === null) continue;
    const agent = getUserById(ctx.app.db, issue.assigneeId);
    if (!agent) continue;
    const run = ctx.app.db
      .query<
        { state: string },
        [string]
      >("SELECT state FROM run WHERE issue_id = ?1 AND kind = 'agent' ORDER BY created_at DESC LIMIT 1")
      .get(issue.id);
    const doing =
      run?.state === "running"
        ? "is working on"
        : run?.state === "queued"
          ? "is about to start on"
          : "has been given";
    lines.push(
      html`<li>
        <b>${agent.username}</b> ${doing}
        <a href="/${repo.ownerName}/${repo.name}/issues/${issue.number}"
          >${issue.title}</a
        >
      </li>`,
    );
  }
  return lines;
}

function stepRow(step: NextStep, primary: boolean, body: Html | null): Html {
  return html`<li
    class="next-step"
    data-step="${step.key}"
    data-done="${step.done ? "yes" : "no"}"
    ${primary ? html`data-primary=""` : null}
  >
    <span class="next-step-mark" aria-hidden="true"
      >${step.done ? icon("check") : icon("issue")}</span
    >
    <span class="next-step-main">
      <span class="next-step-title">${step.title}</span>
      ${step.done ? null : body}
    </span>
  </li>`;
}

/** The card, or nothing: not a spawned forge, not its owner, or every step done. */
export async function nextStepsCard(
  ctx: Ctx,
  user: User,
): Promise<Html | null> {
  const steps = await nextStepsFor(ctx.app, user);
  if (!steps || steps.every((s) => s.done)) return null;
  const repos = await spawnedRepos(ctx.app, user);
  const working = crewAtWork(ctx, repos);
  const primary = steps.find((s) => !s.done)?.key;
  const bodies: Record<NextStep["key"], Html | null> = {
    everyday: html`<p class="muted small">${EVERYDAY_WHY}</p>
      ${everydayAsk(ctx, user)}`,
    apps:
      repos.length === 0
        ? html`<p class="muted small">
            Your apps arrive here as the crew sets them up.
          </p>`
        : html`<p class="next-step-apps">
            ${repos.map(
              (r) =>
                html`${btn(r.name, {
                  href: `/${r.ownerName}/${r.name}`,
                  size: "sm",
                })} `,
            )}
          </p>`,
    tell: html`<p class="muted small">
      Say what you want in one sentence, in the box below; the crew takes it
      from there.
      ${btn("Tell the crew", {
        href: "#composer",
        size: "sm",
        ...(primary === "tell" ? { variant: "primary" as const } : {}),
      })}
    </p>`,
  };
  return card(
    html`${working.length > 0
        ? html`<p class="mb">Your crew is already at work:</p>
            <ul class="next-crew mb">
              ${working}
            </ul>`
        : null}
      <ol class="next-steps">
        ${steps.map((s) => stepRow(s, s.key === primary, bodies[s.key]))}
      </ol>`,
    { id: "next-steps", head: html`<h2>Your next steps</h2>` },
  );
}
