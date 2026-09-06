/**
 * The account: profile, password, tokens and SSH keys.
 *
 * A token secret and a webhook secret follow the same rule — shown once, in a
 * dialog, because that is the only moment either exists in the clear. The key
 * list marks the one this session is holding, so nobody deletes the key they
 * are sitting on without being told.
 */

import {
  addSshKey,
  changePassword,
  createToken,
  deleteSshKey,
  deleteToken,
  updateProfile,
} from "../../actions/users.ts";
import { listKeys, type UserKey } from "../../core/keys.ts";
import {
  listTokens,
  type TokenInfo,
  type TokenScope,
} from "../../core/tokens.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import { fill, len, split } from "../ui/layout.ts";
import { tabs } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  confirmScreen,
  drawFacts,
  drawList,
  hitList,
  errorText,
  promptScreen,
  ago,
  runAsync,
} from "./common.ts";
import { crewScreen } from "./crew.ts";
import { originsScreen } from "./origins.ts";

const TABS = ["Profile", "Tokens", "SSH keys"] as const;

export function accountScreen(f: Session, ctx: Ctx): Screen {
  let tokens: TokenInfo[] = [];
  let keys: UserKey[] = [];
  let tab = 0;
  const state = new ListState();

  const reload = (): void => {
    if (!f.user) return;
    tokens = listTokens(f.db, f.user.id);
    keys = listKeys(f.db, f.user.id);
    ctx.invalidate();
  };

  const screen: Screen = {
    title: "Account",
    get keys() {
      // The crew is a forge admin's to manage, so the key is only there for
      // one — a non-admin would land on a screen that says no to everything.
      const crew = f.user?.isAdmin === true ? [binding(["c"], "crew")] : [];
      if (tab === 0)
        return [
          binding(["tab"], "next tab"),
          binding(["d"], "display name"),
          binding(["e"], "email"),
          binding(["p"], "password"),
          binding(["o"], "origins"),
          ...crew,
        ];
      if (tab === 1)
        return [
          binding(["tab"], "next tab"),
          binding(["n"], "new token"),
          binding(["D"], "revoke"),
          binding(["o"], "origins"),
          ...crew,
        ];
      return [
        binding(["tab"], "next tab"),
        binding(["n"], "add key"),
        binding(["D"], "delete key"),
        binding(["o"], "origins"),
        ...crew,
      ];
    },
    load() {
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [tabRow, body] = split(area, "v", [len(2), fill(1)]);
      tabs(s, tabRow!, c, {
        items: TABS.map((label) => ({ label })),
        active: tab,
      });
      if (!f.user) return;
      if (tab === 0) {
        drawFacts(s, body!, c, [
          ["username", f.user.username],
          ["display name", f.user.displayName || "(none)"],
          ["email", f.user.email],
          ["role", f.user.isAdmin ? "site admin — c manages the crew" : "user"],
          ["joined", ago(f.user.createdAt)],
        ]);
        return;
      }
      if (tab === 1) {
        drawList(
          s,
          body!,
          c,
          state,
          tokens.map((token) => ({
            title: token.name,
            secondary: token.scope,
            meta:
              token.lastUsedAt === null
                ? "never used"
                : `used ${ago(token.lastUsedAt)}`,
          })),
        );
        // Nothing here opens: a token and a key are rows you act on with a
        // letter, so the pointer's job is to say *which* row that is.
        hitList(ctx, body!, state, tokens.length, {});
        return;
      }
      drawList(
        s,
        body!,
        c,
        state,
        keys.map((key) => ({
          title: key.name,
          secondary: key.fingerprint,
          meta: f.isCurrentKey(key) ? "this session" : key.algo,
        })),
      );
      hitList(ctx, body!, state, keys.length, {});
    },
    key(e) {
      if (e.key === "tab") {
        tab = (tab + 1) % TABS.length;
        state.index = 0;
        return true;
      }
      // Origins are an account-level thing, like tokens and keys, so they
      // hang off this screen from every tab rather than becoming a fourth.
      if (e.key === "o") {
        ctx.push(originsScreen(f, ctx));
        return true;
      }
      if (e.key === "c" && f.user?.isAdmin === true) {
        ctx.push(crewScreen(f, ctx));
        return true;
      }
      if (tab === 0) return profileKey(e);
      if (tab === 1) return tokenKey(e);
      return keyKey(e);
    },
  };

  function profileKey(e: KeyEvent): boolean {
    if (e.key === "d" || e.key === "e") {
      const isName = e.key === "d";
      ctx.push(
        promptScreen(ctx, screen, {
          title: isName ? "Display name" : "Email",
          label: isName ? "Display name" : "Email",
          value: isName ? (f.user?.displayName ?? "") : (f.user?.email ?? ""),
          onSubmit: (value) => {
            const updated = updateProfile(
              f.app,
              f.user,
              isName ? { displayName: value } : { email: value },
            );
            if (!updated.ok) return errorText(updated.error);
            f.refresh();
            ctx.toast("profile updated", "success");
            return undefined;
          },
        }),
      );
      return true;
    }
    if (e.key === "p") {
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Change password",
          label: "current new",
          hint: "Your current password, a space, then the new one.",
          onSubmit: (value) => {
            const [current, next] = value.split(/\s+/);
            if (!current || !next) return "both passwords are required";
            return (async () => {
              const changed = await changePassword(f.app, f.user, {
                current,
                next,
              });
              ctx.toast(
                changed.ok ? "password changed" : errorText(changed.error),
                changed.ok ? "success" : "danger",
              );
            })();
          },
        }),
      );
      return true;
    }
    return false;
  }

  function tokenKey(e: KeyEvent): boolean {
    if (state.key(e, tokens.length)) return true;
    if (e.key === "n") {
      ctx.push(
        promptScreen(ctx, screen, {
          title: "New token",
          label: "name [ro|rw|admin]",
          placeholder: "ci rw",
          onSubmit: (value) => {
            const [name, scope] = value.split(/\s+/);
            if (!name) return "a name is required";
            const minted = createToken(
              f.app,
              f.user,
              name,
              (scope === "rw" || scope === "admin"
                ? scope
                : "ro") as TokenScope,
            );
            if (!minted.ok) return errorText(minted.error);
            reload();
            ctx.push(
              confirmScreen(ctx, screen, {
                title: "Token",
                body: [
                  "Copy this now — it is never shown again.",
                  "",
                  minted.value.token,
                ],
                actions: [{ label: "Done" }],
                onChoose: () => undefined,
              }),
            );
            return undefined;
          },
        }),
      );
      return true;
    }
    if (e.key === "D") {
      const token = tokens[state.index];
      if (!token) return true;
      const removed = deleteToken(f.app, f.user, token.id);
      if (!removed.ok) ctx.toast(errorText(removed.error), "danger");
      else {
        reload();
        ctx.toast(`revoked ${token.name}`, "success");
      }
      return true;
    }
    return false;
  }

  function keyKey(e: KeyEvent): boolean {
    if (state.key(e, keys.length)) return true;
    if (e.key === "n") {
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Add SSH key",
          label: "an authorized_keys line",
          placeholder: "ssh-ed25519 AAAA… laptop",
          onSubmit: (value) => {
            const added = addSshKey(f.app, f.user, { name: "", key: value });
            if (!added.ok) return errorText(added.error);
            reload();
            ctx.toast(`added ${added.value.fingerprint}`, "success");
            return undefined;
          },
        }),
      );
      return true;
    }
    if (e.key === "D") {
      const key = keys[state.index];
      if (!key) return true;
      ctx.push(
        confirmScreen(ctx, screen, {
          title: "Delete key",
          body: [
            key.name,
            key.fingerprint,
            f.isCurrentKey(key) ? "This is the key this session is using." : "",
          ],
          actions: [
            { label: "Cancel", variant: "ghost" },
            { label: "Delete", variant: "danger" },
          ],
          onChoose: (choice) => {
            if (choice !== 1) return;
            const removed = deleteSshKey(f.app, f.user, key.id);
            if (!removed.ok) ctx.toast(errorText(removed.error), "danger");
            else {
              reload();
              ctx.toast("key deleted", "success");
            }
          },
        }),
      );
      return true;
    }
    if (e.key === "r") {
      runAsync(ctx, async () => reload());
      return true;
    }
    return false;
  }

  return screen;
}
