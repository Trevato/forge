/**
 * Repository settings: the four groups the web surface carries, as four tabs.
 *
 * Two rules are load-bearing. A webhook secret is shown exactly once, in a
 * dialog, because that is the only moment it exists in the clear. And
 * deleting a repo requires typing its name — the one place in the TUI where a
 * confirmation is deliberately more work than pressing Enter.
 */

import {
  disableApp,
  enableApp,
  updateAppSettings,
} from "../../actions/apps.ts";
import {
  addToCrew,
  listAllAgents,
  listCrew,
  removeFromCrew,
} from "../../actions/crew.ts";
import {
  createLabel,
  createWebhook,
  deleteLabel,
  deleteRepo,
  deleteWebhook,
  updateRepoSettings,
} from "../../actions/repos.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import type { PreviewData } from "../../apps/data.ts";
import type { Agent } from "../../core/agents.ts";
import {
  getAppByRepo,
  slugFor,
  type AppAccess,
  type AppRecord,
} from "../../core/apps.ts";
import { listLabels, type Label } from "../../core/issues.ts";
import { getRepoById, type Repo } from "../../core/repos.ts";
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
import { agentPick } from "./apps.ts";
import {
  ListState,
  confirmScreen,
  drawFacts,
  drawList,
  hitList,
  errorText,
  later,
  metaOf,
  pickerScreen,
  promptScreen,
  runAsync,
} from "./common.ts";
import { budgetText } from "./crew.ts";
import { refPickerScreen } from "./refs.ts";
import { local } from "./where.ts";

const TABS = [
  "General",
  "Labels",
  "Webhooks",
  "App",
  "Crew",
  "Danger",
] as const;

export function settingsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let current = repo;
  let labels: Label[] = [];
  let hooks: Webhook[] = [];
  let deliveries = new Map<string, DeliveryInfo[]>();
  /** The app row, when this repository runs as one. */
  let app: AppRecord | undefined;
  let crew: Agent[] = [];
  let tab = 0;
  const state = new ListState();

  const reload = (): void => {
    // The row handed down a stack is a snapshot; a change made on the web,
    // or by another terminal, must show here without re-entering the screen.
    current = getRepoById(f.db, current.id) ?? current;
    labels = listLabels(f.db, current.id);
    hooks = listWebhooks(f.db, current.id);
    deliveries = new Map(
      hooks.map((hook) => [hook.id, recentDeliveries(f.db, hook.id, 3)]),
    );
    app = getAppByRepo(f.db, current.id);
    const agents = listCrew(f.app, f.user, current);
    crew = agents.ok ? agents.value : [];
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
          binding(["C"], "require checks"),
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
      if (tab === 3)
        return app === undefined
          ? [binding(["tab"], "next tab"), binding(["e"], "run as an app")]
          : [
              binding(["tab"], "next tab"),
              binding(["s"], "slug"),
              binding(["a"], "access"),
              binding(["p"], "preview data"),
              binding(["D"], "stop running as an app"),
            ];
      if (tab === 4)
        return [
          binding(["tab"], "next tab"),
          binding(["a"], "add an agent"),
          binding(["d"], "remove", { disabled: crew.length === 0 }),
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
          [
            "require checks",
            current.requireChecks
              ? "on — a pull needs a passing deploy of its current head"
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
      if (tab === 3) {
        drawAppTab(s, body!, c);
        return;
      }
      if (tab === 4) {
        drawCrewTab(s, body!, c);
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
      if (tab === 3) return appKey(e);
      if (tab === 4) return crewKey(e);
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
    // The second gate: with this on, a pull whose current head has no
    // passing deploy is refused `checks_required` — read live in `mergePull`.
    if (key === "C") {
      save({ requireChecks: !current.requireChecks });
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

  // ---- the app tab ----

  function drawAppTab(
    s: Parameters<typeof drawFacts>[0],
    body: Parameters<typeof drawFacts>[1],
    c: Parameters<typeof drawFacts>[2],
  ): void {
    const runtime = appsRuntime(f.app);
    if (app === undefined) {
      const lines = [
        "This repository does not run as an app.",
        "",
        "Press e to run it: production from the default branch, a preview per",
        "open pull, each with its own data directory. forge.json in the tree",
        "says how (docs/APPS.md); a package.json start script is enough.",
        ...(runtime === undefined ? ["", errorText("no_runtime")] : []),
      ];
      lines.forEach((line, i) => {
        if (i >= body.h) return;
        s.text(
          body.x,
          body.y + i,
          truncate(line, body.w),
          style(i === 0 ? c.fg : c.mutedFg, c.bg),
          body.x + body.w,
        );
      });
      return;
    }
    drawFacts(s, body, c, [
      ["app", "on — this repository runs"],
      ["slug", app.slug],
      [
        "access",
        app.access === "private"
          ? "private — only people who can read the repository"
          : "public — anyone with the URL",
      ],
      [
        "preview data",
        app.previewData === "copy"
          ? "copy — a preview starts from production's data"
          : "empty — a preview starts with nothing",
      ],
      [
        "production",
        runtime === undefined
          ? errorText("no_runtime")
          : runtime.urlFor(app, "production"),
      ],
    ]);
  }

  /** `e` — three prompts, then `enableApp`. Esc anywhere makes nothing. */
  const enable = (): void => {
    const askPreview = (slug: string, access: AppAccess): Screen =>
      pickerScreen(ctx, screen, {
        title: "What does a preview start with?",
        items: [
          {
            id: "copy",
            label: "a copy of production's data",
            hint: "copy-on-write where the disk allows",
          },
          { id: "empty", label: "nothing", hint: "an empty data directory" },
        ],
        onPick: ([chosen]) => {
          const previewData: PreviewData =
            chosen === "empty" ? "empty" : "copy";
          const made = enableApp(f.app, f.user, current, {
            slug,
            access,
            previewData,
          });
          if (!made.ok) {
            ctx.toast(errorText(made.error), "danger");
            return;
          }
          const runtime = appsRuntime(f.app);
          ctx.toast(
            runtime === undefined
              ? `${current.name} is an app; ${errorText("no_runtime")}`
              : `${current.name} is starting at ${runtime.urlFor(made.value, "production")}`,
            "success",
          );
          reload();
        },
      });
    // The repository's own visibility is the default, so it is offered first.
    const askAccess = (slug: string): Screen => {
      const choices = [
        {
          id: "private",
          label: "private",
          hint: "only people who can read the repository",
        },
        { id: "public", label: "public", hint: "anyone with the URL" },
      ];
      return pickerScreen(ctx, screen, {
        title: "Who may reach it?",
        items:
          current.visibility === "public" ? [...choices].reverse() : choices,
        onPick: ([chosen]) =>
          ctx.push(
            askPreview(slug, chosen === "public" ? "public" : "private"),
          ),
      });
    };
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Run as an app",
        label: "Slug — the hostname label",
        value: slugFor(current.name),
        hint: "Lowercase letters, digits, single hyphens: <slug>.<domain>",
        onSubmit: (slug) => {
          if (slug === "") return "a slug is required";
          return later(ctx, () => askAccess(slug));
        },
      }),
    );
  };

  const patchApp = (
    patch: Parameters<typeof updateAppSettings>[3],
    said: string,
  ): string | undefined => {
    const updated = updateAppSettings(f.app, f.user, current, patch);
    if (!updated.ok) return errorText(updated.error);
    ctx.toast(said, "success");
    reload();
    return undefined;
  };

  function appKey(e: KeyEvent): boolean {
    const key = e.key;
    if (app === undefined) {
      if (key === "e") {
        enable();
        return true;
      }
      return false;
    }
    const record = app;
    if (key === "s") {
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Slug",
          label: "Slug — the hostname label",
          value: record.slug,
          hint: "Every environment's URL changes with it.",
          onSubmit: (slug) => {
            if (slug === "") return "a slug is required";
            return patchApp({ slug }, `slug is now ${slug}`);
          },
        }),
      );
      return true;
    }
    if (key === "a") {
      const access: AppAccess =
        record.access === "private" ? "public" : "private";
      const said = patchApp({ access }, `the app is now ${access}`);
      if (said !== undefined) ctx.toast(said, "danger");
      return true;
    }
    if (key === "p") {
      const previewData: PreviewData =
        record.previewData === "copy" ? "empty" : "copy";
      const said = patchApp(
        { previewData },
        previewData === "copy"
          ? "new previews start from a copy of production's data"
          : "new previews start empty",
      );
      if (said !== undefined) ctx.toast(said, "danger");
      return true;
    }
    if (key === "D") {
      ctx.push(
        confirmScreen(ctx, screen, {
          title: "Stop running as an app",
          body: [
            "Production and every preview stop, and their data",
            "directories are removed. The repository is untouched.",
          ],
          actions: [
            { label: "Keep running", variant: "ghost" },
            { label: "Stop", variant: "danger" },
          ],
          onChoose: (choice) => {
            if (choice !== 1) return;
            const gone = disableApp(f.app, f.user, current);
            if (!gone.ok) ctx.toast(errorText(gone.error), "danger");
            else {
              ctx.toast(`${current.name} no longer runs as an app`, "success");
              reload();
            }
          },
        }),
      );
      return true;
    }
    return false;
  }

  // ---- the crew tab ----

  function drawCrewTab(
    s: Parameters<typeof drawFacts>[0],
    body: Parameters<typeof drawFacts>[1],
    c: Parameters<typeof drawFacts>[2],
  ): void {
    if (crew.length === 0) {
      const lines = [
        "No agents on this crew.",
        "",
        "Press a to add one from the forge's agents. An agent on the crew can",
        "read and write this repository, and starts working when an issue is",
        "assigned to it.",
      ];
      lines.forEach((line, i) => {
        if (i >= body.h) return;
        s.text(
          body.x,
          body.y + i,
          truncate(line, body.w),
          style(i === 0 ? c.fg : c.mutedFg, c.bg),
          body.x + body.w,
        );
      });
      return;
    }
    drawList(
      s,
      body,
      c,
      state,
      crew.map((agent) => {
        const pick = agentPick(agent, ctx.icons);
        return {
          title: pick.label,
          secondary: agent.brief.split("\n", 1)[0] ?? "",
          meta: metaOf(
            agent.model === "" ? "default model" : agent.model,
            budgetText(agent.budgetUsd),
          ),
        };
      }),
    );
    hitList(ctx, body, state, crew.length, {});
  }

  function crewKey(e: KeyEvent): boolean {
    const key = e.key;
    if (state.key(e, crew.length)) return true;
    if (key === "a") {
      const all = listAllAgents(f.app, f.user);
      if (!all.ok) {
        ctx.toast(errorText(all.error), "danger");
        return true;
      }
      const onCrew = new Set(crew.map((agent) => agent.user.id));
      const candidates = all.value.filter(
        (agent) => !onCrew.has(agent.user.id),
      );
      if (candidates.length === 0) {
        ctx.toast(
          all.value.length === 0
            ? "the forge has no agents yet — a forge admin makes them (:crew)"
            : "every agent on the forge is already on this crew",
          "attn",
        );
        return true;
      }
      ctx.push(
        pickerScreen(ctx, screen, {
          title: "Add to the crew",
          items: candidates.map((agent) => agentPick(agent, ctx.icons)),
          onPick: ([username]) => {
            if (username === undefined) return;
            const added = addToCrew(f.app, f.user, current, username);
            if (!added.ok) ctx.toast(errorText(added.error), "danger");
            else {
              ctx.toast(`${username} is on the crew`, "success");
              reload();
            }
          },
        }),
      );
      return true;
    }
    if (key === "d") {
      const agent = crew[state.index];
      if (!agent) return true;
      const name = agent.user.username;
      ctx.push(
        confirmScreen(ctx, screen, {
          title: `Remove ${name} from the crew`,
          body: [
            `${name} can no longer read or write this repository.`,
            "Its open pulls and comments stay.",
          ],
          actions: [
            { label: "Keep it", variant: "ghost" },
            { label: "Remove", variant: "danger" },
          ],
          onChoose: (choice) => {
            if (choice !== 1) return;
            const removed = removeFromCrew(f.app, f.user, current, name);
            if (!removed.ok) ctx.toast(errorText(removed.error), "danger");
            else {
              ctx.toast(`${name} is off the crew`, "success");
              reload();
            }
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
