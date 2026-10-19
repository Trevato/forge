/**
 * The one Usage page of Settings: what is used (spend), what is asked
 * (routes), what is full (capacity) and who may read the telemetry. Each tab
 * is its own URL, so a link and a back button keep working; this renders the
 * frame they share.
 */

import type { Html } from "../html.ts";
import { settingsLayout } from "../chrome.ts";
import { html } from "../html.ts";
import { liveRegionsJs } from "../client.ts";
import { page } from "../layout.ts";
import { tabs } from "../ui.ts";
import type { Ctx } from "../../http/context.ts";
import { accountSections } from "./origins.ts";

export type UsageTab = "spend" | "routes" | "capacity" | "telemetry";

const TABS: readonly { id: UsageTab; label: string; href: string }[] = [
  { id: "spend", label: "Spend", href: "/settings/spend" },
  { id: "routes", label: "Routes", href: "/settings/usage" },
  { id: "capacity", label: "Capacity", href: "/settings/capacity" },
  { id: "telemetry", label: "Telemetry", href: "/settings/telemetry" },
];

/** The Usage page around `body`, with `current` marked in the tabs. */
export function usageShell(ctx: Ctx, current: UsageTab, body: Html, status?: number): Response {
  return page(
    {
      ctx,
      title: "Usage",
      scriptJs: liveRegionsJs,
      body: html`<div class="page-head"><h1>Usage</h1></div>
        ${settingsLayout(
          accountSections("usage", { admin: true }),
          html`${tabs(
            TABS.map((t) => ({ label: t.label, href: t.href, current: t.id === current })),
            "Usage",
          )}${body}`,
          "Account settings",
        )}`,
    },
    status,
  );
}
