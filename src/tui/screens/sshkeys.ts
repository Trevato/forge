/**
 * Your SSH keys in the terminal: the list, `a` to add one (a title, then an
 * authorized_keys line), and for the key under the cursor `e` to rename it
 * and `d` to remove it after a confirm. Every rule is the action's
 * (`actions/users.ts`) and the words are MCP `ssh_keys`'s own (`keyWords`);
 * the list is your own keys, never another account's.
 */

import { addSshKey, deleteSshKey, renameSshKey } from "../../actions/users.ts";
import { listKeys } from "../../core/keys.ts";
import { keyWords } from "../../http/mcp/shared.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";

export function sshKeysScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const items = () => (f.user === undefined ? [] : listKeys(f.app.db, f.user.id));

  const rows = (): ListRow[] =>
    items().map((k) => ({
      title: f.isCurrentKey(k) ? `${k.name} (this session)` : k.name,
      secondary: k.fingerprint,
      meta: `added ${k.createdAt.slice(0, 10)}, used ${k.lastUsedAt?.slice(0, 10) ?? "never"}`,
    }));

  const screen: Screen = {
    title: "SSH keys",
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "add"), binding(["e"], "rename"), binding(["d"], "remove")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== "" ? note : items().length === 0 ? "None yet. a adds one." : "Keys that sign in as you.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      if (state.key(e, items().length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "d") {
        const k = items()[state.index];
        if (k === undefined) return false;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Remove SSH key",
            body: [
              `Remove ${k.name}?`,
              k.fingerprint,
              ...(f.isCurrentKey(k) ? ["", "This terminal session signed in with it."] : []),
            ],
            actions: [{ label: "Cancel", variant: "ghost" }, { label: "Remove", variant: "danger" }],
            onChoose: (i) => {
              if (i !== 1) return;
              const done = deleteSshKey(f.app, f.user, k.id);
              note = done.ok ? `${k.name}: removed.` : keyWords(done.error);
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      if (e.key === "e") {
        const k = items()[state.index];
        if (k === undefined) return false;
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Rename SSH key",
            label: "which machine holds it",
            value: k.name,
            onSubmit: (name) => {
              const done = renameSshKey(f.app, f.user, k.id, name);
              if (!done.ok) {
                ctx.toast(keyWords(done.error), "danger");
                return keyWords(done.error);
              }
              note = `${k.name}: renamed to ${name.trim()}.`;
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "a") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Add an SSH key",
            label: "a title (optional)",
            onSubmit: (title) =>
              later(ctx, () =>
                promptScreen(ctx, screen, {
                  title: "Add an SSH key",
                  label: "the authorized_keys line",
                  onSubmit: (key) => {
                    const added = addSshKey(f.app, f.user, { name: title, key });
                    if (!added.ok) return keyWords(added.error);
                    note = `${added.value.name}: added.`;
                    return undefined;
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
