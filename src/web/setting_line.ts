/**
 * A setting as one line (#10999): its name, its control (which shows its
 * value) and a mark that opens its reason, all on one flex row
 * (`.setting-line`, docs/design/areas/settings.md). The reason sits one tap
 * deeper in a <details>; the mark is drawn as a small bordered button, so it
 * reads as a control without a word that would cost every row a text block.
 */
import { html, raw, type Html } from "./html.ts";
import { icon } from "./icons.ts";

/** The reason behind a setting, behind its mark. `id` ties it to the control via aria-describedby. */
export function why(id: string, reason: string | Html): Html {
  return html`<details class="hint why" id="why-${id}"><summary aria-label="Why" title="Why">${icon("help")}</summary><p>${reason}</p></details>`;
}

/** A setting line around any control: the caller passes the label and control markup. */
export function settingLine(name: string, body: Html, reason: string | Html): Html {
  return html`<div class="field setting-line" data-setting="${name}">${body}${why(name, reason)}</div>`;
}

/** A yes/no setting: the checkbox is its value. `shown` names the hidden field saying the box was on the form. */
export function toggleLine(name: string, label: string, on: boolean, reason: string | Html, shown?: string): Html {
  return settingLine(
    name,
    html`${shown ? html`<input type="hidden" name="${shown}" value="1" />` : null}<label class="check"><input type="checkbox" name="${name}" aria-describedby="why-${name}" ${on ? raw("checked") : null} /><span>${label}</span></label>`,
    reason,
  );
}
