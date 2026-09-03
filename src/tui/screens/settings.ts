/**
 * Repository settings: the four groups the web surface carries, as four tabs.
 *
 * Two rules are load-bearing. A webhook secret is shown exactly once, in a
 * dialog, because that is the only moment it exists in the clear. And
 * deleting a repo requires typing its name — the one place in the TUI where a
 * confirmation is deliberately more work than pressing Enter.
 */

import {
  createLabel,
  createWebhook,
  deleteLabel,
  deleteRepo,
  deleteWebhook,
  updateRepoSettings,
} from "../../actions/repos.ts";
import { listLabels, type Label } from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import {
  listWebhooks,
  recentDeliveries,
  type DeliveryInfo,
  type Webhook,
} from "../../core/webhooks.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { labelChip, tabs } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  confirmScreen,
  drawFacts,
  drawList,
  hitList,
  errorText,
  promptScreen,
  runAsync,
} from "./common.ts";
import { refPickerScreen } from "./refs.ts";
import { local } from "./where.ts";

const TABS = ["General", "Labels", "Webhooks", "Danger"] as const;

export function settingsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let current = repo;
  let labels: Label[] = [];
  let hooks: Webhook[] = [];
  let deliveries = new Map<string, DeliveryInfo[]>();
  let tab = 0;
  const state = new ListState();

  const reload = (): void => {
    labels = listLabels(f.db, current.id);
    hooks = listWebhooks(f.db, current.id);
    deliveries = new Map(
      hooks.map((hook) => [hook.id, recentDeliveries(f.db, hook.id, 3)]),
    );
    ctx.invalidate();
  };

  const save = (patch: Parameters<typeof updateRepoSettings>[3]): void => {
    runAsync(ctx, async () => {
      const updated = await updateRepoSettings(f.app, f.user, current, patch);
      if (!updated.ok) {
        ctx.toast(errorText(updated.error), "danger");
        return;
      }
      current = updated.value;
      ctx.toast("settings saved", "success");
      reload();
    });
  };

  const screen: Screen = {
    title: "Settings",
    get keys() {
      if (tab === 0)
        return [
          binding(["tab"], "next tab"),
          binding(["d"], "description"),
          binding(["v"], "visibility"),
          binding(["b"], "default branch"),
          binding(["p"], "protection"),
          binding(["R"], "require a review"),
        ];
      if (tab === 1)
        return [
          binding(["tab"], "next tab"),
          binding(["n"], "new label"),
          binding(["D"], "delete label"),
        ];
      if (tab === 2)
        return [
          binding(["tab"], "next tab"),
          binding(["n"], "new webhook"),
          binding(["D"], "delete webhook"),
        ];
      return [binding(["tab"], "next tab"), binding(["X"], "delete repo")];
    },
    load() {
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [tabRow, body] = split(area, "v", [len(2), fill(1)]);
      tabs(s, tabRow!, c, {
        items: TABS.map((label) => ({ label })),
        active: tab,
      });
      if (tab === 0) {
        drawFacts(s, body!, c, [
          ["description", current.description || "(none)"],
          ["visibility", current.visibility],
          ["default branch", current.defaultBranch],
          [
            "protection",
            current.protectDefault ? "on — no force pushes or deletion" : "off",
          ],
          [
            "require review",
            current.requireReview
              ? "on — a pull needs an approval of its current head"
              : "off",
          ],
        ]);
        return;
      }
      if (tab === 1) {
        drawList(
          s,
          body!,
          c,
          state,
          labels.map((l) => ({ title: l.name, meta: `#${l.color}` })),
        );
        hitList(ctx, body!, state, labels.length, {});
        labels.slice(state.offset, state.offset + body!.h).forEach((l, i) => {
          labelChip(
            s,
            body!.x + body!.w - 24,
            body!.y + i,
            c,
            { text: l.name, color: l.color },
            body!.x + body!.w - 1,
          );
        });
        return;
      }
      if (tab === 2) {
        drawList(
          s,
          body!,
          c,
          state,
          hooks.map((hook) => ({
            title: hook.url,
            secondary: hook.kinds,
            meta: lastDelivery(deliveries.get(hook.id) ?? []),
          })),
        );
        hitList(ctx, body!, state, hooks.length, {});
        return;
      }
      s.text(
        body!.x,
        body!.y,
        truncate(
          `Deleting ${current.ownerName}/${current.name} removes its issues, pulls and hooks.`,
          body!.w,
        ),
        style(c.danger, c.bg),
        body!.x + body!.w,
      );
      s.text(
        body!.x,
        body!.y + 2,
        "Press X and type the repository name to confirm.",
        style(c.mutedFg, c.bg),
        body!.x + body!.w,
      );
    },
    key(e) {
      if (e.key === "tab") {
        tab = (tab + 1) % TABS.length;
        state.index = 0;
        return true;
      }
      if (tab === 0) return generalKey(e);
      if (tab === 1) return labelsKey(e);
      if (tab === 2) return hooksKey(e);
      if (e.key === "X") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Delete repository",
            label: `Type ${current.name} to confirm`,
            onSubmit: (value) => {
              if (value !== current.name) return "that is not the name";
              return (async () => {
                const gone = await deleteRepo(f.app, f.user, current);
                if (!gone.ok) ctx.toast(errorText(gone.error), "danger");
                else {
                  ctx.toast(`deleted ${current.name}`, "success");
                  ctx.pop();
                  ctx.pop();
                }
              })();
            },
          }),
        );
        return true;
      }
      return false;
    },
  };

  function generalKey(e: KeyEvent): boolean {
    const key = e.key;
    if (key === "d") {
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Description",
          label: "Description",
          value: current.description,
          onSubmit: (value) => {
            save({ description: value });
            return undefined;
          },
        }),
      );
      return true;
    }
    if (key === "v") {
      save({
        visibility: current.visibility === "public" ? "private" : "public",
      });
      return true;
    }
    if (key === "p") {
      save({ protectDefault: !current.protectDefault });
      return true;
    }
    // The gate `mergePull` enforces: with this on, a pull with no approval
    // of its *current* head is refused, here and on every other surface.
    if (key === "R") {
      save({ requireReview: !current.requireReview });
      return true;
    }
    if (key === "b") {
      ctx.push(
        refPickerScreen(
          f,
          ctx,
          screen,
          local(f, current),
          (chosen) => save({ defaultBranch: chosen }),
          { branchesOnly: true, title: "Default branch" },
        ),
      );
      return true;
    }
    return false;
  }

  function labelsKey(e: KeyEvent): boolean {
    const key = e.key;
    if (state.key(e, labels.length)) return true;
    if (key === "n") {
      ctx.push(
        promptScreen(ctx, screen, {
          title: "New label",
          label: "name #rrggbb",
          placeholder: "bug d73a4a",
          hint: "A name, a space, and a six-digit hex colour.",
          onSubmit: (value) => {
            const [name, color] = value.split(/\s+/);
            if (!name) return "a name is required";
            const created = createLabel(
              f.app,
              f.user,
              current,
              name,
              (color ?? "6b7280").replace("#", ""),
            );
            if (!created.ok) return errorText(created.error);
            reload();
            return undefined;
          },
        }),
      );
      return true;
    }
    if (key === "D") {
      const label = labels[state.index];
      if (!label) return true;
      const removed = deleteLabel(f.app, f.user, current, label.id);
      if (!removed.ok) ctx.toast(errorText(removed.error), "danger");
      else reload();
      return true;
    }
    return false;
  }

  function hooksKey(e: KeyEvent): boolean {
    const key = e.key;
    if (state.key(e, hooks.length)) return true;
    if (key === "n") {
      ctx.push(
        promptScreen(ctx, screen, {
          title: "New webhook",
          label: "URL [event filter]",
          placeholder: "https://example.com/hook push,issue.*",
          onSubmit: (value) => {
            const [url, kinds] = value.split(/\s+/);
            if (!url) return "a URL is required";
            const created = createWebhook(f.app, f.user, current, {
              url,
              ...(kinds === undefined ? {} : { kinds }),
            });
            if (!created.ok) return errorText(created.error);
            reload();
            // The only moment the secret exists in the clear.
            ctx.push(
              confirmScreen(ctx, screen, {
                title: "Signing secret",
                body: [
                  "Copy this now — it is never shown again.",
                  "",
                  created.value.secret,
                ],
                actions: [{ label: "Done" }],
                onChoose: () => undefined,
              }),
            );
            return undefined;
          },
        }),
      );
      return true;
    }
    if (key === "D") {
      const hook = hooks[state.index];
      if (!hook) return true;
      ctx.push(
        confirmScreen(ctx, screen, {
          title: "Delete webhook",
          body: [hook.url],
          actions: [
            { label: "Cancel", variant: "ghost" },
            { label: "Delete", variant: "danger" },
          ],
          onChoose: (choice) => {
            if (choice !== 1) return;
            const removed = deleteWebhook(f.app, f.user, current, hook.id);
            if (!removed.ok) ctx.toast(errorText(removed.error), "danger");
            else reload();
          },
        }),
      );
      return true;
    }
    return false;
  }

  return screen;
}

/** The most recent delivery, as one cell: state, HTTP status, attempts. */
function lastDelivery(deliveries: readonly DeliveryInfo[]): string {
  const hit = deliveries[0];
  if (!hit) return "no deliveries";
  const code = hit.lastStatus === null ? "" : ` ${hit.lastStatus}`;
  return `${hit.kind} ${hit.state}${code} (${hit.attempts})`;
}
