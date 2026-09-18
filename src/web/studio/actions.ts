/**
 * Every POST the studio makes: a sentence told to the crew, a green change
 * shipped, a word said back, one decision taken for several asks at once,
 * and the switch between studio and dev. None of it is a second system —
 * each calls the same action a person would reach by hand (`actions/*`) with
 * the same access checks, reads its form through `readForm` (the `rw` scope
 * floor and the same-origin check with it), and answers with a flash on the
 * page that sent them, or JSON when the asks panel asked in place.
 */

import { addComment, setIssueStateThrough } from "../../actions/issues.ts";
import { tellCrew } from "../../actions/crew.ts";
import { mergePull } from "../../actions/pulls.ts";
import { getPull } from "../../core/pulls.ts";
import { bringUpToDate } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import {
  loadRepo,
  notFoundPage,
  repoBase,
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { flashOrJson, flashTo, redirect } from "../layout.ts";
import { isMode, modeCookie } from "../mode.ts";
import { BULK, decisionsFor, isBulkAction, takes } from "./asks.ts";
import { appsOf } from "./home.ts";

/** A merge refusal in a person's words. */
function mergeWords(error: unknown): string {
  if (typeof error === "string") return error.replace(/_/g, " ");
  if (typeof error === "object" && error !== null && "kind" in error) {
    const e = error as { kind: string; message?: string };
    if (e.kind === "git") return `git said ${e.message ?? "no"}`;
    return e.kind.replace(/_/g, " ");
  }
  return String(error);
}

/** POST /:owner/:name/tell  { text } — a sentence becomes work. */
export async function tellSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const text = field(form, "text").trim();
  if (text === "")
    return flashTo(ctx, base, {
      tone: "danger",
      message: "Say something first.",
    });
  const told = await tellCrew(ctx.app, ctx.auth.user, repo, text);
  if (!told.ok)
    return flashTo(ctx, base, {
      tone: "danger",
      message: "That could not be told.",
    });
  const { routed } = told.value;
  if (routed === undefined)
    return flashTo(ctx, base, {
      message: `Told. Nobody is on the crew to take it yet — add someone under Settings → Crew.`,
    });
  const builder = routed.builder;
  return flashTo(ctx, base, {
    message: `${builder.user.username} is on it — ${routed.size} ${routed.kind}${routed.by === "rule" ? "" : `, ${routed.by} decided in ${routed.ms} ms`}. Watch it work below.`,
  });
}

/** POST /:owner/:name/pulls/:number/ship — land a green change. */
export async function shipSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const number = Number(ctx.params.number);
  const pull = Number.isInteger(number)
    ? getPull(ctx.app.db, repo.id, number)
    : undefined;
  if (!pull) return notFoundPage(ctx);
  const merged = await mergePull(ctx.app, ctx.auth.user, repo, pull, "squash");
  // A conflict is never the person's to fix: the pull's agent brings the
  // branch up to date, and the pull comes back green, or lands on its own.
  if (
    !merged.ok &&
    typeof merged.error !== "string" &&
    merged.error.kind === "conflict"
  ) {
    const who = bringUpToDate(ctx.app, repo, pull, merged.error.files);
    return flashOrJson(ctx, base, {
      tone: "danger" as const,
      message:
        who === undefined
          ? `It conflicts with main (${merged.error.files.join(", ")}) and the crew has already tried its limit; say what to do on the pull.`
          : `It conflicts with main (${merged.error.files.join(", ")}); ${who} is bringing it up to date${repo.autonomy === "autonomous" ? ", then it lands on its own" : ", then it comes back to you"}.`,
    });
  }
  return flashOrJson(ctx, base, {
    ...(merged.ok
      ? { message: `Shipped "${pull.title}". Production is redeploying.` }
      : {
          tone: "danger" as const,
          message: `That could not ship: ${mergeWords(merged.error)}.`,
        }),
  });
}

/** POST /:owner/:name/pulls/:number/say  { text } — feedback to the crew. */
export async function saySubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const number = Number(ctx.params.number);
  const pull = Number.isInteger(number)
    ? getPull(ctx.app.db, repo.id, number)
    : undefined;
  if (!pull) return notFoundPage(ctx);
  const text = field(form, "text").trim();
  if (text === "")
    return flashTo(ctx, base, {
      tone: "danger",
      message: "Say something first.",
    });
  const said = addComment(ctx.app, ctx.auth.user, repo, pull, text);
  return flashOrJson(ctx, base, {
    ...(said.ok
      ? { message: `Told ${pull.authorName}. It picks the change back up.` }
      : { tone: "danger" as const, message: "That could not be said." }),
  });
}

/**
 * POST /studio/asks  { ask*, action, back } — one decision for several asks.
 * Each is the same act as its row's own button. An ask that is gone, or
 * never took this action, is skipped and counted, never guessed at.
 */
export async function asksSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const back = backTo(ctx, field(form, "back"));
  const action = field(form, "action");
  const picked = [
    ...new Set(
      form.getAll("ask").filter((v): v is string => typeof v === "string"),
    ),
  ];
  if (!isBulkAction(action) || picked.length === 0)
    return flashOrJson(ctx, back, {
      tone: "danger",
      message: "Pick some asks, and what to do with them.",
    });
  // The asks as they stand now, not as the page had them.
  const asks = new Map(
    decisionsFor(ctx, appsOf(ctx, user).repos).map((d) => [d.id, d]),
  );
  const done: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const id of picked) {
    const d = asks.get(id);
    if (d?.pull === undefined || !takes(d, action)) {
      skipped.push(id);
      continue;
    }
    const r =
      action === "ship"
        ? await mergePull(ctx.app, user, d.repo, d.pull, "squash")
        : await setIssueStateThrough(ctx.app, user, d.repo, d.pull, "closed");
    (r.ok ? done : failed).push(id);
  }
  const tally = [`${BULK[action].done} ${done.length}`];
  if (skipped.length > 0) tally.push(`skipped ${skipped.length}`);
  if (failed.length > 0) tally.push(`could not ${action} ${failed.length}`);
  return flashOrJson(
    ctx,
    back,
    {
      ...(done.length === 0 ? { tone: "danger" as const } : {}),
      message: tally.join(" · "),
    },
    { done, skipped, failed },
  );
}

/** Where a form sends a person back: what it said, else the referer, else
 * home — and never off this forge. */
function backTo(ctx: Ctx, said: string): string {
  const back = said || ctx.request.headers.get("referer") || "/";
  return (back.startsWith("/") && !back.startsWith("//")) ||
    back.startsWith(`${ctx.url.origin}/`)
    ? back
    : "/";
}

/** POST /mode  { mode } — studio or dev, for this browser. */
export async function modeSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const choice = field(form, "mode");
  const secure = ctx.url.protocol === "https:";
  return redirect(
    backTo(ctx, field(form, "back")),
    modeCookie(isMode(choice) ? choice : undefined, secure),
  );
}
