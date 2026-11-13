/**
 * An owner's ask filters as one action (#11820), for the page, MCP `asks` and
 * the terminal alike, in the same words: hide an app for a day or until shown,
 * hide a kind of decision, show one again, or clear them all. The rows live in
 * `core/ask_filters.ts`; nothing here touches an ask.
 */
import type { Database } from "bun:sqlite";
import { clearAskFilters, hideApp, hideKind, showAgain, type AskKind } from "../core/ask_filters.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";

export const ASK_FILTER_DOS = ["hide_app_day", "hide_app", "show_app", "hide_kind", "show_kind", "clear"] as const;
export type AskFilterDo = (typeof ASK_FILTER_DOS)[number];

export const isAskFilterDo = (v: unknown): v is AskFilterDo =>
  typeof v === "string" && (ASK_FILTER_DOS as readonly string[]).includes(v);

export type AskFilterChange =
  | { readonly do: "hide_app_day" | "hide_app" | "show_app"; readonly repo: Repo }
  | { readonly do: "hide_kind" | "show_kind"; readonly kind: AskKind }
  | { readonly do: "clear" };

/** Make the change for this person and say what it did, one line. */
export function applyAskFilter(db: Database, user: User, change: AskFilterChange, now = Date.now()): string {
  switch (change.do) {
    case "hide_app_day":
      hideApp(db, user.id, change.repo.id, true, now);
      return `Hiding ${change.repo.ownerName}/${change.repo.name} for a day`;
    case "hide_app":
      hideApp(db, user.id, change.repo.id, false, now);
      return `Hiding ${change.repo.ownerName}/${change.repo.name} until you show it`;
    case "show_app":
      showAgain(db, user.id, { kind: "app", value: change.repo.id });
      return `Showing ${change.repo.ownerName}/${change.repo.name} again`;
    case "hide_kind":
      hideKind(db, user.id, change.kind);
      return `Hiding ${change.kind} asks until you show them`;
    case "show_kind":
      showAgain(db, user.id, { kind: "kind", value: change.kind });
      return `Showing ${change.kind} asks again`;
    case "clear":
      clearAskFilters(db, user.id);
      return "Showing everything again";
  }
}
