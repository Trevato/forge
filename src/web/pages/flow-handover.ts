/**
 * /flow: where the crew is about to give up and where a rebase would unstick
 * it, as plain rows under the pipes. The three lists come from
 * `flow/handover_read.ts` (the terminal screen reads the same); each shows
 * only when it has rows, and each rebase row carries the existing update form
 * (`POST …/pulls/N/update`, same-origin checked and `back` validated as a
 * local path in `updateSubmit`).
 */

import type { HandoverLists, Named } from "../../flow/handover_read.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";

const href = (n: Named): string => `/${n.repo}/pulls/${String(n.number)}`;
const link = (n: Named): Html => html`<a href="${href(n)}">${n.repo} #${String(n.number)}</a>`;

/** The section for lists already read: nothing when all three are empty. */
export function handoverSection(lists: HandoverLists): Html | null {
  const { handed, near, rebase } = lists;
  if (handed.length + near.length + rebase.length === 0) return null;
  return html`<section id="handover">
    <h2>Where the crew gives up</h2>
    ${handed.length === 0
      ? ""
      : html`<h3>Handed to a person in the last 24 h</h3>
    <ul class="list">${handed.map((n) => html`<li>${link(n)}</li>`)}</ul>`}
    ${near.length === 0
      ? ""
      : html`<h3>One review round from a hand-over</h3>
    <ul class="list">${near.map((n) => html`<li>${link(n)}</li>`)}</ul>`}
    ${rebase.length === 0
      ? ""
      : html`<h3>Bring up to date first</h3>
    <ul class="list">${rebase.map(
      (n) => html`<li>${link(n)}
        <form method="post" action="${href(n)}/update" class="bar">
          <input type="hidden" name="back" value="/flow" />
          ${btn("Bring up to date", { size: "sm", label: `Bring ${n.repo} #${String(n.number)} up to date` })}
        </form></li>`,
    )}</ul>`}
  </section>`;
}
