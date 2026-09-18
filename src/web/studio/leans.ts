/**
 * The decider's lean on an ask: which option a careful owner would pick,
 * asked off the request path and remembered against the head it was about
 * (`core/decisions.ts`, kind `lean`), so a page reads it with no wait and a
 * forge with no decider does nothing at all. The lean only ever decorates an
 * ask — it never makes the decision, and it never holds up a render.
 */

import { latestLean, recordDecision } from "../../core/decisions.ts";
import { certain, decideOr, type Decider } from "../../crew/decide.ts";
import type { Ctx } from "../../http/context.ts";
import { createLog } from "../../kernel/log.ts";
import { html, type Html } from "../html.ts";
import type { Decision, DecisionKind } from "./asks.ts";

/** The options a card offers, by name, as the decider sees them. */
const CARD_OPTIONS: Record<DecisionKind, Readonly<Record<string, string>>> = {
  stopped: {
    say: "Tell the builder what to try; the check can pass with guidance.",
    close: "Close it; the change is not worth more tries.",
    look: "A person should read the change before deciding.",
  },
  look: {
    ship: "Ship it; the change is green and small enough to land on its check.",
    say: "Say what is off; something in it needs a change first.",
    preview: "Open the preview first; it must be seen before shipping.",
  },
  paused: { settings: "Raise the ceiling.", wait: "Wait for midnight." },
};

const log = createLog("studio");

/** A pull's head oid, or "" for a card with no commit to key a lean on. */
const headOf = (d: Decision): string => d.pull?.headOid ?? "";

/** One background ask per card+head, so a page rendered by many people at
 * once never fans out past one call per card. Cleared once answered. */
const leanInFlight = new Map<string, Promise<void>>();

/** A pause before asking, long enough that the response for the render
 * which triggered the ask is on its way out first — the point is that the
 * decider is never on the request's critical path, not that the ask is
 * instant. */
const LEAN_ASK_DELAY_MS = 50;

/**
 * Ask the decider which option on a card is likely right, off the request
 * path — after this turn of the event loop, never inside it — and remember
 * the answer keyed to the head it was about. A rule's answer is not worth
 * remembering: it is what the page would have shown anyway.
 */
function scheduleLean(ctx: Ctx, d: Decision, decider: Decider): void {
  const head = headOf(d);
  const key = `${d.id}@${head}`;
  if (leanInFlight.has(key)) return;
  const options = Object.keys(CARD_OPTIONS[d.kind]);
  const state = {
    card: d.kind,
    head,
    repository: `${d.repo.ownerName}/${d.repo.name}`,
    situation: d.says,
    ...(d.pull === undefined
      ? {}
      : { change: d.pull.title, description: d.pull.body.slice(0, 800) }),
  };
  const asked = new Promise<void>((resolve) => {
    setTimeout(() => {
      decideOr(
        decider,
        state,
        {
          option: {
            options,
            about: "Which of these a careful owner of the app would pick.",
            describe: CARD_OPTIONS[d.kind],
          },
        },
        () => ({ option: certain(options, options[0]!) }),
      )
        .then((decided) => {
          if (decided.by === "rule") return;
          recordDecision(ctx.app.db, {
            kind: "lean",
            repoId: d.repo.id,
            issueId: d.pull?.id,
            state,
            answer: decided.answers.option.choice,
            p: decided.answers.option.p,
            by: decided.by,
            ms: decided.ms,
          });
        })
        .catch((error) =>
          log.warn("lean not recorded", { id: d.id, error: String(error) }),
        )
        .finally(() => {
          leanInFlight.delete(key);
          resolve();
        });
    }, LEAN_ASK_DELAY_MS);
  });
  leanInFlight.set(key, asked);
}

/** Test hook: every ask scheduled so far, answered or not. The page itself
 * never waits on this — only a test that wants the next render to have it. */
export function pendingLeans(): Promise<unknown> {
  return Promise.allSettled([...leanInFlight.values()]);
}

/**
 * Every card with the lean already known about it, read with no wait; a
 * card whose lean is unknown, or whose head has moved past the one it was
 * asked about, is asked for off the request path (`scheduleLean`) so a
 * later render has it. A forge with no decider does nothing here, exactly
 * as before.
 */
export function withLikely(
  ctx: Ctx,
  decisions: readonly Decision[],
): Decision[] {
  const decider = ctx.app.config.decider;
  if (decider === undefined) return [...decisions];
  return decisions.map((d) => {
    const lean = latestLean(
      ctx.app.db,
      d.repo.id,
      d.pull?.id ?? null,
      d.kind,
      headOf(d),
    );
    if (lean === undefined) {
      scheduleLean(ctx, d, decider);
      return d;
    }
    return { ...d, likely: { option: lean.answer, p: lean.p } };
  });
}
/** The variant a card's button takes: primary when the decider leans to it. */
export function leanVariant(
  d: Decision,
  option: string,
  fallback: "primary" | undefined,
): { variant?: "primary" } {
  const variant =
    d.likely === undefined
      ? fallback
      : d.likely.option === option
        ? "primary"
        : undefined;
  return variant === undefined ? {} : { variant };
}

/** A word beside the leaned-to option: how sure, in plain terms. */
export function leanNote(d: Decision, option: string): Html | null {
  if (d.likely === undefined || d.likely.option !== option) return null;
  const sure =
    d.likely.p >= 0.85 ? "likely" : d.likely.p >= 0.6 ? "probably" : "maybe";
  return html`<span
    class="muted small studio-lean"
    title="${Math.round(d.likely.p * 100)}% by the decider"
    >${sure}</span
  >`;
}
