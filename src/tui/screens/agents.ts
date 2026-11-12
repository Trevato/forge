/**
 * Crew agents in the terminal, a forge admin's: each agent's model, budget and
 * the first line of its brief, as MCP `agent` and /api/v1/agents have them.
 * `m`, `b` and `B` change model, budget and brief, `r` its roles (planner,
 * builder, reviewer: what a repository's team lists offer it for), `n` creates one and `d`
 * removes one. Every change shows its plan and applies only after a confirm,
 * through `updateAgent`, `createAgent` and `deleteAgent`, so the same bounds
 * apply and a refusal is said in MCP's words (the error code).
 */

import { checkPatch, createAgent, deleteAgent, listAllAgents, updateAgent } from "../../actions/crew.ts";
import { fundingOf, fundingWords } from "../../spawn/funding.ts";
import { CREW_ROLES, type AgentPatch } from "../../core/agents.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const firstLine = (brief: string) => brief.split("\n").find((l) => l.trim() !== "")?.trim() ?? "no brief";

export function agentsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const allowed = () => f.user?.isAdmin === true && f.user.kind !== "agent";
  const read = () => (allowed() ? listAllAgents(f.app, f.user) : undefined);
  const list = () => {
    const r = read();
    return r?.ok ? r.value : [];
  };

  const rows = (): ListRow[] =>
    list().map((a) => ({
      title: a.user.username,
      secondary: `${a.roles.join("+")} · ${a.model === "" ? "default model" : a.model} · ${a.budgetUsd === 0 ? "default budget" : `$${a.budgetUsd}`}`,
      meta: firstLine(a.brief),
    }));

  const screen: Screen = {
    title: "Crew agents",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["m"], "model"),
      binding(["b"], "budget"),
      binding(["B"], "brief"),
      binding(["r"], "roles"),
      binding(["n"], "new"),
      binding(["d"], "remove"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const funded = fundingOf(f.app.config.dataDir);
      const base = allowed() ? "The crew's settings; each change asks first." : "Agents are set by a forge admin.";
      const text = note !== "" ? note : funded === undefined ? base : `${base} ${fundingWords(funded)}`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      const agents = list();
      if (state.key(e, agents.length)) return true;
      if (e.ctrl || e.alt || !allowed()) return false;
      const ask = (title: string, label: string, value: string, onSubmit: (v: string) => string | undefined | Promise<void>) =>
        ctx.push(promptScreen(ctx, screen, { title, label, value, onSubmit }));
      if (e.key === "n") {
        ask("New agent", "username", "", (name) => {
          const username = name.trim();
          if (username === "") return "a username is needed";
          return later(ctx, () =>
            promptScreen(ctx, screen, {
              title: username,
              label: "model (empty: the runner's default)",
              onSubmit: async (model) => {
                const made = await createAgent(f.app, f.user, { username, ...(model.trim() === "" ? {} : { model: model.trim() }) });
                note = made.ok ? `${username} created.` : `refused: ${made.error}`;
                ctx.invalidate();
              },
            }),
          );
        });
        return true;
      }
      const agent = agents[state.index];
      if (agent === undefined) return false;
      const name = agent.user.username;
      if (e.key === "m")
        ask(name, "model", agent.model, (v) => {
          const model = v.trim();
          const bad = checkPatch(f.app, { model });
          if (!bad.ok) return `refused: ${bad.error}`;
          return later(ctx, () => confirm(name, { model }, `${name}: model ${agent.model || "default"} → ${model || "default"}. y/n`));
        });
      else if (e.key === "b")
        ask(name, "budget in USD per run (0: the forge's default)", String(agent.budgetUsd), (v) => {
          const budgetUsd = v.trim() === "" ? Number.NaN : Number(v);
          const bad = checkPatch(f.app, { budgetUsd });
          if (!bad.ok) return `refused: ${bad.error}`;
          return later(ctx, () => confirm(name, { budgetUsd }, `${name}: budget $${agent.budgetUsd} → $${budgetUsd}. y/n`));
        });
      else if (e.key === "B")
        ask(name, "brief", agent.brief.replace(/\n/g, " "), (v) => {
          const bad = checkPatch(f.app, { brief: v });
          if (!bad.ok) return `refused: ${bad.error}`;
          return later(ctx, () => confirm(name, { brief: v }, `${name}: brief → "${truncate(v, 60)}". y/n`));
        });
      else if (e.key === "r")
        ask(name, `roles: ${CREW_ROLES.join(", ")} (comma separated)`, agent.roles.join(", "), (v) => {
          const roles = v.split(",").map((r) => r.trim()).filter((r) => r !== "");
          const bad = checkPatch(f.app, { roles });
          if (!bad.ok) return `refused: ${bad.error}`;
          return later(ctx, () => confirm(name, bad.value, `${name}: roles ${agent.roles.join("+")} → ${roles.join("+")}. y/n`));
        });
      else if (e.key === "d")
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Remove agent",
            body: [`Remove ${name}? This cannot be undone. y/n`],
            actions: [{ label: "Remove", variant: "danger" }, { label: "Cancel", variant: "ghost" }],
            yesNo: true,
            onChoose(i) {
              if (i !== 0) return;
              const gone = deleteAgent(f.app, f.user, name);
              note = gone.ok ? `${name} removed.` : `refused: ${gone.error}`;
              state.index = Math.max(0, Math.min(state.index, list().length - 1));
              ctx.invalidate();
            },
          }),
        );
      else return false;
      return true;
    },
  };
  const confirm = (username: string, patch: AgentPatch, plan: string): Screen =>
    confirmScreen(ctx, screen, {
      title: "Change agent",
      body: [plan],
      actions: [{ label: "Apply" }, { label: "Cancel", variant: "ghost" }],
      yesNo: true,
      onChoose(i) {
        if (i !== 0) return;
        const done = updateAgent(f.app, f.user, username, patch);
        note = done.ok ? `${username} saved.` : `refused: ${done.error}`;
        ctx.invalidate();
      },
    });
  return screen;
}

/** Crew agents, as MCP `agent` has them: an admin who is not an agent. */
export const entry: PaletteEntry = {
  id: "agents",
  title: "Crew agents",
  hint: "each agent's model, budget and brief",
  after: ["teams", "limits", "quotas", "people"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(agentsScreen(session, ctx)),
};
