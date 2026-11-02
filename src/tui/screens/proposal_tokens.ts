/**
 * Proposal tokens in the terminal: the ones you minted for a repository, with
 * `n` to mint (a child's name, then where it lives) and `x` to revoke the one
 * under the cursor, after a confirm that starts on Keep (`y` revokes, `n` or
 * esc keeps it). The secret is shown once, on a screen of its own. Every rule
 * is the action's (`actions/proposal_tokens.ts`), the same as the API's and
 * MCP's: a repository you do not write is "not visible to you", and nothing
 * is listed or changed.
 */

import {
  listProposals,
  mintProposal,
  repoByName,
  revokeProposal,
} from "../../actions/proposal_tokens.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";

/** Ask for `owner/name`, then show its proposal tokens. */
export function proposalTokensPrompt(f: Session, ctx: Ctx, parent: Screen): Screen {
  return promptScreen(ctx, parent, {
    title: "Proposal tokens",
    label: "repository, as owner/name",
    onSubmit: (raw) => {
      const repo = repoByName(f.app, raw.trim());
      const listed = listProposals(f.app, f.user, repo);
      if (!listed.ok || repo === undefined) return listed.ok ? undefined : listed.error.message;
      return later(ctx, () => proposalTokensScreen(f, ctx, repo));
    },
  });
}

/** The secret, once: nothing here is kept after the screen closes. */
function secretScreen(ctx: Ctx, child: string, token: string): Screen {
  return {
    title: `Token for ${child}`,
    keys: [binding(["esc"], "done")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = ["Shown once. Hand it to the child; it cannot be read again.", "", token];
      lines.forEach((l, i) =>
        s.text(area.x, area.y + i, truncate(l, area.w), style(i === 2 ? c.fg : c.mutedFg, c.bg), area.x + area.w),
      );
    },
    key(e) {
      if (e.key === "esc" || e.key === "q" || e.key === "enter") {
        ctx.pop();
        return true;
      }
      return true;
    },
  };
}

export function proposalTokensScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let note = "";
  const list = () => listProposals(f.app, f.user, repo);
  const items = () => {
    const r = list();
    return r.ok ? r.value : [];
  };

  const rows = (): ListRow[] =>
    items().map((t) => ({
      title: t.child,
      secondary: t.origin,
      meta: `expires ${t.expiresAt?.slice(0, 10) ?? "never"}`,
    }));

  const screen: Screen = {
    title: `Proposal tokens: ${repo.ownerName}/${repo.name}`,
    keys: [binding(["j", "k"], "move cursor"), binding(["n"], "mint"), binding(["x"], "revoke")],
    render(area, s) {
      const c = ctx.theme.c;
      const r = list();
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : !r.ok ? r.error.message : r.value.length === 0 ? "None yet. n mints one." : "Tokens you minted for children of this repository.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      if (state.key(e, items().length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "x") {
        const t = items()[state.index];
        if (t === undefined) return false;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Revoke the token for ${t.child}?`,
            body: [`${t.child} can no longer propose here until it is handed a new token.`],
            actions: [{ label: "Revoke", variant: "danger" }, { label: "Keep", variant: "ghost" }],
            selected: 1,
            yesNo: true,
            onChoose: (i) => {
              if (i !== 0) return;
              const done = revokeProposal(f.app, f.user, repo, t.id);
              note = done.ok ? `${t.child}: revoked.` : done.error.message;
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      if (e.key === "n") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Mint a proposal token",
            label: "the child's name (lowercase words and hyphens)",
            onSubmit: (child) =>
              later(ctx, () =>
                promptScreen(ctx, screen, {
                  title: "Mint a proposal token",
                  label: "where the child lives (an https address)",
                  onSubmit: (origin) => {
                    const made = mintProposal(f.app, f.user, repo, { child, origin });
                    if (!made.ok) return made.error.message;
                    note = `${child.trim()}: minted.`;
                    return later(ctx, () => secretScreen(ctx, child.trim(), made.value.token));
                  },
                }),
              ),
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}
