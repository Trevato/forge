/**
 * The credit a mirror carries: its upstream, its licence and its original
 * authors (#10531). A fork of a mirror carries the same credit through its
 * lineage. Plain data in, plain data out: the page draws it.
 */

import type { Database } from "bun:sqlite";
import { runGit } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import type { TreeEntry } from "../git/read.ts";

import { detachedMirror } from "./origins.ts";
import { canRead, getRepoById, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

export interface Upstream {
  /** `owner/name` on the origin. */
  readonly fullName: string;
  /** The origin's page for it; may be empty. */
  readonly htmlUrl: string;
  /** True when the credit came up a fork chain, not from this repository's own origin. */
  readonly viaFork: boolean;
}

const MAX_HOPS = 8;
const TOP_AUTHORS = 3;

/**
 * The upstream this repository credits: its own origin when it is a mirror
 * (attached or detached), else the nearest mirror up its fork chain that the
 * viewer may read. Undefined for a native repository.
 */
export function upstreamOf(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
): Upstream | undefined {
  let at: Repo | undefined = repo;
  for (let hop = 0; at !== undefined && hop < MAX_HOPS; hop++) {
    if (at.origin !== null) return { fullName: at.origin.fullName, htmlUrl: at.origin.htmlUrl, viaFork: at !== repo };
    const frozen = at.detached ?? detachedMirror(db, at.id);
    if (frozen !== undefined && frozen !== null) return { fullName: frozen.fullName, htmlUrl: frozen.htmlUrl, viaFork: at !== repo };
    if (at.forkParentId === null) return undefined;
    const parent: Repo | undefined = getRepoById(db, at.forkParentId);
    if (parent === undefined || !canRead(db, parent, viewer)) return undefined;
    at = parent;
  }
  return undefined;
}

const LICENCE_FILE = /^(licen[cs]e|copying|unlicense)(\.(md|txt|markdown|rst))?$/i;

/** The licence file at the root of a tree, or undefined. */
export function licenceEntry(entries: readonly TreeEntry[]): TreeEntry | undefined {
  return entries.find((e) => e.type === "blob" && LICENCE_FILE.test(e.name));
}

const KNOWN: readonly (readonly [RegExp, string])[] = [
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, "AGPL"],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, "LGPL"],
  [/GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i, "GPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 2/i, "GPL-2.0"],
  [/Apache License[\s\S]{0,40}Version 2\.0/i, "Apache-2.0"],
  [/Mozilla Public License[\s\S]{0,40}2\.0/i, "MPL-2.0"],
  [/Permission is hereby granted, free of charge/i, "MIT"],
  [/Permission to use, copy, modify, and\/or distribute/i, "ISC"],
  [/Redistribution and use in source and binary forms[\s\S]{0,1200}Neither the name/i, "BSD-3-Clause"],
  [/Redistribution and use in source and binary forms/i, "BSD-2-Clause"],
  [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
];

/** A short name for licence text; the file's own name when it is not one we know. */
export function licenceName(text: string, fileName: string): string {
  const head = text.slice(0, 4000);
  for (const [pattern, name] of KNOWN) if (pattern.test(head)) return name;
  return fileName;
}

const authorCache = new Map<string, readonly string[]>();
const CACHE_MAX = 200;
/** Only this many of the newest commits are counted: the cost is bounded, not the history's size. */
export const AUTHOR_WINDOW = 500;
const AUTHOR_TIMEOUT_MS = 1_500;

/**
 * The names behind the most commits among the newest `AUTHOR_WINDOW`, most
 * first. `rev` is a branch, tag or commit id; it is resolved to its commit,
 * and the answer is kept by directory and commit. A git that is slow to answer
 * costs the page its authors, never its first paint: a miss is not kept.
 */
async function authorsAt(
  dir: string,
  rev: string,
  opts: { limit?: number; timeoutMs?: number; window?: number } = {},
): Promise<readonly string[]> {
  const limit = opts.limit ?? TOP_AUTHORS;
  const timeoutMs = opts.timeoutMs ?? AUTHOR_TIMEOUT_MS;
  const window = opts.window ?? AUTHOR_WINDOW;
  if (!isSafeRef(rev)) return [];
  const id = await runGit(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: dir, timeoutMs });
  if (!id.ok || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id.value)) return [];
  const key = `${dir}:${id.value}:${window}`;
  const kept = authorCache.get(key);
  if (kept !== undefined) return kept.slice(0, limit);
  const out = await runGit(
    ["log", `--max-count=${window}`, "--no-merges", "--format=%aN", id.value, "--"],
    { cwd: dir, timeoutMs },
  );
  if (!out.ok) return [];
  const counts = new Map<string, number>();
  for (const line of out.value.split("\n")) {
    const name = line.trim().slice(0, 80);
    if (name !== "") counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 5);
  if (authorCache.size >= CACHE_MAX) authorCache.clear();
  authorCache.set(key, names);
  return names.slice(0, limit);
}

export async function topAuthors(
  dir: string,
  rev: string,
  opts: { limit?: number; timeoutMs?: number; window?: number } = {},
): Promise<readonly string[]> {
  try {
    return await authorsAt(dir, rev, opts);
  } catch {
    return []; // a directory that is gone, a git that will not start: no authors, same page
  }
}

/** Empties the author cache; for tests. */
export function clearCreditCache(): void {
  authorCache.clear();
}

/** What a credit needs of a repository's source: the root listing and one blob. */
export interface CreditSource {
  tree(ref: string, path: string): Promise<{ ok: true; value: readonly TreeEntry[] } | { ok: false }>;
  blob(
    ref: string,
    path: string,
  ): Promise<{ ok: true; value: { kind: string; size?: number; body?: Uint8Array } } | { ok: false }>;
}

export interface Credit {
  readonly upstream: Upstream;
  readonly licence: string;
  readonly authors: readonly string[];
}

const MAX_LICENCE_BYTES = 64 * 1024;

/** The credit a repository carries at `ref`, or undefined for a native one. Shared by both doors. */
export async function creditOf(
  db: Database,
  reposRoot: string,
  repo: Repo,
  viewer: User | undefined,
  source: CreditSource,
  ref: string,
): Promise<Credit | undefined> {
  const upstream = upstreamOf(db, repo, viewer);
  if (upstream === undefined) return undefined;
  const root = await source.tree(ref, "");
  const file = root.ok ? licenceEntry(root.value) : undefined;
  let licence = "no licence file";
  if (file !== undefined) {
    const blob = await source.blob(ref, file.name);
    licence =
      blob.ok && blob.value.kind === "text" && (blob.value.size ?? 0) <= MAX_LICENCE_BYTES && blob.value.body !== undefined
        ? licenceName(new TextDecoder().decode(blob.value.body), file.name)
        : file.name;
  }
  const authors = await topAuthors(repoDir(reposRoot, repo.ownerName, repo.name), ref);
  return { upstream, licence, authors };
}

/** The words before the upstream's name: a sentence, not a label. */
export function creditLead(c: Credit): string {
  return c.upstream.viaFork ? "Forked from a mirror of" : "Mirrored from";
}

/** The rest of the sentence after the upstream's name: " · MIT · by Zed, Quinn". */
export function creditRest(c: Credit): string {
  return ` · ${c.licence}${c.authors.length > 0 ? ` · by ${c.authors.join(", ")}` : ""}`;
}

/** The whole line as plain text, for the terminal. */
export function creditText(c: Credit): string {
  return `${creditLead(c)} ${c.upstream.fullName}${creditRest(c)}`;
}
