/**
 * Atlas in the terminal (#439): the door `POST …/atlas` has on the API. The
 * plan is typed or pasted as the same JSON body (`{"plan": …, "pillar": …}`);
 * ctrl+d shows the issues it would open (the dry run), and ctrl+d again on
 * the same plan opens them through `confirmBusinessPlan`, the path the API
 * takes — so the gate, the duplicate check and the bus events that keep web
 * viewers live are one code path. Offered to whoever may plan here.
 */

import {
  ATLAS_BODY_MAX,
  businessItems,
  checkPillar,
  confirmBusinessPlan,
  parseBusinessPlan,
  stampOf,
  type Confirmed,
} from "../../actions/business_plan.ts";
import type { PlanItem } from "../../actions/plan.ts";
import { isCrew } from "../../core/agents.ts";
import { canRead, canWrite, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { Textarea } from "../ui/textarea.ts";
import { card } from "../ui/widgets.ts";

/** Who may plan here: as the API's confirm decides it. */
export function mayPlan(f: Session, repo: Repo): boolean {
  const u = f.user;
  if (u === undefined || !canRead(f.db, repo, u)) return false;
  return canWrite(f.db, repo, u) || isCrew(f.db, repo.id, u.id);
}

export type AtlasStep =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "preview"; readonly stamp: string; readonly items: PlanItem[] }
  | { readonly kind: "done"; readonly result: Confirmed };

/**
 * One ctrl+d: `text` checked as the API checks its body, then previewed —
 * or, when it is the plan just previewed (`previewed` is its stamp), confirmed.
 */
export function atlasStep(f: Session, repo: Repo, text: string, previewed?: string): AtlasStep {
  if (!mayPlan(f, repo)) return { kind: "error", message: "you need write access to plan here" };
  if (new TextEncoder().encode(text).length > ATLAS_BODY_MAX)
    return { kind: "error", message: `a plan is at most ${ATLAS_BODY_MAX} bytes` };
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { kind: "error", message: "not JSON: the body is {\"plan\": {…}, \"pillar\": \"…\"}" };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { kind: "error", message: "the body is an object: {\"plan\": {…}}" };
  const body = input as Record<string, unknown>;
  const plan = parseBusinessPlan(body["plan"]);
  if (!plan.ok) return { kind: "error", message: plan.error.message };
  const served = checkPillar(f.app, repo, body["pillar"]);
  if (!served.ok) return { kind: "error", message: served.error.message };
  const stamp = stampOf(plan.value);
  if (previewed !== stamp) return { kind: "preview", stamp, items: businessItems(plan.value, served.value) };
  const done = confirmBusinessPlan(f.app, f.user, repo, plan.value, served.value);
  return done.ok ? { kind: "done", result: done.value } : { kind: "error", message: done.error.message };
}

/** What a confirm did, in one line. */
export function confirmedLine(r: Confirmed): string {
  switch (r.status) {
    case "opened":
      return `opened ${r.opened.map((o) => `#${o.number}`).join(" ")}`;
    case "already":
      return `already opened: ${r.numbers.map((n) => `#${n}`).join(" ")}`;
    case "already-proposed":
      return "already proposed: it waits for a nod";
    default:
      return "proposed: it waits for a nod";
  }
}

const TEMPLATE = `{
  "plan": {
    "description": "",
    "apps": [{ "slug": "", "purpose": "" }],
    "adapters": [{ "system": "", "data": "" }],
    "edges": []
  }
}`;

export function atlasScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let editor = new Textarea(TEMPLATE);
  let step: AtlasStep | undefined;

  const submit = (): void => {
    const previewed = step?.kind === "preview" ? step.stamp : undefined;
    step = atlasStep(f, repo, editor.value, previewed);
    if (step.kind === "error") ctx.toast(step.message, "danger");
    if (step.kind === "done") ctx.toast(confirmedLine(step.result), "success");
  };

  const lines = (): string[] => {
    if (step === undefined) return ["ctrl+d shows the issues this plan would open; nothing opens yet."];
    if (step.kind === "error") return [step.message];
    if (step.kind === "done") return [confirmedLine(step.result)];
    const titleOf = new Map(step.items.map((i) => [i.key, i.title]));
    return [
      `Dry run: ${step.items.length} issues. ctrl+d again opens them; any edit previews again.`,
      ...step.items.map((i) =>
        i.blockedBy.length === 0
          ? `· ${i.title}`
          : `· ${i.title}  (waits for ${i.blockedBy.map((k) => titleOf.get(String(k)) ?? String(k)).join(", ")})`,
      ),
    ];
  };

  return {
    title: `Atlas plan · ${repo.ownerName}/${repo.name}`,
    keys: [binding(["ctrl+d"], "preview, then open"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const shown = lines();
      const [top, rest] = split(area, "v", [fill(1), len(Math.min(shown.length, 10) + 2)]);
      const inner = card(s, top!, c, { title: "Plan (JSON, as the API takes it)", footer: "ctrl+d", focused: true });
      ctx.setCursor(editor.render(s, inner, c, true));
      const out = card(s, rest!, c, { title: step?.kind === "preview" ? "Would open" : "Atlas" });
      const tone = step?.kind === "error" ? c.danger : c.mutedFg;
      shown.slice(0, out.h).forEach((t, i) => {
        s.text(out.x, out.y + i, truncate(t, out.w), style(i === 0 ? tone : c.fg, c.card), out.x + out.w);
      });
    },
    paste(text) {
      // A plan pasted over the untouched template takes its place.
      if (editor.value === TEMPLATE) editor = new Textarea(text);
      else editor.paste(text);
      if (step?.kind === "preview") step = undefined;
      return true;
    },
    key(e) {
      const before = editor.value;
      const out = editor.key(e);
      if (out === "submit") {
        submit();
        return true;
      }
      if (out === "cancel") return false;
      if (editor.value !== before && step?.kind === "preview") step = undefined;
      return out !== "ignored";
    },
  };
}

/** The per-repository command: offered to whoever may plan here. */
export function atlasCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !mayPlan(f, repo)) return [];
  return [
    {
      id: "atlas-plan",
      title: `${repo.ownerName}/${repo.name} — Atlas plan`,
      hint: "a business as apps and adapters, opened as issues",
      run: () => ctx.push(atlasScreen(f, ctx, repo)),
    },
  ];
}
