/**
 * Becoming someone. A guest is already connected — this screen proves a
 * password and links the key they arrived on to the account, after which the
 * same connection is that user. No reconnect, and no impersonation: the only
 * account a session can take on is one whose password was just verified.
 *
 * On a forge with no users at all, the same screen creates the first account,
 * which is the admin — the terminal equivalent of the web's first-run signup.
 */

import { signUp } from "../../actions/users.ts";
import { hasAnyUser } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { field, segmented } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { errorText, runAsync } from "./common.ts";

interface Field {
  readonly label: string;
  readonly secret?: boolean;
  readonly hint?: string;
}

const SIGN_IN: Field[] = [
  { label: "Username" },
  { label: "Password", secret: true, hint: "Your key is linked on success." },
];

const CREATE: Field[] = [
  { label: "Username" },
  { label: "Email" },
  { label: "Password", secret: true, hint: "At least 10 characters." },
];

export function signInScreen(f: Session, ctx: Ctx, onDone: () => void): Screen {
  // "Is this forge empty?" is a existence question, not a count: `COUNT(*)`
  // walks the whole user table on the one screen every session paints.
  const first = !hasAnyUser(f.db);
  let mode: "signin" | "create" = first ? "create" : "signin";
  let values = ["", "", ""];
  let focus = 0;
  let error: string | undefined;
  let busy = false;

  const fields = (): Field[] => (mode === "create" ? CREATE : SIGN_IN);

  const submit = (): void => {
    if (busy) return;
    busy = true;
    error = undefined;
    runAsync(ctx, async () => {
      try {
        if (mode === "create") {
          const [username, email, password] = values as [
            string,
            string,
            string,
          ];
          const created = await signUp(f.app, { username, email, password });
          if (!created.ok) {
            error = errorText(created.error);
            return;
          }
          const adopted = f.adopt(created.value);
          if (!adopted.ok) {
            error = errorText(adopted.error);
            return;
          }
        } else {
          const [username, password] = values as [string, string, string];
          const signedIn = await f.signIn(username, password);
          if (!signedIn.ok) {
            error = errorText(signedIn.error);
            return;
          }
        }
        ctx.toast(`signed in as ${f.user?.username ?? ""}`, "success");
        onDone();
        ctx.pop();
      } finally {
        busy = false;
        ctx.invalidate();
      }
    });
  };

  return {
    title: mode === "create" ? "Create account" : "Sign in",
    keys: [
      binding(["tab"], "next field"),
      binding(["enter"], mode === "create" ? "create" : "sign in"),
      binding(["ctrl+t"], first ? "sign in instead" : "create account"),
      binding(["esc"], "back"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(2), fill(1)]);
      segmented(s, head!, c, {
        items: ["Sign in", "Create account"],
        active: mode === "create" ? 1 : 0,
      });
      s.text(
        head!.x,
        head!.y + 1,
        truncate(
          first
            ? "This forge has no accounts yet — the first one is the admin."
            : `Connected from ${f.identity.remoteAddress} with ${f.identity.fingerprint ?? "no key"}`,
          head!.w,
        ),
        style(c.faint, c.bg),
        head!.x + head!.w,
      );
      let cursor: { x: number; y: number } | null = null;
      fields().forEach((spec, i) => {
        const y = body!.y + i * 4;
        if (y + 2 >= body!.y + body!.h) return;
        const shownValue =
          spec.secret === true
            ? "•".repeat([...(values[i] ?? "")].length)
            : (values[i] ?? "");
        const at = field(
          s,
          { x: body!.x, y, w: Math.min(60, body!.w), h: 3 },
          c,
          {
            label: spec.label,
            value: shownValue,
            focused: focus === i,
            ...(focus === i ? { cursor: [...shownValue].length } : {}),
            ...(error !== undefined && focus === i
              ? { error }
              : spec.hint === undefined
                ? {}
                : { hint: spec.hint }),
          },
        );
        if (focus === i) cursor = at;
      });
      ctx.setCursor(cursor);
    },
    key(e) {
      if (e.ctrl && e.key === "t") {
        mode = mode === "create" ? "signin" : "create";
        values = ["", "", ""];
        focus = 0;
        error = undefined;
        return true;
      }
      if (
        e.key === "tab" ||
        (e.key === "enter" && focus < fields().length - 1)
      ) {
        focus = (focus + 1) % fields().length;
        return true;
      }
      if (e.key === "enter") {
        submit();
        return true;
      }
      if (e.key === "backspace") {
        values[focus] = [...(values[focus] ?? "")].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        values[focus] = (values[focus] ?? "") + e.key;
        error = undefined;
        return true;
      }
      return false;
    },
  };
}
