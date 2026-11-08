/**
 * The direction drawn with its two authors told apart (#5835): the fenced block
 * that follows docs/VISION.md, and the owner's own words. A vision pull shows
 * the block as the merge will write it, beside today's.
 */
import { directionParts, type DirectionPart, type VisionPreview } from "../../crew/vision.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { badge, card } from "../ui.ts";

const FOLLOWS = "follows docs/VISION.md";
const OWNER = "the owner's";

function part(p: DirectionPart): Html {
  return html`<div data-direction-part="${p.kind}">
    <p>${p.kind === "vision" ? badge(FOLLOWS) : badge(OWNER, { variant: "outline" })}</p>
    <div class="direction-text">${p.text}</div>
  </div>`;
}

/** The direction in parts, each marked; nothing when it is empty. */
export function directionMarked(direction: string): Html | null {
  const parts = directionParts(direction);
  if (parts.length === 0) return null;
  return html`<div class="stack" id="direction-marked">${parts.map(part)}</div>`;
}

/** Today's direction beside the one the merge writes, or why it will stay. */
export function visionPreviewCard(preview: VisionPreview): Html {
  const head = html`${icon("code")}<h2>Direction after the merge</h2>`;
  if (!preview.ok)
    return card(html`<p class="muted small">An admin's merge would leave the direction as it is: ${preview.why}.</p>`, {
      head,
      id: "direction-preview",
    });
  const same = preview.today === preview.after;
  return card(
    html`${same ? html`<p class="muted small">The merge changes nothing in the direction.</p>` : null}
      <div class="stack">
        <div data-direction="today">
          <h3 class="small">Today</h3>
          ${directionMarked(preview.today) ?? html`<p class="muted small">(none written)</p>`}
        </div>
        <div data-direction="after">
          <h3 class="small">After the merge</h3>
          ${directionMarked(preview.after) ?? html`<p class="muted small">(none written)</p>`}
        </div>
      </div>`,
    { head, id: "direction-preview" },
  );
}
