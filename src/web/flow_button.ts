/**
 * The `flow` label as one button: "Flow first" puts an issue ahead of other
 * ready work, "Not first" takes it back. A post to the issue's own `/flow`,
 * same-origin and writers only; it lands back where it was pressed.
 */

import { html, type Html } from "./html.ts";
import { btn } from "./ui.ts";

const ON = "Adds the flow label: it goes ahead of other ready work";
const OFF = "Takes the flow label off: it no longer goes ahead of other ready work";

export function flowButton(action: string, first: boolean, back: string): Html {
  return html`<form method="post" action="${action}" class="inline" title="${first ? OFF : ON}" data-now="${first ? "Flow first" : "Not first"}" data-now-alt="${first ? "Not first" : "Flow first"}" data-now-flip="flow">
    <input type="hidden" name="flow" value="${first ? "0" : "1"}" />
    <input type="hidden" name="back" value="${back}" />
    ${btn(first ? "Not first" : "Flow first", { size: "sm", variant: "outline" })}
  </form>`;
}
