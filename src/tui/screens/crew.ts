/**
 * The crew: every agent on this forge, and the admin's three verbs over
 * them — make one, change one, retire one.
 *
 * An agent is an account that acts, so the screen is a forge admin's; the
 * actions refuse anyone else and this screen says so rather than hiding
 * the keys and leaving a person wondering. The first line says whether the
 * crew can work at all — a Claude Code was found, or it was not and here is
 * why — because assigning an issue to an agent that cannot run is the one
 * mistake worth preventing before it is made (docs/APPS.md).
 */

import {
  createAgent,
  deleteAgent,
  listAllAgents,
  updateAgent,
} from "../../actions/crew.ts";
import { crewFor } from "../../crew/dispatch.ts";
import type { Agent } from "../../core/agents.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { ITALIC, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { icon } from "../ui/icons.ts";
import { dot, emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  confirmScreen,
  drawList,
  errorText,
  hitList,
  later,
  live,
  metaOf,
  pickerScreen,
  promptScreen,
  runAsync,
  type ListRow,
} from "./common.ts";

const CREW_EVENTS: readonly string[] = [
  "agent.created",
  "agent.updated",
  "agent.deleted",
];

/** What `n` asks, in order. */
const NEW_AGENT: readonly { key: string; label: string; hint: string }[] = [
  {
    key: "username",
    label: "Username",
    hint: "How it signs its pulls and comments.",
  },
  {
    key: "displayName",
    label: "Display name",
    hint: "Optional; the username otherwise.",
  },
  {
    key: "model",
    label: "Model",
    hint: "A Claude Code model alias or id. Empty means the runner's default.",
  },
  {
    key: "brief",
    label: "Brief",
    hint: "A sentence or two in its own voice: who it is, how it works.",
  },
  {
    key: "budget",
    label: "Budget per run (USD)",
    hint: "Empty means the forge's default (FORGE_CREW_BUDGET_USD).",
  },
];

/** `$5.00/run`, or the forge's default said as such. */
export function budgetText(budgetUsd: number): string {
  return budgetUsd > 0 ? `$${budgetUsd.toFixed(2)}/run` : "default budget";
}

export function crewScreen(f: Session, ctx: Ctx): Screen {
  let agents: Agent[] = [];
  let failed: string | undefined;
  const state = new ListState();
  const admin = (): boolean => f.user?.isAdmin === true;

  const reload = (): void => {
    const read = listAllAgents(f.app, f.user);
    if (!read.ok) {
      failed = errorText(read.error);
      ctx.invalidate();
      return;
    }
    failed = undefined;
    agents = read.value;
    state.clamp(agents.length);
    ctx.invalidate();
  };

  const selected = (): Agent | undefined => agents[state.index];

  /**
   * Five prompts, one call. The prompts are a list walked by index, each
   * handing the next one on after the previous has popped; Esc anywhere
   * makes nothing.
   */
  const create = (): void => {
    const answers: Record<string, string> = {};
    const step = (i: number): Screen => {
      const field = NEW_AGENT[i]!;
      return promptScreen(ctx, screen, {
        title: "New agent",
        label: field.label,
        hint: field.hint,
        // The display name defaults to the username just typed.
        value: field.key === "displayName" ? (answers["username"] ?? "") : "",
        onSubmit: (value) => {
          if (field.key === "username" && value === "")
            return "a username is required";
          if (
            field.key === "budget" &&
            value !== "" &&
            !Number.isFinite(Number(value))
          )
            return errorText("invalid_budget");
          answers[field.key] = value;
          if (i + 1 < NEW_AGENT.length) return later(ctx, () => step(i + 1));
          return finish();
        },
      });
    };
    const finish = async (): Promise<void> => {
      const username = answers["username"] ?? "";
      const displayName = answers["displayName"] ?? "";
      const model = answers["model"] ?? "";
      const brief = answers["brief"] ?? "";
      const budget = answers["budget"] ?? "";
      ctx.toast(`creating ${username}…`);
      const made = await createAgent(f.app, f.user, {
        username,
        ...(displayName === "" ? {} : { displayName }),
        ...(model === "" ? {} : { model }),
        ...(brief === "" ? {} : { brief }),
        ...(budget === "" ? {} : { budgetUsd: Number(budget) }),
      });
      if (!made.ok) {
        ctx.toast(errorText(made.error), "danger");
        return;
      }
      ctx.toast(
        `${made.value.user.username} is on the crew — add it to a repository to give it work`,
        "success",
      );
      reload();
    };
    ctx.push(step(0));
  };

  /** `enter`: which fact to change, then the new value. */
  const edit = (agent: Agent | undefined): void => {
    if (agent === undefined) return;
    const name = agent.user.username;
    ctx.push(
      pickerScreen(ctx, screen, {
        title: `Edit ${name}`,
        items: [
          { id: "model", label: "model", hint: agent.model || "default" },
          {
            id: "brief",
            label: "brief",
            hint: firstLine(agent.brief) || "none",
          },
          {
            id: "budget",
            label: "budget per run",
            hint: budgetText(agent.budgetUsd),
          },
        ],
        onPick: ([field]) => {
          if (field === undefined) return;
          ctx.push(
            promptScreen(ctx, screen, {
              title: `${name} · ${field}`,
              label:
                field === "model"
                  ? "Model (empty for the default)"
                  : field === "brief"
                    ? "Brief"
                    : "Budget per run (USD; 0 for the default)",
              value:
                field === "model"
                  ? agent.model
                  : field === "brief"
                    ? agent.brief
                    : agent.budgetUsd === 0
                      ? ""
                      : String(agent.budgetUsd),
              onSubmit: (value) => {
                const patch =
                  field === "model"
                    ? { model: value }
                    : field === "brief"
                      ? { brief: value }
                      : { budgetUsd: value === "" ? 0 : Number(value) };
                if ("budgetUsd" in patch && !Number.isFinite(patch.budgetUsd))
                  return errorText("invalid_budget");
                const done = updateAgent(f.app, f.user, name, patch);
                if (!done.ok) return errorText(done.error);
                ctx.toast(`${name} updated`, "success");
                reload();
                return undefined;
              },
            }),
          );
        },
      }),
    );
  };

  const retire = (agent: Agent | undefined): void => {
    if (agent === undefined) return;
    const name = agent.user.username;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `Retire ${name}`,
        body: [
          "Its tokens are revoked and it leaves every crew.",
          "Pulls and comments it wrote stay, in its name.",
        ],
        actions: [
          { label: "Keep it", variant: "ghost" },
          { label: "Retire", variant: "danger" },
        ],
        onChoose: (choice) => {
          if (choice !== 1) return;
          const gone = deleteAgent(f.app, f.user, name);
          if (!gone.ok) ctx.toast(errorText(gone.error), "danger");
          else {
            ctx.toast(`${name} retired`, "success");
            reload();
          }
        },
      }),
    );
  };

  const screen: Screen = {
    title: "Crew",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["n"], "new agent", { disabled: !admin() }),
        binding(["enter"], "edit", { disabled: !admin() }),
        binding(["d"], "retire", { disabled: !admin() }),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      live(f, signal, { kinds: CREW_EVENTS }, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(2), fill(1)]);
      const right = head!.x + head!.w;
      // The first line is whether the crew can work at all.
      const handle = crewFor(f.app);
      const ready = handle?.ready === true;
      let x = dot(s, head!.x, head!.y, c, {
        ...(handle === undefined
          ? { hollow: true }
          : { tone: ready ? "success" : "danger" }),
      });
      s.text(
        x + 1,
        head!.y,
        truncate(
          handle === undefined
            ? "the crew is not running on this forge — agents can be made, but nothing will work until it is"
            : ready
              ? `${handle.detail} — agents can work`
              : `Claude Code is not usable: ${handle.detail}`,
          Math.max(0, right - x - 1),
        ),
        style(handle === undefined ? c.mutedFg : ready ? c.fg : c.danger, c.bg),
        right,
      );
      if (!admin())
        s.text(
          head!.x,
          head!.y + 1,
          truncate("only a forge admin can change the crew", head!.w),
          style(c.faint, c.bg, ITALIC),
          right,
        );
      if (failed !== undefined) {
        emptyState(s, list!, c, { title: failed });
        return;
      }
      if (agents.length === 0) {
        emptyState(s, list!, c, {
          title: "No agents yet",
          body: admin()
            ? "Press n to make one: a name, a model, a brief."
            : "A forge admin makes them.",
        });
        return;
      }
      const set = ctx.icons;
      drawList(
        s,
        list!,
        c,
        state,
        agents.map(
          (agent): ListRow => ({
            title:
              set === "nerd"
                ? `${icon("bot", set)} ${agent.user.username}`
                : agent.user.username,
            secondary: firstLine(agent.brief),
            meta: metaOf(
              agent.model === "" ? "default model" : agent.model,
              budgetText(agent.budgetUsd),
            ),
          }),
        ),
      );
      hitList(ctx, list!, state, agents.length, {
        open: (index) => edit(agents[index]),
      });
    },
    key(e) {
      if (state.key(e, agents.length)) return true;
      if (e.key === "n" && admin()) {
        create();
        return true;
      }
      if (e.key === "enter" && admin()) {
        edit(selected());
        return true;
      }
      if (e.key === "d" && admin()) {
        retire(selected());
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => reload());
        return true;
      }
      return false;
    },
  };
  return screen;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}
