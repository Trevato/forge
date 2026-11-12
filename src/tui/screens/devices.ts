/**
 * Devices in the terminal, a forge admin's: the LAN printers Settings →
 * Devices lists, each with its model, state and supplies on one line. `d`
 * declares one (a name, then its address, in one line); `x` removes the one
 * under the cursor after a confirm. Both go through `actions/devices.ts`, so
 * the refusals and the `device.*` events are the page's. `a` allows the one
 * under the cursor to an app (its slug, in one line) and `r` revokes one
 * (likewise): who may print there. `l` sets an app's daily print limit (its
 * slug and a number, in one line); each row lists the limits and the last
 * prints, as the page does. Anyone who is not an
 * admin (or is an agent) is offered no entry and changes nothing.
 */

import { DEVICE_ERRORS, declare, devicesWithStatus, grant, mayManageDevices, remove, revoke, setCap, statusLine } from "../../actions/devices.ts";
import { allAppSlugs } from "../../core/device_grants.ts";
import { CAP_MAX, OUTCOME_WORDS, grantLimits, recentJobs } from "../../core/print_log.ts";
import { listDevices, type Device } from "../../core/devices.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { PaletteEntry } from "./entries.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";

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
  const said = (made: { ok: true; value: string } | { ok: false; error: keyof typeof DEVICE_ERRORS }, d: Device, done: string): string | undefined => {
    note = made.ok ? `${made.value} ${done} ${d.name}.` : DEVICE_ERRORS[made.error];
    if (made.ok) reload();
    return made.ok ? undefined : note;
  };
  const allow = (d: Device) => (line: string): string | undefined =>
    said(grant(f.app, f.user, d.id, line.trim()), d, "may print on");
  // Revoking asks first: the slug is typed, then a yes/no names the app and the printer.
  const stopOne = (d: Device) => (line: string): Promise<void> => {
    const slug = line.trim();
    return later(ctx, () =>
      confirmScreen(ctx, screen, {
        title: "Stop an app printing here",
        body: [`${slug} on ${d.name}`, "The app can no longer print there."],
        actions: [{ label: "Revoke", variant: "danger" }, { label: "Keep" }],
        yesNo: true,
        onChoose: (i) => {
          if (i !== 0) return;
          said(revoke(f.app, f.user, d.id, slug), d, "may no longer print on");
        },
      }),
    );
  };
  const askApp = (d: Device, title: string, onSubmit: (line: string) => string | undefined | Promise<void>): Screen =>
    promptScreen(ctx, screen, {
      title,
      label: `App slug for ${d.name}`,
      placeholder: allAppSlugs(f.db).join(" ") || "no apps yet",
      onSubmit,
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

  const setLimit = (d: Device) => (line: string): string | undefined => {
    const [slug = "", raw = "", extra] = line.trim().split(/\s+/);
    const made = setCap(f.app, f.user, d.id, slug, /^\d{1,4}$/.test(raw) && extra === undefined ? Number(raw) : Number.NaN);
    note = made.ok ? `${made.value} may print ${raw} a day on ${d.name}.` : DEVICE_ERRORS[made.error];
    if (made.ok) reload();
    return made.ok ? undefined : note;
  };
  const askLimit = (d: Device): Screen =>
    promptScreen(ctx, screen, {
      title: "Daily print limit",
      label: `App slug, then prints a day (0 to ${CAP_MAX}) on ${d.name}`,
      placeholder: grantLimits(f.db, d.id).map((l) => l.slug).join(" ") || "grant an app first",
      onSubmit: setLimit(d),
    });
  const apps = (d: Device): string => {
    const limits = grantLimits(f.db, d.id);
    return limits.length === 0 ? "" : ` · apps: ${limits.map((l) => `${l.slug} ${l.today}/${l.cap} today`).join(", ")}`;
  };
  const below = (d: Device): string[] => [
    ...(d.probe?.supplies.length ? [d.probe.supplies.map((s) => `${s.name} ${s.percent === null ? "?" : `${s.percent}%`}`).join(" · ")] : []),
    ...recentJobs(f.db, d.id, 5).map(
      (j) => `${j.at.slice(0, 16).replace("T", " ")} ${j.app} · ${j.pages} ${j.pages === 1 ? "page" : "pages"} · ${OUTCOME_WORDS[j.outcome]}`,
    ),
  ];
  const lines = (): ListRow[] =>
    rows.map((d) => ({
      title: d.name,
      meta: `${d.probedAt === null ? d.url : `${statusLine(d.probe)} · ${d.url}`}${apps(d)}`,
      below: below(d),
    }));

  const screen: Screen = {
    title: "Devices",
    keys: [binding(["d"], "declare"), binding(["x"], "remove"), binding(["a"], "allow an app"), binding(["r"], "revoke an app"), binding(["l"], "daily limit"), binding(["j", "k"], "move cursor")],
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
        ctx.push(e.key === "a" ? askApp(d, "Let an app print here", allow(d)) : askApp(d, "Stop an app printing here", stopOne(d)));
        return true;
      }
      if (e.key === "l" && d !== undefined) {
        note = "";
        ctx.push(askLimit(d));
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
