/**
 * Forge it, from a repository screen's `:` palette: the terminal's door to
 * the Forge button beside Fork. A confirm, then the spawn door as the page
 * calls it, and the claim link shown once.
 */

import type { Repo } from "../../core/repos.ts";
import { forgeIt, forgeNameOf } from "../../spawn/forge_it.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { confirmScreen, linkScreen, runAsync } from "./common.ts";

export function forgeItScreen(f: Session, ctx: Ctx, repo: Repo, parent: Screen): Screen {
  const from = `${repo.ownerName}/${repo.name}`;
  return confirmScreen(ctx, parent, {
    title: "Forge it",
    body: [
      `A fresh forge, ${forgeNameOf(repo.name)}, with ${from} as its app.`,
      "You get its claim link once; whoever opens it becomes the admin.",
    ],
    actions: [{ label: "Forge it" }, { label: "Cancel" }],
    onChoose: (choice) => {
      if (choice !== 0 || f.user === undefined) return;
      const user = f.user;
      runAsync(ctx, async () => {
        const url = new URL(f.app.config.url ?? `http://${f.app.config.host ?? "localhost"}`);
        const made = await forgeIt(
          {
            app: f.app,
            request: new Request(url.href, { method: "POST" }),
            url,
            params: {},
            auth: { user, scope: undefined, via: "none" as const },
            theme: undefined,
          },
          user,
          repo,
        );
        if (made.status >= 400) return ctx.toast(String(made.body["message"] ?? "it could not be made"), "danger");
        const link = made.body["claimUrl"];
        if (typeof link !== "string")
          return ctx.toast(`${String(made.body["name"])} was forged before; its link is not shown again`, "attn");
        ctx.toast(`${String(made.body["name"])} is ready`, "success");
        ctx.replace(linkScreen(ctx, link));
      });
    },
  });
}

export function forgeItCommands(f: Session, ctx: Ctx, repo: Repo | undefined, parent: () => Screen): Command[] {
  if (repo === undefined || f.user === undefined || f.user.kind !== "user") return [];
  return [
    {
      id: "forge-it",
      title: `${repo.ownerName}/${repo.name} — Forge it`,
      hint: "a fresh forge with it as the app",
      run: () => ctx.push(forgeItScreen(f, ctx, repo, parent())),
    },
  ];
}
