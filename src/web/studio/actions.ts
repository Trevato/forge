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
import { addComment } from "../../actions/issues.ts";
import { parseFrom } from "../../actions/tell_from.ts";
import { SENT_WORDS, tell, toldWords, TOO_LONG_WORDS } from "../../actions/tell.ts";
import { contextNote, parseContext } from "../../actions/tell_context.ts";
import { NOT_TOLD_FROM_WORDS, NOT_TOLD_WORDS, SAY_SOMETHING_WORDS } from "../../actions/tell_words.ts";
import { keepThought } from "../../actions/thought.ts";
import { DIRECTION_NOTE } from "../../crew/direct.ts";
import { mergePull } from "../../actions/pulls.ts";
import { revertPull } from "../../actions/revert.ts";
import { takeBackWords } from "../../actions/revert_words.ts";
import { getPull } from "../../core/pulls.ts";
import { canRead, getRepo, type Repo } from "../../core/repos.ts";
import { bringUpToDate } from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, signInFirst } from "../chrome.ts";
import { teamHoldRefusal } from "../../core/teams_words.ts";
import { guardedRefusal } from "../../crew/stranger.ts";
import type { Guarded } from "../../core/pulls.ts";
import { backTo, field, readForm, type Form } from "../form.ts";
import { html } from "../html.ts";
import { flashOrJson, flashTo, page } from "../layout.ts";
import { FORGE_TARGET } from "./feed.ts";
import { changeHref } from "./nouns.ts";

/** A merge refusal in a person's words. */
function mergeWords(error: unknown): string {
  if (typeof error === "string") return error.replace(/_/g, " ");
  if (typeof error === "object" && error !== null && "kind" in error) {
    const e = error as { kind: string; message?: string };
    if (e.kind === "git") return `git said ${e.message ?? "no"}`;
    if (e.kind === "guarded") return guardedRefusal((error as unknown as { paths: readonly Guarded[] }).paths);
    if (e.kind === "team_review_required")
      return teamHoldRefusal((error as unknown as { teams: readonly string[] }).teams);
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
  // The page the tell was said on; a path that is not ours is no `from`,
  // and so is never somewhere to send the person back to.
  const from = parseFrom(field(form, "from") || undefined) ?? null;
  if (from !== null) back = from;
  if (text === "")
    return flashOrJson(ctx, back, {
      tone: "danger",
      message: SAY_SOMETHING_WORDS,
    });
  const told = await tell(ctx.app, ctx.auth.user, repo, text, 1, from);
  if (!told.ok && told.error === "body_too_long")
    return flashOrJson(ctx, back, {
      tone: "danger",
      message: TOO_LONG_WORDS,
    });
  if (!told.ok)
    return flashOrJson(ctx, back, {
      tone: "danger",
      message:
        told.error === "forbidden"
          ? DIRECTION_NOTE
          : told.error === "unverified"
            ? "Verify your email first."
            : NOT_TOLD_WORDS,
    });
  const { routed } = told.value;
  // A client's "Ask for something" (named by the form, not guessed from `/`):
  // they asked for something and want nothing more than to know it went.
  if (from === "/" && field(form, "ask") === "1") return flashOrJson(ctx, back, { message: SENT_WORDS });
  // The tell's own page, for a caller that asked for JSON (the palette's row).
  const at = { href: `${repoBase(repo)}/issues/${told.value.issue.number}` };
  if (routed === undefined)
    return flashOrJson(
      ctx,
      back,
      {
        message: `Opened as an issue. Nobody is on the crew to take it yet — add someone under Settings → Crew.`,
      },
      at,
    );
  const builder = routed.builder;
  return flashOrJson(
    ctx,
    back,
    {
      message: `${builder.user.username} is on it — ${routed.size} ${routed.kind}${routed.by === "rule" ? "" : `, ${routed.by} decided in ${routed.ms} ms`}.${from === null ? " Watch it work below." : ""}`,
    },
    at,
  );
}

/** POST /:owner/:name/tell  { text } — a sentence becomes work. */
export async function tellSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (field(form, "page") !== "") return tellFromPage(ctx, repo, form);
  return tellFrom(ctx, repo, form, repoBase(repo));
}

/**
 * A tell from the forge toolbar of an app's page: the same `tell()`, with
 * the page it was said on (and the pull, on a preview) written into the
 * tell, answered with a receipt that links to the issue it opened.
 */
async function tellFromPage(ctx: Ctx, repo: Repo, form: Form): Promise<Response> {
  const pull = field(form, "pull");
  const where = parseContext({
    page: field(form, "page"),
    ...(pull === "" ? {} : { pull: /^\d{1,9}$/.test(pull) ? Number(pull) : -1 }),
  });
  // A refusal sends the person back to the box with their words, the page
  // and the pull kept, so they can retry.
  const keep = new URLSearchParams({ text: field(form, "text").slice(0, 1000) });
  if (where?.page !== undefined) keep.set("page", where.page);
  if (where?.pull !== undefined) keep.set("pull", String(where.pull));
  const back = `${repoBase(repo)}/tell?${keep}`;
  if (where === null || where === undefined)
    return flashTo(ctx, back, { tone: "danger", message: NOT_TOLD_FROM_WORDS });
  const text = field(form, "text").trim();
  if (text === "") return flashTo(ctx, back, { tone: "danger", message: SAY_SOMETHING_WORDS });
  const told = await tell(ctx.app, ctx.auth.user, repo, `${text}${contextNote(where)}`);
  if (!told.ok)
    return flashTo(ctx, back, {
      tone: "danger",
      message:
        told.error === "forbidden"
          ? DIRECTION_NOTE
          : told.error === "unverified"
            ? "Verify your email first."
            : told.error === "body_too_long"
              ? TOO_LONG_WORDS
              : NOT_TOLD_WORDS,
    });
  const issue = `${repoBase(repo)}/issues/${told.value.issue.number}`;
  return page({
    ctx,
    title: `Issue opened · ${repo.name}`,
    crumbs: crumbsFor(repo),
    body: html`${pageHead("Issue opened")}
      <p>${toldWords(told.value)}</p>
      <p><a href="${issue}" data-receipt>See issue #${String(told.value.issue.number)}</a></p>`,
  });
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
  const target = field(form, "app");
  // The feed's composer asks to come back to the feed; any other box, to home.
  const home = backTo(form, "/");
  // "the forge" is no app: the words are kept as a thought, exactly as typed.
  if (target === FORGE_TARGET) {
    if (field(form, "text").trim() === "")
      return flashOrJson(ctx, home, { tone: "danger", message: SAY_SOMETHING_WORDS });
    const kept = keepThought(ctx.app, ctx.auth.user, field(form, "text"), "composer");
    return flashOrJson(
      ctx,
      home,
      kept.ok
        ? { message: "Received." }
        : {
            tone: "danger",
            message:
              kept.error === "too_long" ? "That is too long to keep." : "That could not be kept.",
          },
      { href: home },
    );
  }
  const [owner = "", name = "", ...extra] = target.split("/");
  const repo = extra.length === 0 ? getRepo(ctx.app.db, owner, name) : undefined;
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFoundPage(ctx);
  return tellFrom(ctx, repo, form, home);
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
  // The inbox and the feed say where they were; the pull page does not.
  const back = backTo(form, changeHref(base, pull.number));
  const merged = await mergePull(ctx.app, ctx.auth.user, repo, pull, "squash");
  // A conflict is never the person's to fix: the pull's agent brings the
  // branch up to date, and the pull comes back green, or lands on its own.
  if (
    !merged.ok &&
    typeof merged.error !== "string" &&
    merged.error.kind === "conflict"
  ) {
    const who = bringUpToDate(ctx.app, repo, pull, merged.error.files);
    return flashOrJson(ctx, back, {
      tone: "danger" as const,
      message:
        who === undefined
          ? `It conflicts with main (${merged.error.files.join(", ")}) and the crew has already tried its limit; say what to do on the pull.`
          : `It conflicts with main (${merged.error.files.join(", ")}); ${who} is bringing it up to date${repo.autonomy === "autonomous" ? ", then it lands on its own" : ", then it comes back to you"}.`,
    });
  }
  return flashOrJson(ctx, back, {
    ...(merged.ok
      ? {
          message: `Shipped #${pull.number}`,
          link: { href: `${base}/app/production/open`, label: "see it live" },
        }
      : {
          tone: "danger" as const,
          message: `That could not ship: ${mergeWords(merged.error)}.`,
        }),
  });
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
      message: SAY_SOMETHING_WORDS,
    });
  const said = addComment(ctx.app, ctx.auth.user, repo, pull, text);
  return flashOrJson(ctx, base, {
    ...(said.ok
      ? { message: `Told ${pull.authorName}. It picks the pull request back up.` }
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
    false,
    field(form, "until") === "green" ? "green" : undefined,
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

