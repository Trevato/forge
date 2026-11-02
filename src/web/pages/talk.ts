/**
 * /talk (#7652): the person's one conversation with the forge, on a page.
 * The history and the composer are server-rendered; a reply streams in over
 * `http/sse.ts` as it is written, each turn drawn by the same function the
 * first paint uses. A stream ends with the turn (or after `STREAM_MS`, well
 * inside the edge's timeout) and the client reconnects from the last turn id
 * it saw. A held action draws Confirm and Cancel buttons; Confirm is the
 * existing yes (`actions/conversation_confirms.ts`), Cancel is the no.
 * Edit and Regenerate are drawn by the script on the last message and reply;
 * a failed turn says in plain words what happened and carries Retry, a plain
 * form. What they replace stays in the log, marked (#8817).
 *
 * Everything is the signed-in person's own: the conversation is found by
 * their id, the agent acts with their permissions (`crew/conversation.ts`).
 */

import type { Database } from "bun:sqlite";
import { TALK_WORDS, talk, talkAgain } from "../../actions/talk.ts";
import { REFUSED, sayNo, sayYes, waitingConfirms } from "../../actions/conversation_confirms.ts";
import { DEFAULT_PAGE, lastExchange, listTurns, MAX_PAGE, openConversation, turnsAfter, type Turn } from "../../core/conversations.ts";
import { contextOf, contextText, dollars, turnCosts, type Context } from "../../core/conversation_cost.ts";
import { WORDS_MAX } from "../../core/fence.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { ASKING } from "../../crew/conversation_confirm.ts";
import { turnRunning, type RedoHow } from "../../crew/conversation.ts";
import type { Ctx } from "../../http/context.ts";
import { json } from "../../http/respond.ts";
import { eventStream } from "../../http/sse.ts";
import { signInFirst, forbiddenPage } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { btn, time } from "../ui.ts";
import { talkCss, talkJs } from "./talk_client.ts";

/** A stream lasts this long at most; the client reconnects from its last turn id. */
export const STREAM_MS = 40_000;
/** How often a stream looks for a turn the agent has written. */
export const POLL_MS = 400;
/** Streams one person may hold open at once; a fourth is told to wait. */
export const STREAMS_MAX = 3;
/** What a stream consults: how long it lasts and whether a turn runs. Tests move it; nothing else does. */
export const clock = { streamMs: STREAM_MS, running: turnRunning };
const open = new Map<string, number>();
const TURN_ID = /^[0-9a-z]{0,40}$/;
const HERE = "/talk";

const parse = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Confirm and Cancel for a held action; each its own form, so each posts alone. */
function confirmButtons(id: string, tool: string): Html {
  // A result shown once is drawn by Settings → Confirms, never kept in a turn.
  const once = ASKING[tool]?.once !== undefined;
  return html`<div class="bar">
    <form method="post" action="${once ? `/settings/confirms/${id}` : `${HERE}/confirm/${id}`}" ${once ? null : html`data-confirm`}>
      <input type="hidden" name="answer" value="yes" />
      ${btn("Confirm", { variant: "primary", icon: "check", label: `Confirm: ${tool}`, name: "answer", value: "yes" })}
    </form>
    <form method="post" action="${HERE}/confirm/${id}" data-confirm>
      ${btn("Cancel", { icon: "x", label: `Cancel: ${tool}`, name: "answer", value: "no" })}
    </form>
  </div>`;
}

/** Who said it and when, with the copy button: the line under a message. */
const meta = (who: string, at: string): Html =>
  html`<p class="talk-meta small muted">${who} · ${time(at)}</p>`;

/** A tool call or its outcome as a quiet card: closed, the name alone; open, the whole line. */
const toolCard = (id: string, says: string, name: string, at: string, set = ""): Html =>
  html`<li class="talk-turn talk-tool${set}" id="${id}"><details><summary>${name.slice(0, 60)} <span class="talk-when">${time(at)}</span></summary><p>${says}</p></details></li>`;

/** What an empty chat offers to start with; each is a link that fills the composer (`?q=`), so it works without the script. */
const SUGGESTIONS = ["What needs my attention?", "What did the crew do today?", "Show me my apps"] as const;

/** Ask again as a form, so it works without the script; the script only enhances it. */
const againForm = (how: "regenerate" | "retry", label: string, words: string): Html =>
  html`<form method="post" action="${HERE}/again/${how}" data-again="${how}">${btn(label, { icon: "sync", label: words })}</form>`;

/**
 * What the last exchange offers, by the turn it sits under: Edit under the
 * person's last message, and under the last turn Retry when it failed or
 * Regenerate when it is a reply. Nothing while a turn runs.
 */
export function exchangeActs(db: Database, userId: string, conversationId: string, running: boolean): Map<string, Html> {
  const acts = new Map<string, Html>();
  if (running) return acts;
  const { person, after } = lastExchange(db, userId, conversationId);
  if (person === undefined) return acts;
  acts.set(person.id, html`<a class="btn talk-act" href="${HERE}?edit=1#compose" data-act="edit" aria-label="Edit your last message">Edit</a>`);
  const last = after.at(-1);
  if (last?.failed === true) acts.set(last.id, againForm("retry", "Retry", "Retry the failed turn"));
  else if (last?.role === "agent") acts.set(last.id, againForm("regenerate", "Regenerate", "Regenerate the last reply"));
  return acts;
}

/** How full the context is, one quiet line above the log; always drawn so a finished run can fill it. */
const contextLine = (c: Context | undefined): Html =>
  html`<p class="talk-context small muted" data-context ${c === undefined ? html`hidden` : null}>${c === undefined ? "" : contextText(c)}</p>`;

/** The cost line under a reply. */
const costLine = (usd: number): Html => html`<p class="talk-cost small muted">${dollars(usd)} this turn</p>`;

/** One turn as the page and the stream both draw it; `waiting` is the confirms still open. */
export function turnHtml(turn: Turn, waiting: ReadonlySet<string>, cost?: number, act?: Html): Html {
  const id = `t-${turn.id}`;
  const set = turn.replaced ? " talk-replaced" : "";
  const acts = act === undefined ? null : html`<div class="talk-acts">${act}</div>`;
  const label = (who: string): Html => meta(turn.replaced ? `${who} · replaced` : who, turn.createdAt);
  if (turn.role === "person")
    return html`<li class="talk-turn talk-person${set}" id="${id}">
      <div class="talk-body talk-plain">${turn.text}</div>
      ${label("You")}${acts}
    </li>`;
  if (turn.role === "agent" && turn.failed)
    return html`<li class="talk-turn talk-agent talk-failed${set}" id="${id}" role="alert">
      <div class="talk-body">${turn.text}</div>
      ${acts}
    </li>`;
  if (turn.role === "agent")
    return html`<li class="talk-turn talk-agent${set}" id="${id}">
      <div class="talk-body prose">${renderMarkdown(turn.text)}</div>
      ${label("Forge")}
      ${cost === undefined ? null : costLine(cost)}${acts}
    </li>`;
  const data = parse(turn.text);
  if (turn.role === "confirm") {
    const confirm = String(data?.["confirm"] ?? "");
    const tool = String(data?.["tool"] ?? "");
    return html`<li class="talk-turn talk-confirm${set}" id="${id}">
      <p>${String(data?.["does"] ?? turn.text)}</p>
      ${waiting.has(confirm) && !turn.replaced ? confirmButtons(confirm, tool) : html`<p class="muted small">Answered or past its ten minutes.</p>`}
    </li>`;
  }
  // A tool turn: the confirm's outcome as JSON, or the call the agent made as text.
  if (data !== undefined && "confirm" in data) {
    const tool = String(data["tool"] ?? "");
    const says = data["cancelled"] === true ? `Cancelled: ${tool}.` : data["done"] === true ? `Done: ${tool}.${typeof data["undo"] === "string" ? ` To undo: ${data["undo"]}.` : ""}` : `${tool} did not go through: ${String(data["message"] ?? data["error"] ?? "")}`;
    return toolCard(id, says, tool, turn.createdAt, set);
  }
  const call = turn.text.slice(0, 300);
  return toolCard(id, call, call.split(/[\s(:{]/, 1)[0] ?? "tool", turn.createdAt, set);
}

function talkPage(ctx: Ctx, before: string | undefined, prefill: string, edit: boolean): Response {
  const user = ctx.auth.user!;
  const conversation = openConversation(ctx.app.db, user.id);
  const listed = listTurns(ctx.app.db, user.id, conversation.id, {
    limit: DEFAULT_PAGE,
    ...(before === undefined ? {} : { before }),
  });
  const turns = listed.ok ? listed.value : [];
  const waiting = new Set(waitingConfirms(ctx, user).map((w) => w.id));
  const running = clock.running(ctx.app, user.id);
  const costs = turnCosts(ctx.app.db, conversation.id);
  const context = contextOf(ctx.app.db, conversation.id);
  // Paging back, the log ends before the newest turn: it does not follow.
  const last = turns.at(-1)?.id ?? "";
  const acts = before === undefined ? exchangeActs(ctx.app.db, user.id, conversation.id, running) : new Map<string, Html>();
  // Edit shows the composer holding the last message, posting to Edit instead of Send.
  const editing = edit ? lastExchange(ctx.app.db, user.id, conversation.id).person : undefined;
  const body = html`<div class="page-head"><h1>Talk</h1></div>
    <div class="talk" data-talk data-user="${user.id}" data-paged="${before === undefined ? "0" : "1"}" data-running="${running && before === undefined ? "1" : "0"}">
      <div>
        ${contextLine(context)}
        ${turns.length === DEFAULT_PAGE && turns[0] !== undefined
          ? html`<p class="talk-more small"><a href="${HERE}?before=${turns[0].id}">Earlier</a></p>`
          : null}
        ${before === undefined ? null : html`<p class="talk-more small"><a href="${HERE}">Latest</a></p>`}
        <ol class="talk-log" role="log" data-last="${last}" aria-label="Conversation with the forge">
          ${turns.length === 0
            ? html`<li class="muted talk-turn">Ask the forge anything, or tell it what to change. It acts as you, with your permissions, and asks before anything hard to undo.
                <span class="talk-suggest">${SUGGESTIONS.map((q) => html`<a class="btn" href="${HERE}?q=${encodeURIComponent(q)}" data-suggest="${q}">${q}</a>`)}</span></li>`
            : turns.map((t) => turnHtml(t, waiting, costs.get(t.id), acts.get(t.id)))}
        </ol>
        <div id="end"></div>
      </div>
      <form class="talk-compose" id="compose" method="post" action="${editing === undefined ? HERE : `${HERE}/again/edit`}" ${editing === undefined ? null : html`data-edit`}>
        <p class="talk-status small muted" role="status" aria-live="polite">${running ? "The forge is answering…" : ""}</p>
        <textarea class="input" name="text" rows="1" maxlength="${WORDS_MAX}" required placeholder="Talk to the forge" aria-label="Talk to the forge">${editing === undefined ? prefill : editing.text}</textarea>
        <div class="bar">
          <span class="muted small" data-hint></span>
          <span class="spacer"></span>
          ${editing === undefined ? null : html`<a class="btn" href="${HERE}">Keep as it was</a>`}
          ${btn(editing === undefined ? "Send" : "Resend", { variant: "primary" })}
        </div>
      </form>
    </div>`;
  return page({ ctx, title: "Talk", body, styleCss: talkCss, scriptJs: talkJs, description: "Talk to the forge." });
}

// GET /talk
export function talkView(ctx: Ctx): Response {
  if (ctx.auth.user === undefined) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const before = ctx.url.searchParams.get("before");
  const q = ctx.url.searchParams.get("q");
  return timePhase(ctx.request, "render", () => talkPage(ctx, before !== null && TURN_ID.test(before) && before !== "" ? before : undefined, q !== null && SUGGESTIONS.some((s) => s === q) ? q : "", ctx.url.searchParams.get("edit") === "1" && before === null));
}

// POST /talk — the plain form, for a browser without the script.
export async function talkSend(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const text = form.get("text");
  if (typeof text !== "string" || text.trim() === "" || text.length > WORDS_MAX)
    return flashTo(ctx, `${HERE}#end`, { tone: "danger", message: `Say something, up to ${WORDS_MAX} characters.` });
  const said = talk(ctx.app, user, text);
  if (!said.ok) return flashTo(ctx, `${HERE}#end`, { tone: "danger", message: TALK_WORDS[said.error][1] });
  return flashTo(ctx, `${HERE}#end`, { tone: "success", message: "Sent. Reload to see the answer." });
}

const AGAIN: readonly RedoHow[] = ["edit", "regenerate", "retry"];

// POST /talk/again/:how — edit and resend the last message, regenerate the last reply, retry a failed turn.
export async function talkAgainSend(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  if (ctx.auth.via !== "session") return forbiddenPage(ctx, "Do this from your own signed-in browser.");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const how = AGAIN.find((h) => h === ctx.params["how"]);
  if (how === undefined) return new Response("not found", { status: 404 });
  const text = form.get("text");
  const asJson = (ctx.request.headers.get("accept") ?? "").includes("application/json");
  let status = 422;
  let message = `Say something, up to ${WORDS_MAX} characters.`;
  if (how !== "edit" || (typeof text === "string" && text.trim() !== "" && text.length <= WORDS_MAX)) {
    const said = talkAgain(ctx.app, user, how, typeof text === "string" ? text : "");
    if (said.ok) return asJson ? json({ ok: true }, 202) : flashTo(ctx, `${HERE}#end`, { tone: "success", message: "Asked again. Reload to see the answer." });
    [status, message] = TALK_WORDS[said.error];
  }
  return asJson ? json({ ok: false, message }, status) : flashTo(ctx, `${HERE}#end`, { tone: "danger", message });
}

// POST /talk/confirm/:id — the person's yes or no, from their own session.
export async function talkConfirm(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  if (ctx.auth.via !== "session") return forbiddenPage(ctx, "Answer this from your own signed-in browser.");
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const answer = form.get("answer");
  if (answer !== "yes" && answer !== "no") return new Response("bad request", { status: 400 });
  const asJson = (ctx.request.headers.get("accept") ?? "").includes("application/json");
  const id = ctx.params["id"] ?? "";
  let refused: string | undefined;
  let status = 422;
  if (answer === "no") {
    const no = sayNo(ctx, user, id);
    if (!no.ok) [status, refused] = REFUSED[no.error];
  } else if (waitingConfirms(ctx, user).some((w) => w.id === id && ASKING[w.tool]?.once !== undefined)) {
    // A result shown once is drawn by Settings → Confirms; here it would be thrown away.
    status = 409;
    refused = "this result is shown once: confirm it in Settings → Confirms";
  } else {
    const yes = await sayYes(ctx, user, id);
    if (!yes.ok) [status, refused] = REFUSED[yes.error];
    else if (!yes.done) refused = `${String(yes.turn["tool"])} did not go through: ${String(yes.turn["message"] ?? yes.turn["error"])}`;
  }
  if (asJson) return json(refused === undefined ? { ok: true } : { ok: false, message: refused }, refused === undefined ? 200 : status);
  return flashTo(ctx, `${HERE}#end`, refused === undefined ? { tone: "success", message: answer === "yes" ? "Confirmed." : "Cancelled." } : { tone: "danger", message: `Nothing was done: ${refused}` });
}

// GET /talk/stream?after=<turn id> — turns as they are written, ended with the turn.
export function talkStream(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (user === undefined) return new Response("sign in", { status: 401 });
  if ((open.get(user.id) ?? 0) >= STREAMS_MAX) return new Response("too many streams", { status: 429, headers: { "retry-after": "5" } });
  const after = ctx.url.searchParams.get("after") ?? ctx.request.headers.get("last-event-id") ?? "";
  if (!TURN_ID.test(after)) return new Response("bad turn id", { status: 400 });
  const { app } = ctx;
  const conversation = openConversation(app.db, user.id);
  let cursor = after;
  return eventStream(app, ctx.request, (emit, close) => {
    const started = Date.now();
    let told = false;
    const tick = (): void => {
      // Asked before the read: a turn that ends after this look is read whole next time.
      const running = clock.running(app, user.id);
      const fresh = turnsAfter(app.db, user.id, conversation.id, cursor);
      if (fresh.length > 0) {
        const waiting = new Set(waitingConfirms(ctx, user).map((w) => w.id));
        for (const turn of fresh) {
          emit("turn", { id: turn.id, html: turnHtml(turn, waiting).text }, turn.id);
          cursor = turn.id;
        }
      }
      if (fresh.length >= MAX_PAGE) return;
      if (!running) {
        // The run stored its figures before it stopped running: send them with the end.
        const costs = [...turnCosts(app.db, conversation.id)].slice(-5).map(([id, usd]) => ({ id: `t-${id}`, html: costLine(usd).text }));
        const context = contextOf(app.db, conversation.id);
        emit("done", {
          costs,
          context: context === undefined ? "" : contextText(context),
          acts: [...exchangeActs(app.db, user.id, conversation.id, false)].map(([id, act]) => ({ id: `t-${id}`, html: act.text })),
        });
        close();
      } else if (Date.now() - started >= clock.streamMs) {
        emit("more", {});
        close();
      } else if (!told) {
        told = true;
        emit("running", {});
      }
    };
    open.set(user.id, (open.get(user.id) ?? 0) + 1);
    const timer = setInterval(tick, POLL_MS);
    queueMicrotask(tick);
    return () => {
      clearInterval(timer);
      const left = (open.get(user.id) ?? 1) - 1;
      if (left <= 0) open.delete(user.id);
      else open.set(user.id, left);
    };
  });
}
