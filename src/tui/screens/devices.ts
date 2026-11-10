/**
 * Devices in the terminal, a forge admin's: the LAN printers Settings →
 * Devices lists, each with its model, state and supplies on one line. `d`
 * declares one (a name, then its address, in one line); `x` removes the one
 * under the cursor after a confirm. Both go through `actions/devices.ts`, so
 * the refusals and the `device.*` events are the page's. `a` allows the one
 * under the cursor to an app (its slug, in one line) and `r` revokes one
 * (likewise): who may print there. Anyone who is not an
 * admin (or is an agent) is offered no entry and changes nothing.
 */

import { DEVICE_ERRORS, declare, devicesWithStatus, grant, mayManageDevices, remove, revoke, statusLine } from "../../actions/devices.ts";
import { allAppSlugs, grantedSlugs } from "../../core/device_grants.ts";
import { listDevices, type Device } from "../../core/devices.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { PaletteEntry } from "./entries.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, promptScreen, type ListRow } from "./common.ts";

const mayUse = (f: Session): boolean => mayManageDevices(f.user);

export function devicesScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let rows: Device[] = [];
  let note = "";
  const show = (devices: Device[]): void => {
    rows = mayUse(f) ? devices : [];
    state.clamp(rows.length);
    ctx.invalidate();
  };
  // Rows first from what is kept, then the printers are asked (a fresh answer is not asked again).
  const reload = (): void => {
    show(listDevices(f.db));
    if (mayUse(f)) void devicesWithStatus(f.app).then(show, () => {});
  };
  reload();

  const declareOne = (line: string): string | undefined => {
    const at = line.trim().search(/\s+\S+$/);
    const trimmed = line.trim();
    const made =
      at < 0
        ? ({ ok: false, error: "invalid_url" } as const)
        : declare(f.app, f.user, { name: trimmed.slice(0, at), kind: "printer", url: trimmed.slice(at).trim() });
    note = made.ok ? `${made.value.name} is declared.` : DEVICE_ERRORS[made.error];
    if (made.ok) reload();
    return made.ok ? undefined : note;
  };
  const add = (): Screen =>
    promptScreen(ctx, screen, {
      title: "Declare a printer",
      label: "Name, then address",
      placeholder: "Hall printer ipp://192.168.1.161:631/ipp/print",
      onSubmit: declareOne,
    });
  const change = (d: Device, act: typeof grant, done: string) => (line: string): string | undefined => {
    const slug = line.trim();
    const made = act(f.app, f.user, d.id, slug);
    note = made.ok ? `${made.value} ${done} ${d.name}.` : DEVICE_ERRORS[made.error];
    if (made.ok) reload();
    return made.ok ? undefined : note;
  };
  const askApp = (d: Device, act: typeof grant, title: string, done: string): Screen =>
    promptScreen(ctx, screen, {
      title,
      label: `App slug for ${d.name}`,
      placeholder: allAppSlugs(f.db).join(" ") || "no apps yet",
      onSubmit: change(d, act, done),
    });
  const confirmRemove = (d: Device): Screen =>
    confirmScreen(ctx, screen, {
      title: "Remove this device",
      body: [d.name, "The forge stops asking it."],
      actions: [{ label: "Keep", variant: "ghost" }, { label: "Remove", variant: "danger" }],
      onChoose: (i) => {
        if (i !== 1) return;
        const gone = remove(f.app, f.user, d.id);
        note = gone.ok ? `${d.name} is removed.` : DEVICE_ERRORS[gone.error];
        reload();
      },
    });

  const apps = (d: Device): string => {
    const slugs = grantedSlugs(f.db, d.id);
    return slugs.length === 0 ? "" : ` · apps: ${slugs.join(", ")}`;
  };
  const lines = (): ListRow[] =>
    rows.map((d) => ({
      title: d.name,
      meta: `${d.probedAt === null ? d.url : `${statusLine(d.probe)} · ${d.url}`}${apps(d)}`,
      ...(d.probe?.supplies.length
        ? { below: [d.probe.supplies.map((s) => `${s.name} ${s.percent === null ? "?" : `${s.percent}%`}`).join(" · ")] }
        : {}),
    }));

  const screen: Screen = {
    title: "Devices",
    keys: [binding(["d"], "declare"), binding(["x"], "remove"), binding(["a"], "allow an app"), binding(["r"], "revoke an app"), binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const text = note !== "" ? note : mayUse(f) ? `${rows.length} declared.` : DEVICE_ERRORS.forbidden;
      const said = wrap(text, Math.max(1, area.w)).slice(0, 3);
      const [head, list] = split(area, "v", [len(said.length), fill(1)]);
      said.forEach((line, i) => s.text(head!.x, head!.y + i, line, style(c.mutedFg, c.bg), head!.x + head!.w));
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt || !mayUse(f)) return false;
      if (e.key === "d") {
        note = "";
        ctx.push(add());
        return true;
      }
      const d = rows[state.index];
      if ((e.key === "a" || e.key === "r") && d !== undefined) {
        note = "";
        ctx.push(e.key === "a" ? askApp(d, grant, "Let an app print here", "may print on") : askApp(d, revoke, "Stop an app printing here", "may no longer print on"));
        return true;
      }
      if (e.key === "x" && d !== undefined) {
        note = "";
        ctx.push(confirmRemove(d));
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** Offered to a forge admin who is not an agent. */
export const entry: PaletteEntry = {
  id: "devices",
  title: "Devices",
  hint: "LAN printers: model, state, supplies; declare or remove one",
  after: ["app-templates"],
  offered: (session) => mayUse(session),
  run: (session, ctx) => ctx.push(devicesScreen(session, ctx)),
};
