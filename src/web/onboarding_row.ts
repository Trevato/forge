/**
 * Where a new or migrated app stands (#10295, `apps/onboarding.ts`), as the
 * facts row of the app's head card. While production has no deploy of its
 * own it takes the place of production's facts row, so the head says the
 * app's state once;
 * it rides inside `#app-head`, so the state fragment's swap moves it too.
 */

import type { OnboardingLine } from "../apps/onboarding.ts";
import { html, type Html } from "./html.ts";

export function onboardingRow(line: OnboardingLine): Html {
  return html`<p class="muted" data-onboarding="${line.state}">
    ${line.text}${line.href === undefined || line.linkLabel === undefined
      ? null
      : html` <a href="${line.href}">${line.linkLabel}</a>`}
  </p>`;
}
