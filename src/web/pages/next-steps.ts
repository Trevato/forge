/**
 * The first-login card of a spawned forge (#600, `core/next-steps.ts`). The
 * path: the person a forge was made for claims it and lands home; this card
 * says, first, who in their crew has its direction and whether they are at
 * work on it yet, then three
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
import { badge, btn, row } from "../ui.ts";
import { tellHref } from "../studio/nouns.ts";
import { everydayAsk } from "./everyday.ts";
import { EVERYDAY_WHY } from "../../core/everyday.ts";

/** One line per app whose crew has its direction: who, on what, and how far. */
function crewAtWork(
  ctx: Ctx,
  repos: Awaited<ReturnType<typeof spawnedRepos>>,
): { lines: Html[]; busy: boolean } {
  const lines: Html[] = [];
  let busy = false;
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
    if (run?.state === "running" || run?.state === "queued") busy = true;
    const doing =
      run?.state === "running"
        ? "is working on"
        : run?.state === "queued"
          ? "is about to start on"
          : "has been given";
    lines.push(
      row({
        href: tellHref(`/${repo.ownerName}/${repo.name}`, issue.number),
        title: html`<b>${agent.username}</b> ${doing} ${issue.title}`,
      }),
    );
  }
  return { lines, busy };
}

/** One step: its row (title, "Done" trail; the primary one in bold), then its
 * body as a block of its own under the title. `.row-meta` is one clipped line,
 * no place for a form. */
function stepBlock(step: NextStep, primary: boolean, body: Html | null): Html {
  const head = row({
    lead: step.done ? icon("check") : icon("issue"),
    title: primary ? html`<b>${step.title}</b>` : html`${step.title}`,
    ...(step.done ? { trail: badge("Done", { tone: "success" }) } : {}),
    data: {
      step: step.key,
      done: step.done ? "yes" : "no",
      ...(primary ? { primary: "" } : {}),
    },
  });
  return html`<ul class="list">
      ${head}
    </ul>
    ${!step.done && body ? html`<div class="step-body">${body}</div>` : null}`;
}

/** The card, or nothing: not a spawned forge, not its owner, or every step done. */
export async function nextStepsCard(
  ctx: Ctx,
  user: User,
  steps: readonly NextStep[] | undefined,
): Promise<Html | null> {
  if (!steps || steps.every((s) => s.done)) return null;
  const repos = await spawnedRepos(ctx.app, user);
  const crew = crewAtWork(ctx, repos);
  const primary = steps.find((s) => !s.done)?.key;
  const bodies: Record<NextStep["key"], Html | null> = {
    everyday: html`<p class="muted small">${EVERYDAY_WHY}</p>
      ${everydayAsk(ctx, user)}`,
    apps:
      repos.length === 0
        ? html`<p class="muted small">
            Your apps arrive here as the crew sets them up.
          </p>`
        : html`<p>
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
  return html`<section id="next-steps">
    <h2>Your next steps</h2>
    ${crew.lines.length > 0
      ? html`<p>
            ${crew.busy
              ? "Your crew is already at work:"
              : "Your crew has its direction:"}
          </p>
          <ul class="list">
            ${crew.lines}
          </ul>`
      : null}
    ${steps.map((s) => stepBlock(s, s.key === primary, bodies[s.key]))}
  </section>`;
}

/** The steps once per request, for the card and for the lean home to share. */
export function nextStepsOf(
  ctx: Ctx,
  user: User,
): Promise<readonly NextStep[] | undefined> {
  return nextStepsFor(ctx.app, user);
}
