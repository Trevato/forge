/**
 * A repository's webhooks in the terminal, an admin's: each hook's url,
 * kinds and last delivery, never its secret. `enter` opens its last 20
 * deliveries. `a` asks for url, kinds and a secret (typed masked, 16–200
 * characters) and adds it through `createWebhook`; `d` removes the selected one after a confirm through
 * `deleteWebhook`. The words of a refusal are MCP `hooks`'s.
 */

import { createWebhook, deleteWebhook } from "../../actions/repos.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { listWebhooks, recentDeliveries, type DeliveryInfo, type Webhook } from "../../core/webhooks.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";

const LIMITS = { url: 2048, kinds: 200, secret: 200 } as const;
const NOT_ADMIN = "no such app or repository, or you do not administer it";
const SHORT_SECRET = "secret is required: 16 to 200 characters, the key deliveries are signed with";

/** The command that opens the screen: offered to an admin of the repository only. */
export function hooksCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined || !canAdmin(f.db, repo, f.user)) return [];
  return [
    {
      id: "webhooks",
      title: `${repo.ownerName}/${repo.name} — Webhooks`,
      hint: "list, add and remove webhooks",
      run: () => ctx.push(hooksScreen(f, ctx, repo)),
    },
  ];
}

const clean = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();

function lastDelivery(f: Session, hook: Webhook): string {
  const d = recentDeliveries(f.db, hook.id, 1)[0];
  if (d === undefined) return "no delivery yet";
  const how = d.lastStatus !== null ? ` ${d.lastStatus}` : d.lastError !== null ? ` ${clean(d.lastError)}` : "";
  return `last ${d.kind}: ${d.state}${how}`;
}

/** One hook's last 20 deliveries, newest first: kind · state · status or reason · attempts. */
function deliveriesScreen(f: Session, ctx: Ctx, hook: Webhook, allowed: () => boolean): Screen {
  const state = new ListState();
  let all: DeliveryInfo[] = [];
  return {
    title: "Deliveries",
    keys: [binding(["j", "k"], "move"), binding(["esc", "q"], "back")],
    render(area, s) {
      if (!allowed()) {
        ctx.pop();
        return;
      }
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate(clean(hook.url), head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      all = recentDeliveries(f.db, hook.id, 20);
      if (all.length === 0) {
        emptyState(s, body!, c, { title: "No deliveries yet." });
        return;
      }
      const rows: ListRow[] = all.map((d) => ({
        title: `${d.kind} · ${d.state} · ${d.lastError !== null ? clean(d.lastError) : (d.lastStatus ?? "—")} · ${d.attempts}`,
        tone: d.state === "ok" ? "success" : d.state === "failed" ? "danger" : "attn",
      }));
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      if (e.ctrl || e.alt) return false;
      if (!allowed() || e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return state.key(e, all.length);
    },
  };
}

export function hooksScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  const allowed = (): boolean => f.user !== undefined && canAdmin(f.db, repo, f.user);
  const hooks = (): Webhook[] => (allowed() ? listWebhooks(f.db, repo.id) : []);
  let note = "";

  const add = (url: string, kinds: string, secret: string): string | undefined => {
    if (secret.length < 16 || secret.length > LIMITS.secret) return SHORT_SECRET;
    // The core's kinds are space-separated; a comma is accepted and turned into one.
    const spec = kinds.split(/[\s,]+/).filter((k) => k !== "").join(" ");
    const made = createWebhook(f.app, f.user, repo, { url, kinds: spec || "*", secret });
    if (!made.ok) return made.error === "invalid_url" ? "a webhook url is https://…" : NOT_ADMIN;
    note = `added ${clean(made.value.webhook.url)}`;
    ctx.invalidate();
    return undefined;
  };

  const ask = (): void => {
    if (!allowed()) return;
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Add a webhook",
        label: "url (https://…)",
        onSubmit: (url) => {
          if (url === "" || url.length > LIMITS.url) return `url is text of at most ${LIMITS.url} characters`;
          return later(ctx, () =>
            promptScreen(ctx, screen, {
              title: "Add a webhook",
              label: "kinds (e.g. push issue.*, empty for all)",
              onSubmit: (kinds) => {
                if (kinds.length > LIMITS.kinds) return `kinds is text of at most ${LIMITS.kinds} characters`;
                return later(ctx, () =>
                  promptScreen(ctx, screen, {
                    title: "Add a webhook",
                    label: "secret (16–200 characters)",
                    mask: true,
                    onSubmit: (secret) => add(url, kinds, secret),
                  }),
                );
              },
            }),
          );
        },
      }),
    );
  };

  const remove = (hook: Webhook): void =>
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Remove webhook",
        body: [truncate(clean(hook.url), 50), "Deliveries to it stop."],
        actions: [{ label: "Cancel", variant: "ghost" }, { label: "Remove", variant: "danger" }],
        onChoose: (i) => {
          if (i !== 1) return;
          const done = deleteWebhook(f.app, f.user, repo, hook.id);
          note = done.ok ? `removed ${clean(hook.url)}` : "no such webhook here";
          ctx.invalidate();
        },
      }),
    );

  const screen: Screen = {
    title: "Webhooks",
    keys: [
      binding(["j", "k"], "move"),
      binding(["a"], "add a webhook"),
      binding(["d"], "remove the selected one"),
      binding(["enter"], "its deliveries"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : `${repo.ownerName}/${repo.name} · webhooks (secrets are never shown)`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const all = hooks();
      if (all.length === 0) {
        emptyState(s, body!, c, {
          title: allowed() ? "No webhooks" : "Not available",
          body: allowed() ? "Press a to add one." : NOT_ADMIN,
        });
        return;
      }
      const rows: ListRow[] = all.map((h) => ({
        title: clean(h.url),
        secondary: `kinds ${clean(h.kinds)}`,
        meta: lastDelivery(f, h),
      }));
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      if (state.key(e, hooks().length)) return true;
      if (e.ctrl || e.alt || !allowed()) return false;
      if (e.key === "a") ask();
      else if (e.key === "enter") {
        const hook = hooks()[state.index];
        if (hook === undefined) return false;
        ctx.push(deliveriesScreen(f, ctx, hook, allowed));
      } else if (e.key === "d") {
        const hook = hooks()[state.index];
        if (hook === undefined) return false;
        remove(hook);
      } else return false;
      return true;
    },
  };
  return screen;
}
