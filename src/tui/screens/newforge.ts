/**
 * `/forges/new` in the terminal (#1782): a client's forge, with the page's
 * fields. It goes through `spawnDoor` as the page and `POST /api/v1/forges`
 * do, so every rule (names, budget, the key, the apps you may read) is the
 * door's and not this screen's. **Ctrl+P** shows the plan and makes nothing;
 * **Enter** on the plan spawns; the claim link is then shown once, in a
 * dialog, and kept nowhere. Any signed-in person's, as the page is.
 */

import { childUrlOf, spawnDoor } from "../../spawn/door.ts";
import { MAX_BUDGET_USD, MIN_BUDGET_USD } from "../../spawn/plan.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { field } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { linkScreen, runAsync } from "./common.ts";

interface Spec {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly secret?: boolean;
}

const SPECS: readonly Spec[] = [
  { key: "name", label: "Name", hint: "Lowercase letters, digits and dashes." },
  { key: "for", label: "For whom", hint: "A person or client, for your list of forges sent. Optional." },
  { key: "direction", label: "What it is for", hint: "The crew's first direction. Optional." },
  { key: "apps", label: "Apps to fork", hint: "owner/name, comma-separated. Optional." },
  { key: "fresh", label: "Or a fresh app", hint: "One line on what it is. Optional." },
  { key: "modelKey", label: "Model key", hint: "Sealed in the child, never shown again. Optional.", secret: true },
  { key: "modelEndpoint", label: "API base URL", hint: "A gateway for the key; empty for Anthropic. Optional." },
  { key: "budgetUsd", label: "Budget in dollars", hint: `${MIN_BUDGET_USD}–${MAX_BUDGET_USD}, for the key's whole life. Needed with a key.` },
  { key: "followMode", label: "Follows this forge's code", hint: "tell-me (default) or take-updates. Recorded only; nothing acts on it yet." },
];

/** The door's "field: reason" refusal, as the field it names and the reason. */
function refusal(body: Record<string, unknown>): { key?: string; text: string } {
  const text = String(body["message"] ?? "refused");
  const m = /^([A-Za-z]+): (.*)$/.exec(text);
  return m && body["error"] === "invalid" ? { key: m[1]!, text: m[2]! } : { text };
}

export function newForgeScreen(f: Session, ctx: Ctx): Screen {
  const values: Record<string, string> = {};
  let focus = 0;
  let errorKey: string | undefined;
  let error: string | undefined;
  let plan: string[] | undefined;
  let busy = false;

  const val = (k: string): string => (values[k] ?? "").trim();

  const request = (dryRun: boolean): Record<string, unknown> => {
    const apps = val("apps").split(",").map((a) => a.trim()).filter((a) => a !== "");
    return {
      name: val("name"),
      apps,
      ...(val("fresh") === "" ? {} : { fresh: val("fresh") }),
      followMode: val("followMode") === "" ? "tell-me" : val("followMode"),
      ...(val("for") === "" ? {} : { for: val("for") }),
      ...(val("direction") === "" ? {} : { direction: val("direction") }),
      ...(val("modelKey") === "" ? {} : { modelKey: val("modelKey") }),
      ...(val("modelEndpoint") === "" ? {} : { modelEndpoint: val("modelEndpoint") }),
      ...(val("budgetUsd") === "" ? {} : { budgetUsd: Number(val("budgetUsd")) }),
      dryRun,
    };
  };

  const door = async (dryRun: boolean) => {
    const url = new URL(f.app.config.url ?? `http://${f.app.config.host ?? "localhost"}`);
    const hctx = {
      app: f.app,
      request: new Request(url.href, { method: "POST" }),
      url,
      params: {},
      auth: { user: f.user, scope: undefined, via: "none" as const },
      theme: undefined,
    };
    return spawnDoor(hctx, f.user, request(dryRun));
  };

  const refuse = (body: Record<string, unknown>): void => {
    const r = refusal(body);
    values["modelKey"] = "";
    error = r.text;
    errorKey = r.key;
    const at = SPECS.findIndex((s) => s.key === r.key);
    if (at >= 0) focus = at;
    plan = undefined;
    ctx.toast(r.text, "danger");
  };

  const run = (dryRun: boolean): void => {
    if (busy) return;
    busy = true;
    error = undefined;
    errorKey = undefined;
    runAsync(ctx, async () => {
      try {
        const made = await door(dryRun);
        if (made.status >= 400) return refuse(made.body);
        const body = made.body;
        if (dryRun) {
          const copied = (body["copied"] as string[] | undefined) ?? [];
          const bytes = Number(body["bytes"] ?? 0);
          const budget = (body["plan"] as { budgetUsd?: number | null } | undefined)?.budgetUsd ?? null;
          plan = [
            `A forge at ${childUrlOf(f.app, val("name"))}.`,
            `Recorded for now, not acted on: it follows this forge's code as ${val("followMode") === "" ? "tell-me" : val("followMode")}.`,
            "Whoever opens the link becomes its admin.",
            ...(budget === null ? [] : [`Its crew runs on your key, up to $${budget} for the key's whole life.`]),
            "Copied into it:",
            ...copied.map((c) => `  ${c}`),
            `About ${Math.max(1, Math.round(bytes / 1024))} KB. Nothing is made until you press enter.`,
            ...(typeof body["keyNote"] === "string" ? [body["keyNote"]] : []),
          ];
          return;
        }
        values["modelKey"] = "";
        const link = body["claimUrl"];
        const name = String(body["name"] ?? val("name"));
        if (typeof link === "string") {
          ctx.toast(`${name} is ready`, "success");
          ctx.replace(linkScreen(ctx, link));
        } else {
          ctx.toast(`${name} already exists; its link is not shown again`, "attn");
          ctx.pop();
        }
      } finally {
        busy = false;
        ctx.invalidate();
      }
    });
  };

  return {
    title: "New forge",
    keys: [
      binding(["tab"], "next field"),
      binding(["ctrl+p"], "see the plan"),
      binding(["enter"], "spawn (on the plan)"),
      binding(["esc"], "back"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      if (plan !== undefined) {
        s.text(area.x, area.y, truncate("The plan", area.w), style(c.accent, c.bg), area.x + area.w);
        plan.forEach((line, i) => {
          if (i + 2 < area.h)
            s.text(area.x, area.y + 2 + i, truncate(line, area.w), style(c.fg, c.bg), area.x + area.w);
        });
        ctx.setCursor(null);
        return;
      }
      // Three rows a field; the window scrolls so the focused one is in view.
      const rows = Math.max(1, Math.floor(area.h / 3));
      const first = Math.max(0, Math.min(focus - rows + 1, SPECS.length - rows));
      let cursor: { x: number; y: number } | null = null;
      SPECS.slice(first, first + rows).forEach((spec, n) => {
        const i = first + n;
        const raw = values[spec.key] ?? "";
        const shown = spec.secret === true ? "•".repeat([...raw].length) : raw;
        const at = field(s, { x: area.x, y: area.y + n * 3, w: Math.min(70, area.w), h: 3 }, c, {
          label: spec.label,
          value: shown,
          focused: focus === i,
          ...(focus === i ? { cursor: [...shown].length } : {}),
          ...(error !== undefined && (errorKey === spec.key || (errorKey === undefined && focus === i))
            ? { error }
            : { hint: spec.hint }),
        });
        if (focus === i) cursor = at;
      });
      ctx.setCursor(cursor);
    },
    paste(text) {
      if (plan !== undefined) return true;
      const k = SPECS[focus]!.key;
      values[k] = (values[k] ?? "") + text.replace(/\s+/g, " ").trim();
      return true;
    },
    key(e) {
      if (plan !== undefined) {
        if (e.key === "enter") run(false);
        else if (e.key === "esc") plan = undefined;
        return true;
      }
      if (e.ctrl && e.key === "p") {
        run(true);
        return true;
      }
      if (e.key === "tab" || e.key === "enter") {
        focus = (focus + 1) % SPECS.length;
        return true;
      }
      if (e.key === "backspace") {
        const k = SPECS[focus]!.key;
        values[k] = [...(values[k] ?? "")].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        const k = SPECS[focus]!.key;
        values[k] = (values[k] ?? "") + e.key;
        error = undefined;
        return true;
      }
      return false;
    },
  };
}
