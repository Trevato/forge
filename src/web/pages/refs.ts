/**
 * Addressing a ref. Three small things that every code-browsing page needs
 * and none of them should own: the branch and tag list, the switcher menu
 * built from it, and the clickable path breadcrumbs.
 *
 * One rule runs through all of it: a ref reaching git has passed `isSafeRef`,
 * and a ref leaving here inside a URL is percent-encoded — so a branch called
 * `feature/a` stays one path segment and can never smuggle a path of its own.
 */

import { listRefs } from "../../git/read.ts";
import type { RepoSource } from "../../view/source.ts";
import { html, raw, type Html } from "../html.ts";
import { crumbs, icon, menu } from "../ui.ts";

// ---- refs ----

export interface RefSet {
  branches: string[];
  tags: string[];
}

/** Branch and tag names, short form, sorted — the ref switcher's whole menu. */
export async function refSet(dir: string): Promise<RefSet> {
  const [heads, tags] = await Promise.all([
    listRefs(dir, "refs/heads/"),
    listRefs(dir, "refs/tags/"),
  ]);
  const strip = (prefix: string, ok: boolean, refs: { name: string }[]) =>
    ok ? refs.map((r) => r.name.slice(prefix.length)).sort() : [];
  return {
    branches: strip("refs/heads/", heads.ok, heads.ok ? heads.value : []),
    tags: strip("refs/tags/", tags.ok, tags.ok ? tags.value : []),
  };
}

/**
 * The same set, from whichever source is answering. A live browse pays two
 * (cached) API calls for it; a local repo two `for-each-ref` reads. Either
 * way the switcher below cannot tell which it got.
 */
export async function refSetFrom(source: RepoSource): Promise<RefSet> {
  const [heads, tags] = await Promise.all([source.branches(), source.tags()]);
  return {
    branches: heads.ok ? heads.value.map((b) => b.name).sort() : [],
    tags: tags.ok ? tags.value.map((t) => t.name).sort() : [],
  };
}

/**
 * The ref switcher. Every entry is a real link to the same page at another
 * ref, so it works with the keyboard, with JavaScript off, and in a new tab.
 */
export interface RefMenuOptions {
  /** The repository's URL base, which turns on the branch-management feet. */
  base?: string;
  /** Offer "create a branch from here" — a writer's verb, not a reader's. */
  canWrite?: boolean;
}

export function refMenu(
  refs: RefSet,
  current: string,
  hrefFor: (ref: string) => string,
  o: RefMenuOptions = {},
): Html {
  const entry = (name: string) => ({
    label: name,
    href: hrefFor(name),
    current: name === current,
  });
  const items = [
    ...(refs.branches.length > 0
      ? [
          raw('<span class="menu-title">Branches</span>'),
          ...refs.branches.map(entry),
        ]
      : []),
    ...(refs.tags.length > 0
      ? [
          raw('<hr class="menu-sep" />'),
          raw('<span class="menu-title">Tags</span>'),
          ...refs.tags.map(entry),
        ]
      : []),
    // The feet: where the whole list lives, and the one verb that makes a
    // new entry in it. Both are real links, so the menu stays a menu of
    // links whether or not a script is running.
    ...(o.base === undefined
      ? []
      : [
          raw('<hr class="menu-sep" />'),
          {
            label: "View all branches",
            href: `${o.base}/branches`,
            icon: "branch" as const,
          },
          ...(o.canWrite === true
            ? [
                {
                  label: `Create branch from ${current}…`,
                  href: `${o.base}/branches?from=${encodeURIComponent(current)}`,
                  icon: "plus" as const,
                },
              ]
            : []),
        ]),
  ];
  return menu({
    trigger: html`${icon("branch")}<span class="truncate">${current}</span>`,
    items,
    align: "start",
    label: "Switch branch or tag",
    triggerOptions: { size: "sm" },
  });
}

/** Clickable path breadcrumbs — every segment above you is one click away. */
export function pathCrumbs(
  base: string,
  name: string,
  ref: string,
  path: string,
  leafIsFile: boolean,
): Html {
  const encoded = encodeURIComponent(ref);
  const parts = path === "" ? [] : path.split("/");
  const items: { label: string; href?: string }[] = [
    { label: name, href: `${base}/tree/${encoded}` },
  ];
  parts.forEach((part, i) => {
    const walked = parts
      .slice(0, i + 1)
      .map(encodeURIComponent)
      .join("/");
    const last = i === parts.length - 1;
    items.push(
      last && leafIsFile
        ? { label: part }
        : { label: part, href: `${base}/tree/${encoded}/${walked}` },
    );
  });
  return crumbs(items, { mono: true, ariaLabel: "File path" });
}
