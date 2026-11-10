/**
 * Becoming someone. A guest is already connected — this screen proves a
 * password and links the key they arrived on to the account, after which the
 * same connection is that user. No reconnect, and no impersonation: the only
 * account a session can take on is one whose password was just verified.
 *
 * On a forge with no users at all, the same screen opens on creating the first
 * account while signup allows — not an admin; the operator makes the admin.
 */

import { activeEdgeToken } from "../../http/edge.ts";
import { INVITE_SPENT_MESSAGE, REQUEST_IN_MESSAGE, SIGNUP_CLOSED_MESSAGE, signUp, signupClosed } from "../../actions/users.ts";
import { SignupSlot, waitText } from "../../actions/signup-window.ts";
import { hasAnyUser } from "../../core/users.ts";
import { getSignup } from "../../settings/signup.ts";
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
  { label: "Email", hint: "Optional." },
  { label: "Password", secret: true, hint: "At least 12 characters." },
];

/** What sign-up says to a short password; the password change form keeps its own wording. */
export const SIGNUP_WEAK_MESSAGE = "the password is too short (sign-up needs 12 characters)";

/** While signup is `invite` the create form also asks for the link's token. */
const INVITE_BLANK_MESSAGE = "Paste the token from your invite link.";
const INVITE: Field = { label: "Invite", secret: true, hint: "The token from your invite link." };

/**
 * Behind an edge the terminal cannot see the login the edge vouches for, so
 * sign-up is on the web page only, where the name is pinned to that login.
 */
const edgeSignupMessage = (f: Session): string =>
  f.app.config.url === undefined
    ? "Sign up on the web page only."
    : `Sign up on the web page only: ${f.app.config.url}/signup`;

export function signInScreen(f: Session, ctx: Ctx, onDone: () => void): Screen {
  // "Is this forge empty?" is a existence question, not a count: `COUNT(*)`
  // walks the whole user table on the one screen every session paints.
  const first = !hasAnyUser(f.db);
  // Closed signup offers no create mode at all, as the page offers no form.
  // With signup = invite the form is offered, and asks for the invite.
  // Both are read where they are used, so the screen follows the live setting.
  const invited = (): boolean => getSignup(f.db) === "invite";
  // Behind an edge no account is made here: it would be one the edge may later
  // sign a platform user of the same name into. Sign-in is unchanged.
  const edge = activeEdgeToken(f.app) !== undefined;
  const closed = (): boolean => edge || (!invited() && signupClosed(f.app));
  const closedText = (): string => (edge ? edgeSignupMessage(f) : SIGNUP_CLOSED_MESSAGE);
  let mode: "signin" | "create" = first && !closed() ? "create" : "signin";
  let values = ["", "", "", ""];
  let focus = 0;
  let error: string | undefined;
  let busy = false;

  const fields = (): Field[] => (mode === "create" ? (invited() ? [...CREATE, INVITE] : CREATE) : SIGN_IN);

  const submit = (): void => {
    if (busy) return;
    if (closed() && mode === "create") {
      error = closedText();
      return;
    }
    const needsInvite = mode === "create" && invited();
    if (needsInvite && (values[3] ?? "").trim() === "") {
      error = INVITE_BLANK_MESSAGE;
      focus = 3;
      return;
    }
    busy = true;
    error = undefined;
    runAsync(ctx, async () => {
      try {
        if (mode === "create") {
          const [username, email, password, token] = values as [
            string,
            string,
            string,
            string,
          ];
          const invite = needsInvite ? token.trim() : "";
          const slot = SignupSlot.take(f.app, f.identity.remoteAddress);
          if (typeof slot === "number") {
            error = waitText(slot);
            return;
          }
          const created = await signUp(
            f.app,
            { username, email, password },
            { slot, address: f.identity.remoteAddress, ...(invite === "" ? {} : { invite }) },
          );
          if (!created.ok) {
            // With signup = invite a refusal means the token did not open the door.
            if (needsInvite && created.error === "signup_closed") error = INVITE_SPENT_MESSAGE;
            else if (created.error === "weak_password") error = SIGNUP_WEAK_MESSAGE;
            else error = errorText(created.error);
            return;
          }
          // A request that waits has no session: the screen says so and stays a sign-in.
          if (created.value.waitingAt !== null) {
            mode = "signin";
            error = REQUEST_IN_MESSAGE;
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
      ...(closed() ? [] : [binding(["ctrl+t"], first ? "sign in instead" : "create account")]),
      binding(["esc"], "back"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(2), fill(1)]);
      segmented(s, head!, c, {
        items: closed() ? ["Sign in"] : ["Sign in", "Create account"],
        active: mode === "create" ? 1 : 0,
      });
      s.text(
        head!.x,
        head!.y + 1,
        truncate(
          closed()
            ? closedText()
            : first
            ? "This forge has no accounts yet. The operator makes the admin."
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
      if (e.ctrl && e.key === "t" && !closed()) {
        mode = mode === "create" ? "signin" : "create";
        values = ["", "", "", ""];
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
