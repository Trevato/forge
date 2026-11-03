/**
 * /notes (#8696): what a person wrote, newest first, each with its live state
 * in one line. One box: typing and Enter keeps the note (`keepThought`, the
 * same door the composer and the MCP use); the planner turns it into issues
 * on its own (`crew/triage.ts`) and the line under it follows them from
 * planned to shipped (`core/note_line.ts`). Server-rendered; the script only
 * makes Enter send, Shift+Enter a new line. Everything shown is the signed-in
 * person's own.
 */

import { overruleNote } from "../../actions/note_overrule.ts";
import { keepThought, THOUGHT_MAX } from "../../actions/thought.ts";
import { noteLine, type NotePhase } from "../../core/note_line.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { publicForgeRepo } from "../../core/forge_repo.ts";
import { thoughtStream } from "../../core/thought_stream.ts";
import type { Ctx } from "../../http/context.ts";
import { forgeChangelog } from "../../release/changelog.ts";
import { signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, empty, listCard, row, time, type Tone } from "../ui.ts";
import { cut } from "../../actions/ask_state_words.ts";

const HERE = "/notes";
const SHOWN = 100;

const TONE: Record<NotePhase, Tone> = {
  waiting: "default",
  declined: "default",
  duplicate: "default",
  snoozed: "default",
  planned: "default",
  building: "attn",
  review: "attn",
  shipped: "success",
  superseded: "default",
};

/** Static code, never built from user text. */
export const notesJs = `
const form = document.querySelector("form.note-box");
if (form) {
  const box = form.querySelector("textarea");
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (box.value.trim() !== "") form.requestSubmit();
    }
  });
}
`;

export const NOTES_CSS = /* css */ `
.note-box { display: grid; gap: 6px; margin-bottom: 1rem; }
.note-box textarea { width: 100%; min-height: 3.5rem; font-size: 16px; box-sizing: border-box; resize: vertical; }
.note-line a { margin-right: 6px; }
[data-notes] { overflow-wrap: anywhere; }
[data-notes] .row-title, [data-notes] .row-meta { white-space: normal; overflow: visible; text-overflow: clip; }
[data-notes] .row { align-items: flex-start; }
`;

// GET /notes
export async function notesView(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const notes = timePhase(ctx.request, "notes", () => thoughtStream(ctx.app.db, user, { limit: SHOWN }));
  // The release that carried a pull is known only for the forge's own repository.
  const own = publicForgeRepo(ctx.app);
  const shipped = notes.some((n) => n.state === "shipped");
  const entries = own !== undefined && shipped ? ((await forgeChangelog(ctx.app))?.entries ?? []) : [];
  const ownSlug = own === undefined ? "" : `${own.ownerName}/${own.name}`;
  const versionOf = (repo: string, pull: number) =>
    repo === ownSlug ? entries.find((e) => e.pulls.some((p) => p.number === pull))?.version : undefined;
  const rows = notes.map((n) => {
    const line = noteLine(n, versionOf);
    return row({
      title: cut(n.text, 200),
      titleAttr: n.text,
      meta: html`<span class="note-line">${time(n.receivedAt)} · ${line.text}${line.links.length === 0 ? null : " · "}${line.links.map(
        (l) => html`<a href="${l.href}">${l.label}</a>`,
      )}</span>`,
      trail: badge(line.phase === "review" ? "In review" : line.phase[0]!.toUpperCase() + line.phase.slice(1), { tone: TONE[line.phase] }),
      ...(line.overrule === null
        ? {}
        : {
            after: html`<form method="post" action="${HERE}/${n.id}/overrule">
              <input type="hidden" name="do" value="${line.overrule.do}" />
              ${btn(line.overrule.label, { title: "Overrule the planner" })}
            </form>`,
          }),
    });
  });
  const body = html`<div data-notes><div class="page-head"><h1>Notes</h1></div>
    <form class="note-box" method="post" action="${HERE}">
      <textarea class="input" name="text" rows="2" maxlength="${THOUGHT_MAX}" required enterkeyhint="send" autofocus placeholder="Write an idea. Enter saves it." aria-label="A note"></textarea>
      <div class="bar"><span class="muted small">Enter saves · Shift+Enter for a new line</span><span class="spacer"></span>${btn("Save", { variant: "primary" })}</div>
    </form>
    ${rows.length === 0
      ? empty({ icon: "comment", title: "No notes yet", note: "Write an idea above. The crew plans it, builds it, and this page says where it is." })
      : listCard(rows)}</div>`;
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: "Notes", body, styleCss: NOTES_CSS, scriptJs: notesJs, description: "Write an idea; watch it become shipped work." }),
  );
}

// POST /notes
export async function notesSave(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const text = form.get("text");
  if (typeof text !== "string" || text.trim() === "")
    return flashTo(ctx, HERE, { tone: "danger", message: "Write something first." });
  const kept = keepThought(ctx.app, user, text, "composer");
  if (!kept.ok)
    return flashTo(ctx, HERE, { tone: "danger", message: `A note is at most ${THOUGHT_MAX} characters.` });
  return flashTo(ctx, HERE, { tone: "success", message: "Saved. The planner will pick it up." });
}

const OVERRULED = { accepted: "Built after all.", declined: "Declined." } as const;

// POST /notes/:id/overrule
export async function notesOverrule(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const done = overruleNote(ctx.app, user, ctx.params["id"] ?? "", form.get("do"));
  if (!done.ok) return flashTo(ctx, HERE, { tone: "danger", message: "That note cannot be changed now." });
  return flashTo(ctx, HERE, { tone: "success", message: OVERRULED[done.value] });
}
