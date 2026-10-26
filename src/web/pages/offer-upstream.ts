/**
 * The offer on a fork's home: its own commits, one tap from the pull form.
 * "Offer 3 commits upstream" opens the new-pull form with the fork's default
 * branch as head and the parent's as base; when an open pull already offers
 * that branch the line links to it instead. The gate and the lookup are
 * `upstreamOffer`'s, shared with the terminal; no git here.
 */

import type { UpstreamOffer } from "../../actions/offer_upstream.ts";
import type { Repo } from "../../core/repos.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";

export function offerUpstream(
  repo: Repo,
  parent: Repo | undefined,
  offer: UpstreamOffer | null,
): Html | null {
  if (offer === null || parent === undefined) return null;
  if (offer.openNumber !== null)
    return html`<p class="mt small">
      <a href="${repoBase(parent)}/pulls/${offer.openNumber}">Offered in #${offer.openNumber}</a>
    </p>`;
  const query = new URLSearchParams({ head: offer.head, base: offer.base });
  return html`<div class="mt">
    ${btn(`Offer ${offer.ahead} commit${offer.ahead === 1 ? "" : "s"} upstream`, {
      size: "sm",
      icon: "merge",
      href: `${repoBase(repo)}/pulls/new?${query}`,
    })}
  </div>`;
}
