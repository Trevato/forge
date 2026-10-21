/**
 * One stage of a job in flight, drawn as §5's list row with a badge for its
 * state. The migrate page, the mirror page and the live update's script all
 * write this one shape: `[data-stage-name][data-state]` on the `<li>`, the
 * state's `.badge` in `.row-trail`, the job's own words in `.row-meta`.
 */
import { html, type Html } from "./html.ts";
import { badge, row, type Tone } from "./ui.ts";

export type StageState = "done" | "now" | "todo" | "failed";

/** What the badge says and how it is toned, by state. The live-update
 * scripts are built from this one table (`STAGE_BADGE_JS`). */
export const STAGE_BADGE: Record<StageState, { text: string; tone: Tone; variant: string }> = {
  done: { text: "Done", tone: "success", variant: "success" },
  now: { text: "Running", tone: "attn", variant: "attn" },
  failed: { text: "Failed", tone: "danger", variant: "danger" },
  todo: { text: "Waiting", tone: "default", variant: "outline" },
};

/** Where one stage stands, given the job's stage (and, once it failed, the
 * stage it failed on). `order` is the stages as this job lists them. */
export function stageStateFor(
  order: readonly string[],
  name: string,
  stage: string,
  failedAt?: string,
): StageState {
  const here = order.indexOf(name);
  const at = order.indexOf(stage === "failed" ? (failedAt ?? "") : stage);
  if (at < 0) return "todo";
  if (here < at) return "done";
  if (here > at) return "todo";
  return stage === "failed" ? "failed" : stage === "done" ? "done" : "now";
}

export function stageRow(o: {
  name: string;
  label: string;
  state: StageState;
  detail: string;
}): Html {
  const b = STAGE_BADGE[o.state];
  return row({
    title: o.label,
    meta: html`${o.state === "now" ? o.detail : ""}`,
    metaSlot: true,
    trail: badge(b.text, { tone: b.tone, variant: "outline" }),
    data: { "stage-name": o.name, state: o.state },
  });
}

/** The table as a JS literal for the scripts, `{done:["Done","success"],…}`. */
export const STAGE_BADGE_JS = JSON.stringify(
  Object.fromEntries(
    Object.entries(STAGE_BADGE).map(([k, b]) => [k, [b.text, b.tone === "default" ? b.variant : b.tone]]),
  ),
);
