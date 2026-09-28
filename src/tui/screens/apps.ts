/**
 * Every app this session can see, and the way to make a new one.
 *
 * An app row is a repository row with one more fact: whether it is running.
 * That fact is read from the runtime's in-memory picture, never from a row
 * (a process is not state — docs/APPS.md), and the app records for the
 * whole page come from one grouped query, so the list costs the same at
 * two apps as at two hundred.
 *
 * `n` is the golden path's first step as a flow of small modals: a name, an
 * optional sentence, who may see it, who works on it. Each is one screen
 * that does one thing, and the whole is a single `newApp` call at the end.
 */

import { newApp } from "../../actions/apps.ts";
import { listAllAgents } from "../../actions/crew.ts";
import { planningAvailable } from "../../crew/plan.ts";
import type { Agent } from "../../core/agents.ts";
import { appsForRepos, type AppRecord } from "../../core/apps.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import {
  appsRuntime,
  type EnvState,
  type EnvStatus,
} from "../../apps/runtime.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { icon, type IconSet } from "../ui/icons.ts";
import { emptyState, type Tone } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  drawList,
  errorText,
  hitList,
  later,
  live,
  metaOf,
  pickerScreen,
  plural,
  promptScreen,
  runAsync,
  type ListRow,
} from "./common.ts";
import { appScreen } from "./app.ts";
import { repoScreen } from "./repo.ts";
import { RUN_EVENTS } from "./runs.ts";
import { local } from "./where.ts";
import { openAppTerminal } from "./apptty.ts";

/** The event kinds that change what an app list or an app screen shows. */
export const APP_EVENTS: readonly string[] = [
  ...RUN_EVENTS,
  "app.created",
  "app.updated",
  "app.deleted",
  "app.stopped",
];

/** The tone an environment's state wears; `stopped` wears none. */
export function envTone(state: EnvState): Tone | undefined {
  switch (state) {
    case "running":
      return "success";
    case "deploying":
      return "attn";
    case "failed":
      return "danger";
    case "stopped":
      return undefined;
  }
}

export interface AppItem {
  readonly repo: Repo;
  readonly app: AppRecord;
  /** Production's state, or undefined before the runtime has looked at it. */
  readonly production: EnvStatus | undefined;
  readonly previews: number;
  readonly url: string;
  /** False when apps are off on this forge: nothing runs, rows still exist. */
  readonly serving: boolean;
}

/**
 * Every app among the repositories the session may read. Visibility is the
 * repository's, decided by `listReposVisibleTo`, exactly as the dashboard's
 * repo list decides it — an app is never more visible than its code. A
 * caller that already listed the repositories hands them in, so a page
 * that shows both never asks for the same rows (and their counts) twice.
 */
export function listVisibleApps(
  f: Session,
  repos: readonly Repo[] = listReposVisibleTo(f.db, f.user, { limit: 200 }),
): AppItem[] {
  const records = appsForRepos(
    f.db,
    repos.map((repo) => repo.id),
  );
  const runtime = appsRuntime(f.app);
  const out: AppItem[] = [];
  for (const repo of repos) {
    const app = records.get(repo.id);
    if (app === undefined) continue;
    const envs = runtime === undefined ? [] : runtime.status(app);
    const production = envs.find((env) => env.env === "production");
    out.push({
      repo,
      app,
      production,
      previews: envs.length - (production === undefined ? 0 : 1),
      url: runtime === undefined ? "" : runtime.urlFor(app, "production"),
      serving: runtime !== undefined,
    });
  }
  return out;
}

/** The word an app row wears for its production state. */
export function appStateWord(item: AppItem): string {
  if (!item.serving) return "off";
  if (item.production === undefined) return "not started";
  return item.production.state;
}

/** An app as a list row — the dashboard pane and the apps screen share it. */
export function appRow(item: AppItem, set: IconSet): ListRow {
  const tone =
    item.serving && item.production !== undefined
      ? envTone(item.production.state)
      : undefined;
  return {
    title: `${set === "nerd" ? `${icon("repo", set)} ` : ""}${item.repo.ownerName}/${item.repo.name}`,
    ...(tone === undefined ? { hollow: true } : { tone }),
    secondary: item.url,
    meta: metaOf(
      appStateWord(item),
      item.previews > 0 ? plural(item.previews, "preview") : "",
    ),
  };
}

export function appsScreen(f: Session, ctx: Ctx): Screen {
  let apps: AppItem[] = [];
  const state = new ListState();
  const filter = new Filter();

  const reload = (): void => {
    apps = listVisibleApps(f);
    ctx.invalidate();
  };

  const shown = (): AppItem[] =>
    apps.filter((item) =>
      filter.matches(`${item.repo.ownerName}/${item.repo.name}`),
    );

  const open = (item: AppItem | undefined): void => {
    if (item !== undefined) ctx.push(appScreen(f, ctx, item.repo));
  };

  const screen: Screen = {
    title: "Apps",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        binding(["t"], "terminal"),
        binding(["n"], "new app", { disabled: !f.signedIn }),
        binding(["/"], "filter"),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      live(f, signal, { kinds: APP_EVENTS }, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [box, list] = split(area, "v", [len(1), fill(1)]);
      ctx.setCursor(filter.render(s, box!, c, "filter apps"));
      const rows = shown();
      if (rows.length === 0) {
        emptyState(s, list!, c, {
          title: filter.on ? "Nothing matches" : "No apps yet",
          body: filter.on
            ? ""
            : f.signedIn
              ? "Press n to make one — a repository that runs."
              : "Sign in to make one — a repository that runs.",
        });
        return;
      }
      drawList(
        s,
        list!,
        c,
        state,
        rows.map((item) => appRow(item, ctx.icons)),
      );
      hitList(ctx, list!, state, rows.length, {
        open: (index) => open(rows[index]),
      });
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      if (state.key(e, shown().length)) return true;
      if (e.key === "enter") {
        open(shown()[state.index]);
        return true;
      }
      if (e.key === "t") {
        const item = shown()[state.index];
        if (item) void openAppTerminal(f, ctx, item.repo, "production");
        return true;
      }
      if (e.key === "n" && f.signedIn) {
        newAppFlow(f, ctx, screen);
        return true;
      }
      if (e.key === "r") {
        reload();
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** An agent as a picker row: the bot mark where the font has one. */
export function agentPick(
  agent: Agent,
  set: IconSet,
): { id: string; label: string; hint: string } {
  return {
    id: agent.user.username,
    label:
      set === "nerd"
        ? `${icon("bot", set)} ${agent.user.username}`
        : agent.user.username,
    hint: metaOf("agent", agent.model === "" ? "" : agent.model),
  };
}

/**
 * New app, as four modals and one call. Each prompt hands its answer to the
 * next through the closure; nothing is created until the last one answers,
 * so Esc anywhere leaves the forge exactly as it was.
 */
export function newAppFlow(f: Session, ctx: Ctx, parent: Screen): void {
  const create = (input: {
    name: string;
    description: string;
    visibility: "public" | "private";
    agent: string | undefined;
    pickAgent?: boolean;
  }): void => {
    runAsync(ctx, async () => {
      ctx.toast(`creating ${input.name}…`);
      const made = await newApp(f.app, f.user, {
        name: input.name,
        visibility: input.visibility,
        ...(input.description === "" ? {} : { description: input.description }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.pickAgent ? { pickAgent: true } : {}),
      });
      if (!made.ok) {
        ctx.toast(errorText(made.error), "danger");
        return;
      }
      const runtime = appsRuntime(f.app);
      const url =
        runtime === undefined
          ? undefined
          : runtime.urlFor(made.value.app, "production");
      const where =
        url === undefined
          ? "apps are off on this forge, so nothing is running"
          : `starting at ${url}`;
      const who = made.value.plan
        ? ` · ${made.value.plan.agent} was picked — ${made.value.plan.summary}`
        : input.agent === undefined
          ? made.value.issue === undefined
            ? ""
            : ` · #${made.value.issue.number} is waiting for someone`
          : made.value.issue === undefined
            ? ` · ${input.agent} is on the crew`
            : ` · ${input.agent} is on #${made.value.issue.number}`;
      ctx.toast(`${input.name}: ${where}${who}`, "success");
      ctx.push(repoScreen(f, ctx, local(f, made.value.repo)));
    });
  };

  const askAgent = (
    input: Parameters<typeof create>[0],
    agents: readonly Agent[],
  ): void => {
    if (agents.length === 0) {
      create(input);
      return;
    }
    const canPick =
      input.description !== "" &&
      planningAvailable(process.env["FORGE_CLAUDE"] ?? "claude");
    ctx.push(
      pickerScreen(ctx, parent, {
        title: "Who works on it?",
        items: [
          ...(canPick
            ? [
                {
                  id: "__pick__",
                  label: "Pick for me",
                  hint: "turns the sentence into a checklist and picks",
                },
              ]
            : []),
          { id: "", label: "nobody yet", hint: "you can add crew later" },
          ...agents.map((agent) => agentPick(agent, ctx.icons)),
        ],
        onPick: ([chosen]) =>
          chosen === "__pick__"
            ? create({ ...input, agent: undefined, pickAgent: true })
            : create({
                ...input,
                agent: chosen === undefined || chosen === "" ? undefined : chosen,
              }),
      }),
    );
  };

  const askVisibility = (name: string, description: string): Screen =>
    pickerScreen(ctx, parent, {
      title: "Who may see it?",
      items: [
        { id: "private", label: "private", hint: "you and the crew" },
        { id: "public", label: "public", hint: "anyone" },
      ],
      onPick: ([chosen]) => {
        const listed = listAllAgents(f.app, f.user);
        askAgent(
          {
            name,
            description,
            visibility: chosen === "public" ? "public" : "private",
            agent: undefined,
          },
          listed.ok ? listed.value : [],
        );
      },
    });

  const askDescription = (name: string): Screen =>
    promptScreen(ctx, parent, {
      title: `What should ${name} do?`,
      label: "One sentence — optional",
      placeholder: "A place for notes",
      hint: "Becomes the first issue, handed to an agent on the crew.",
      onSubmit: (description) =>
        later(ctx, () => askVisibility(name, description)),
    });

  ctx.push(
    promptScreen(ctx, parent, {
      title: "New app",
      label: "Name",
      placeholder: "notes",
      hint: "Letters, digits, dot, dash, underscore. Its URL is built from this.",
      onSubmit: (name) => {
        if (name === "") return "a name is required";
        return later(ctx, () => askDescription(name));
      },
    }),
  );
}
