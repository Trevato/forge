/**
 * The first-login card of a spawned forge (#600, `core/next-steps.ts`). The
 * path: the person a forge was made for claims it and lands home; this card
 * says, first, who in their crew has its direction and whether they are at
 * work on it yet, then three
 * steps that tick themselves done — the first not yet done is the one
 * primary action. Make your everyday account carries the form itself (it
 * replaces #803's separate card here); open your apps lists them; tell the
 * crew something points at the composer just below. The card goes once
 * all three are done. Before the first tell the card is one box, "What do you
 * want built?", and one line on what pays for the crew; the everyday account is
 * offered once a tell exists, never as a gate before it (#11173).
 */

import { appCrew } from "../../core/app-crew.ts";
import {
  nextStepsFor,
  spawnedRepos,
  type NextStep,
} from "../../core/next-steps.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { badge, btn, row } from "../ui.ts";
import { tellHref } from "../studio/nouns.ts";
import { everydayAsk } from "./everyday.ts";
import { EVERYDAY_WHY } from "../../core/everyday.ts";
import { crewNote } from "../studio/crew_key.ts";
import { crewHasCredential } from "../../core/subscriptions.ts";
import { FORGE_TARGET } from "../studio/feed.ts";
import { COMPOSER_FIELDS, TELL_MAX } from "../share_target.ts";

/** One line per app: the app is the row's title, the crew member and what they are doing its meta. */
function crewAtWork(ctx: Ctx, repos: Awaited<ReturnType<typeof spawnedRepos>>): Html[] {
  return appCrew(ctx.app.db, repos).map((c) => {
    const href = `/${c.repo.ownerName}/${c.repo.name}`;
    return row({
      href: c.issueNumber === null ? href : tellHref(href, c.issueNumber),
      title: c.repo.name,
      meta: html`${c.says}`,
    });
  });
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

/** Before the first tell: one box, "say what you want built", and one line about what pays for the crew. */
function firstTell(ctx: Ctx, user: User, crew: Html[]): Html {
  return html`<section id="next-steps" data-first-tell>
    <h2>What do you want built?</h2>
    <form id="composer" class="stack" method="post" action="/tell">
      <input type="hidden" name="${COMPOSER_FIELDS.app}" value="${FORGE_TARGET}" />
      <textarea class="input" name="${COMPOSER_FIELDS.text}" rows="3" maxlength="${String(TELL_MAX)}" required placeholder="A weekly menu page for the bakery" aria-label="Your request" data-draft="${user.id}"></textarea>
      <div class="bar">${btn("Tell the crew", { variant: "primary" })}</div>
    </form>
    <p class="small muted" id="crew-credit-note">${crewNote(ctx.app)}${crewHasCredential(ctx.app.db) || !ctx.auth.user?.isAdmin ? null : html` <a href="/settings/subscriptions">Add your own key</a>.`}</p>
    ${crew.length > 0 ? html`<ul class="list">${crew}</ul>` : null}
  </section>`;
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
  if (steps.some((s) => s.key === "tell" && !s.done)) return firstTell(ctx, user, crew);
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
    ${crew.length > 0 ? html`<ul class="list">${crew}</ul>` : null}
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
