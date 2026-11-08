/**
 * Pinned forges in the terminal, a forge admin's (#8697): each forge with its
 * version, state and last changes, as the API lists them. `d` deploys, `u`
 * updates (the only way its version or config move), `r` rolls back to the
 * previous version, `c` reads the address back and probes it, each through
 * `actions/pinned.ts`, so the checks, the record of who and when and the events
 * the web screens follow are the API's.
 * Anyone else sees nothing and does nothing.
 */

import { checkPinned, deployPinned, pinnedForges, rollbackPinned, updatePinned } from "../../actions/pinned.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, live, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const short = (v: string): string => (v.length === 40 ? v.slice(0, 10) : v);

export function pinnedScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => pinnedForges(f.app, f.user);
  const forges = () => {
    const r = read();
    return r.ok ? r.value : [];
  };
  const say = (text: string): void => {
    note = text;
    ctx.invalidate();
  };
  const settle = async (r: Promise<{ ok: true; value: { name: string; version: string } } | { ok: false; error: string }>, what: string): Promise<void> => {
    const made = await r;
    say(made.ok ? `${what} ${made.value.name} at ${short(made.value.version)}.` : made.error);
  };

  const deploy = (parent: Screen): Screen =>
    promptScreen(ctx, parent, {
      title: "Deploy a pinned forge",
      label: "name provider/account owner/app https-source version",
      placeholder: "acme digitalocean/main alice/shop https://host/alice/shop v1.0.0",
      onSubmit: (raw) => {
        const [name = "", cloud = "", app = "", source = "", version = "", ...rest] = raw.trim().split(/\s+/);
        const [target = "", account = "", ...more] = cloud.split("/");
        if (rest.length > 0 || more.length > 0 || version === "" || account === "") return "Write: name provider/account owner/app source version.";
        say(`Deploying ${name}…`);
        return settle(deployPinned(f.app, f.user, { name, target, account, app, source, version }), "Deployed");
      },
    });

  const screen: Screen = {
    title: "Pinned forges",
    keys: [binding(["j", "k"], "move cursor"), binding(["d"], "deploy"), binding(["u"], "update"), binding(["r"], "roll back"), binding(["c"], "check")],
    async load(signal) {
      live(f, signal, { kinds: ["pinned.deployed", "pinned.update", "pinned.rollback", "pinned.check"] }, () => ctx.invalidate());
    },
    render(area, s) {
      const c = ctx.theme.c;
      const r = read();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const selected = forges()[state.index];
      const text = note !== "" ? note : !r.ok ? "Pinned forges are a forge admin's." : selected ? `${selected.app} from ${selected.source}` : "No pinned forge. Press d to deploy one.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = forges().map((p) => ({
        title: p.name,
        ...(p.state === "failed" ? { tone: "danger" as const } : {}),
        secondary: `${p.target} · ${short(p.version)} · ${p.state}${p.url !== "" ? ` · ${p.url}` : ""}`,
        meta: p.changes[0] ? `${p.changes[0].kind} ${p.changes[0].at.slice(0, 16).replace("T", " ")}` : "",
      }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      if (state.key(e, forges().length)) return true;
      if (e.ctrl || e.alt || !read().ok) return false;
      if (e.key === "d") {
        ctx.push(deploy(screen));
        return true;
      }
      const p = forges()[state.index];
      if (p === undefined) return false;
      if (e.key === "r") {
        say(`Rolling ${p.name} back…`);
        void settle(rollbackPinned(f.app, f.user, p.name), "Rolled back");
      } else if (e.key === "c") {
        say(`Checking ${p.name}…`);
        void checkPinned(f.app, f.user, p.name).then((r) => say(r.ok ? `${p.name} ${r.value.healthy ? "answers" : "does not answer"}${r.value.url ? ` at ${r.value.url}` : " yet: no address"}.` : r.error));
      } else if (e.key === "u")
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Update ${p.name}`,
            label: "the new version: a 40-character commit id or a tag",
            onSubmit: (version) => {
              say(`Updating ${p.name}…`);
              return settle(updatePinned(f.app, f.user, p.name, { version: version.trim() }), "Updated");
            },
          }),
        );
      else return false;
      return true;
    },
  };
  return screen;
}

/** Pinned forges, as the API and the MCP have them: a forge admin (#8697). */
export const entry: PaletteEntry = {
  id: "pinned",
  title: "Pinned forges",
  hint: "deploy, update and roll back a forge on your cloud",
  after: ["cloud"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(pinnedScreen(session, ctx)),
};
