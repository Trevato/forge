/**
 * Every POST the studio makes: a sentence told to the crew, a green change
 * shipped, a word said back, one decision taken for several asks at once,
 * and the switch between studio and dev. None of it is a second system —
 * each calls the same action a person would reach by hand (`actions/*`) with
 * the same access checks, reads its form through `readForm` (the `rw` scope
 * floor and the same-origin check with it), and answers with a flash on the
 * page that sent them, or JSON when the asks panel asked in place.
 */

import { mayView } from "../../core/sealed.ts";
import { holdPull, releasePull } from "../../actions/holds.ts";
import { addComment, setIssueStateThrough } from "../../actions/issues.ts";
import { tell } from "../../actions/tell.ts";
import { DIRECTION_NOTE } from "../../crew/direct.ts";
import { mergePull } from "../../actions/pulls.ts";
import { revertPull, type RevertPullError } from "../../actions/revert.ts";
import { getPull } from "../../core/pulls.ts";
import { canRead, getRepo, type Repo } from "../../core/repos.ts";
import { bringUpToDate } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { flashOrJson, flashTo, redirect } from "../layout.ts";
import { isMode, modeCookie } from "../mode.ts";
import { changeHref } from "./nouns.ts";

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

/**
 * One tell, two doors: the sentence becomes work on `repo`, and the person
 * lands back on `back` with the one tell's own answer — refused as the
 * crew's direction says, or for an unverified email, or told.
 */
async function tellFrom(
  ctx: Ctx,
  repo: Repo,
  form: Form,
  back: string,
): Promise<Response> {
  const text = field(form, "text").trim();
  if (text === "")
    return flashTo(ctx, back, {
      tone: "danger",
      message: "Say something first.",
    });
  const told = await tell(ctx.app, ctx.auth.user, repo, text);
  if (!told.ok)
    return flashTo(ctx, back, {
      tone: "danger",
      message:
        told.error === "forbidden"
          ? DIRECTION_NOTE
          : told.error === "unverified"
            ? "Verify your email first."
            : "That could not be told.",
    });
  const { routed } = told.value;
  if (routed === undefined)
    return flashTo(ctx, back, {
      message: `Told. Nobody is on the crew to take it yet — add someone under Settings → Crew.`,
    });
  const builder = routed.builder;
  return flashTo(ctx, back, {
    message: `${builder.user.username} is on it — ${routed.size} ${routed.kind}${routed.by === "rule" ? "" : `, ${routed.by} decided in ${routed.ms} ms`}. Watch it work below.`,
  });
}

/** POST /:owner/:name/tell  { text } — a sentence becomes work. */
export async function tellSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  return tellFrom(ctx, repo, form, repoBase(repo));
}

/**
 * POST /tell  { app, text } — the home's composer without a script: the
 * same tell, to the app the form names (`owner/name`), and back to the home.
 * A repository the viewer cannot read is the answer one that does not exist
 * gives.
 */
export async function composerSubmit(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const [owner = "", name = "", ...extra] = field(form, "app").split("/");
  const repo = extra.length === 0 ? getRepo(ctx.app.db, owner, name) : undefined;
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFoundPage(ctx);
  return tellFrom(ctx, repo, form, "/");
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
  if (!pull || !mayView(ctx.app.db, repo, pull, ctx.auth.user))
    return notFoundPage(ctx);
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

/** A take-back refusal in the studio's words. */
function takeBackWords(error: RevertPullError): string {
  if (typeof error === "string") {
    switch (error) {
      case "not_shipped":
        return "it has not shipped";
      case "mirrored":
        return "the origin owns this history";
      case "already_reverted":
        return "it has already been taken back";
      case "unauthorized":
        return "sign in first";
      case "forbidden":
        return "only a person can take a change back";
      case "not_found":
        return "that change was not found";
    }
  }
  switch (error.kind) {
    case "conflict":
      return `it conflicts with the current code in ${error.files.join(", ")}`;
    case "unsafe":
      return "git refused it";
    case "base_moved":
      return "the base moved under it";
    case "git":
      return `git said ${error.message}`;
    case "octopus":
      return "it has more than two parents";
    case "branch_failed":
      return `it could not be made ready (${error.reason})`;
    case "pull_failed":
      return `the change could not be opened (${error.reason})`;
  }
}

/**
 * POST /:owner/:name/pulls/:number/take-back — open a new change that
 * undoes exactly what a shipped one merged. Never touches the default
 * branch itself (`revertPull` does the computing); this only calls it and
 * says the result in the studio's words.
 */
export async function takeBackSubmit(ctx: Ctx): Promise<Response> {
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
  if (!pull || !mayView(ctx.app.db, repo, pull, ctx.auth.user))
    return notFoundPage(ctx);
  const reverted = await revertPull(ctx.app, ctx.auth.user, repo, pull);
  if (!reverted.ok)
    return flashOrJson(ctx, `${base}/pulls/${pull.number}`, {
      tone: "danger",
      message: `That could not be taken back: ${takeBackWords(reverted.error)}.`,
    });
  return flashOrJson(ctx, `${base}/pulls/${reverted.value.number}`, {
    message: `Opened "${reverted.value.title}" — ship it to take "${pull.title}" back.`,
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
  if (!pull || !mayView(ctx.app.db, repo, pull, ctx.auth.user))
    return notFoundPage(ctx);
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

/** The change a hold form is about, and where its answer shows. */
function heldPull(ctx: Ctx, repo: Repo) {
  const number = Number(ctx.params.number);
  const pull = Number.isInteger(number)
    ? getPull(ctx.app.db, repo.id, number)
    : undefined;
  return pull === undefined || !mayView(ctx.app.db, repo, pull, ctx.auth.user)
    ? undefined
    : { pull, back: `${changeHref(repoBase(repo), pull.number)}#hold` };
}

/** POST /:owner/:name/pulls/:number/hold  { why } — not this one yet. */
export async function holdSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const found = heldPull(ctx, repo);
  if (!found) return notFoundPage(ctx);
  const held = holdPull(
    ctx.app,
    ctx.auth.user,
    repo,
    found.pull,
    field(form, "why"),
  );
  if (!held.ok && (held.error === "not_found" || held.error === "forbidden"))
    return notFoundPage(ctx);
  return flashTo(ctx, found.back, {
    ...(held.ok
      ? {
          message: "Held. No rule reviews or lands it until it is released.",
        }
      : {
          tone: "danger" as const,
          message:
            held.error === "not_open"
              ? "Only an open change can be held."
              : held.error === "why_too_long"
                ? "Say why in one line, a shorter one."
                : "Say why, in one line.",
        }),
  });
}

/** POST /:owner/:name/pulls/:number/release — let a held change go. */
export async function releaseSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const found = heldPull(ctx, repo);
  if (!found) return notFoundPage(ctx);
  const released = releasePull(ctx.app, ctx.auth.user, repo, found.pull);
  if (!released.ok) return notFoundPage(ctx);
  return flashTo(ctx, found.back, {
    message: released.value
      ? "Released. The rules take it from here."
      : "Nothing was holding it.",
  });
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
