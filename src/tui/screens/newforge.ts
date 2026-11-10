/**
 * `/forges/new` in the terminal (#1782): a client's forge, with the page's
 * fields. It goes through `spawnDoor` as the page and `POST /api/v1/forges`
 * do, so every rule (names, budget, the key, the apps you may read) is the
 * door's and not this screen's. **Ctrl+P** shows the plan and makes nothing;
 * **Enter** on the plan spawns; the claim link is then shown once, in a
 * dialog, and kept nowhere. Any signed-in person's, as the page is.
 */

import { DEFAULT_SIZE, SIZES, type Size } from "../../spawn/sizes.ts";
import { DEFAULT_TEMPLATE, TEMPLATES, templateOf } from "../../spawn/templates.ts";
import { childUrlOf, spawnDoor } from "../../spawn/door.ts";
import { quotaFull } from "../../spawn/quota.ts";
import { FOLLOW_LINE, FOLLOW_WORDS } from "../../spawn/follow_words.ts";
import { isFollowMode } from "../../spawn/chain.ts";
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
  /** A choice, not text: left, right and space move through it. */
  readonly choices?: readonly string[];
}

const SIZE_CHOICES = Object.keys(SIZES) as Size[];

const TEMPLATE_CHOICES = TEMPLATES.map((t) => t.id);

const TEMPLATE_HINT = "blank (default) or starter: left and right choose, or type it.";

const SPECS: readonly Spec[] = [
  { key: "name", label: "Name", hint: "Lowercase letters, digits and dashes." },
  { key: "for", label: "For whom", hint: "A person or client, for your list of forges sent. Optional." },
  { key: "direction", label: "What it is for", hint: "The crew's first direction. Optional." },
  { key: "apps", label: "Apps to fork", hint: "owner/name, comma-separated. Optional." },
  { key: "fresh", label: "Or a fresh app", hint: "One line on what it is. Optional." },
  { key: "modelKey", label: "AI account key", hint: "Sealed in the new forge, never shown again. Optional.", secret: true },
  { key: "modelEndpoint", label: "API base URL", hint: "A gateway for the key; empty for Anthropic. Optional." },
  { key: "budgetUsd", label: "Budget in dollars", hint: `${MIN_BUDGET_USD}–${MAX_BUDGET_USD}, for the key's whole life. Needed with a key.` },
  { key: "followMode", label: "Follows this forge's code", hint: FOLLOW_LINE },
  { key: "size", label: "Size", hint: "small (default), medium or large: left and right choose, or type it.", choices: SIZE_CHOICES },
  { key: "template", label: "Template", hint: TEMPLATE_HINT, choices: TEMPLATE_CHOICES },
];

/** The chosen template's own sentence; a typed id that is no template keeps the general hint. */
function templateHint(id: string): string {
  const t = TEMPLATES.find((x) => x.id === id);
  return t === undefined ? TEMPLATE_HINT : t.says;
}

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
  // Said when the screen opens, before anything is typed: the host's child quota has no room even for small.
  const quota = quotaFull(f.app.config.dataDir);

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
      // Small is the default: it is not recorded, as on the page.
      ...(val("size") === "" || val("size") === DEFAULT_SIZE ? {} : { size: val("size") }),
      // Blank is the default: it is not recorded, as on the page.
      ...(val("template") === "" || val("template") === DEFAULT_TEMPLATE ? {} : { template: val("template") }),
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
          const size = (body["plan"] as { size?: string } | undefined)?.size;
          const template = (body["plan"] as { template?: string } | undefined)?.template;
          const mode = val("followMode") === "" ? "tell-me" : val("followMode");
          plan = [
            `A forge at ${childUrlOf(f.app, val("name"))}.`,
            `It follows this forge's code as ${mode}${isFollowMode(mode) ? `: it ${FOLLOW_WORDS[mode]}` : "."}`,
            "Whoever opens the link becomes its admin.",
            ...(budget === null ? [] : [`Its crew runs on your key, up to $${budget} for the key's whole life.`]),
            "Copied into it:",
            ...copied.map((c) => `  ${c}`),
            ...(size === undefined ? [] : [`Size: ${size}.`]),
            ...(template === undefined ? [] : [`Template: ${templateOf(template).title}.`]),
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
    render(full, s) {
      const c = ctx.theme.c;
      let area = full;
      if (quota !== undefined) {
        s.text(full.x, full.y, truncate(`This forge cannot hold another child: ${quota}.`, full.w), style(c.attn, c.bg), full.x + full.w);
        area = { ...full, y: full.y + 2, h: Math.max(1, full.h - 2) };
      }
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
        const raw = spec.choices === undefined ? (values[spec.key] ?? "") : (values[spec.key] || spec.choices[0]!);
        const shown = spec.secret === true ? "•".repeat([...raw].length) : raw;
        const at = field(s, { x: area.x, y: area.y + n * 3, w: Math.min(70, area.w), h: 3 }, c, {
          label: spec.label,
          value: shown,
          focused: focus === i,
          ...(focus === i ? { cursor: [...shown].length } : {}),
          ...(error !== undefined && (errorKey === spec.key || (errorKey === undefined && focus === i))
            ? { error }
            : { hint: spec.key === "template" ? templateHint(values["template"] || DEFAULT_TEMPLATE) : spec.hint }),
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
      const choices = SPECS[focus]!.choices;
      const step = e.key === "left" ? -1 : e.key === "right" || e.key === " " || e.key === "space" ? 1 : 0;
      if (choices !== undefined && step !== 0) {
        // A choice can be cycled or typed; both end in a value the door checks.
        const k = SPECS[focus]!.key;
        const at = Math.max(0, choices.indexOf(values[k] || choices[0]!));
        values[k] = choices[(at + step + choices.length) % choices.length]!;
        error = undefined;
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
