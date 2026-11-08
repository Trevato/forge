/**
 * Sealed secrets in the terminal, a forge admin's: the names at a scope with
 * when each was set and last opened, as `/settings/secrets` lists them. `s`
 * looks at another place, `a` sets one (place, name, then the value typed
 * masked), `d` removes the one under the cursor after a confirm. Every rule is
 * the action's (`actions/secrets.ts`); a value is typed once, handed to it and
 * never held, drawn or logged here. Anyone else has no command and, driving
 * the screen directly, sees and changes nothing.
 */

import { listSecrets, putSecret, removeSecret } from "../../actions/secrets.ts";
import { isSecretName, type SecretName } from "../../core/secret_store.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { confirmScreen, drawList, later, ListState, promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** The action's refusals in this screen's words. */
const ERRORS: Record<string, string> = {
  invalid_name: "A name is capital letters, digits and underscores, starting with a letter — like CLOUDFLARE_API_TOKEN.",
  invalid_value: "A value is never empty and stays under 64 KiB.",
  invalid_scope: "Place is forge, org NAME or repo OWNER/NAME.",
  not_found: "No such organization or repository.",
  no_such_secret: "No secret by that name there.",
};

const say = (code: string): string => ERRORS[code] ?? "That could not be done.";

interface Place {
  readonly scope: string;
  readonly ref: string;
}

/** `forge`, `org acme` or `repo alice/site` → a place; a string is the refusal. */
export function parsePlace(line: string): Place | string {
  const [scope = "", ref = "", ...rest] = line.trim().split(/\s+/);
  if (rest.length > 0 || (scope === "forge" && ref !== "")) return ERRORS.invalid_scope!;
  if (scope === "forge") return { scope, ref: "" };
  if ((scope === "org" || scope === "repo") && ref !== "") return { scope, ref };
  return ERRORS.invalid_scope!;
}

const showPlace = (p: Place): string => (p.scope === "forge" ? "forge" : `${p.scope} ${p.ref}`);

export function secretsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = f.user?.isAdmin === true;
  let place: Place = { scope: "forge", ref: "" };
  let note = "";

  const names = (): readonly SecretName[] => {
    const listed = allowed ? listSecrets(f.app, f.user, place.scope, place.ref) : undefined;
    return listed?.ok ? listed.value : [];
  };

  const screen: Screen = {
    title: "Secrets",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["a"], "set a secret"),
      binding(["d"], "remove"),
      binding(["s"], "other place"),
      binding(["esc"], "back"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const rows = names();
      const text = !allowed
        ? "Secrets are kept by a forge admin."
        : note !== ""
          ? note
          : rows.length === 0
            ? `No secret at ${showPlace(place)}. a sets one.`
            : `Sealed secrets at ${showPlace(place)}; values are never shown.`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(
        s,
        list!,
        c,
        state,
        rows.map((n) => ({
          title: n.name,
          secondary: n.scope,
          meta: `set ${n.updatedAt}  ${n.lastReadAt === null ? "never read" : `read ${n.lastReadAt}`}`,
        })),
      );
    },
    key(e) {
      if (state.key(e, names().length)) return true;
      if (e.ctrl || e.alt || !allowed) return false;
      if (e.key === "s")
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Secrets: other place",
            label: "forge, org NAME or repo OWNER/NAME",
            value: showPlace(place),
            onSubmit: (raw) => {
              const next = parsePlace(raw);
              if (typeof next === "string") return next;
              const listed = listSecrets(f.app, f.user, next.scope, next.ref);
              if (!listed.ok) return say(listed.error);
              place = next;
              note = "";
              state.index = 0;
              ctx.invalidate();
              return undefined;
            },
          }),
        );
      else if (e.key === "a")
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Set a secret",
            label: `place: forge, org NAME or repo OWNER/NAME (empty is ${showPlace(place)})`,
            onSubmit: (raw) => {
              const target = raw.trim() === "" ? place : parsePlace(raw);
              if (typeof target === "string") return target;
              return later(ctx, () =>
                promptScreen(ctx, screen, {
                  title: "Set a secret",
                  label: "name, like CLOUDFLARE_API_TOKEN",
                  onSubmit: (name) =>
                    !isSecretName(name.trim()) ? say("invalid_name") : later(ctx, () =>
                      promptScreen(ctx, screen, {
                        title: `Set ${name.trim()}`,
                        label: "value (never shown again)",
                        mask: true,
                        onSubmit: (value) => {
                          const set = putSecret(f.app, f.user, target.scope, target.ref, name.trim(), value);
                          if (!set.ok) return say(set.error);
                          place = target;
                          note = `${name.trim()} is sealed at ${showPlace(target)}.`;
                          ctx.invalidate();
                          return undefined;
                        },
                      }),
                    ),
                }),
              );
            },
          }),
        );
      else if (e.key === "d") {
        const row = names()[state.index];
        if (row === undefined) return true;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Remove ${row.name}?`,
            body: [`It is taken from ${showPlace(place)} and cannot be read back.`],
            actions: [
              { label: "Remove", variant: "danger" },
              { label: "Cancel", variant: "ghost" },
            ],
            selected: 1,
            onChoose: (choice) => {
              if (choice !== 0) return;
              const gone = removeSecret(f.app, f.user, place.scope, place.ref, row.name);
              note = gone.ok ? `${row.name} is removed.` : say(gone.error);
              ctx.invalidate();
            },
          }),
        );
      } else return false;
      return true;
    },
  };
  return screen;
}

/** Settings → Secrets, as the page has it: a forge admin; names only, never a value. */
export const entry: PaletteEntry = {
  id: "secrets",
  title: "Secrets",
  hint: "sealed secrets by name; set or remove one",
  after: ["flags", "access", "file-holds"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(secretsScreen(session, ctx)),
};
