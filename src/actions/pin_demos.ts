/**
 * A pin's demo: a writer names it, says how it opens, puts it on display
 * pages (the showcase) or takes it off, and gives it a cover. The facts
 * live on the pin's tag (`git/builds.ts`). A demo that opens as a file
 * (`launch` `file`) is the captured HTML page in the data directory
 * (`arcade/carts.ts`); one with no capture yet gets one started, in the
 * background, as the person who asked — the same person a build preview
 * would need.
 *
 * The showcase puts a demo on display pages (`display/items.ts`), for
 * whoever may read its repository. Only a person sets it, never an agent
 * (docs/APPS.md, rule 1).
 */

import type { App } from "../app.ts";
import { captureState, startCapture, type CaptureOptions, type CaptureState } from "../arcade/carts.ts";
import { readFileAt } from "../apps/checkout.ts";
import { parseManifest } from "../apps/manifest.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { exactRefOid } from "../git/branches.ts";
import {
  isDemo,
  launchOf,
  readBuildPin,
  setPinDemo,
  type BuildPin,
  type Demo,
  type Launch,
  type SetDemoError,
} from "../git/builds.ts";
import { isSafeOid } from "../git/guard.ts";
import { readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { requireWriter, type AccessError } from "./access.ts";

export type PinDemoError = AccessError | SetDemoError | "mirrored" | "invalid_cover" | "not_a_file";

export interface DemoInput {
  readonly name: string;
  readonly version: string;
  /** Unset follows the repository's `app.launch`. */
  readonly launch?: Launch | undefined;
  readonly page: string;
  readonly showcase: boolean;
}

/** What a commit's `forge.json` says about its demos. */
export interface DemoFacts {
  /** `app.pages`: the pages it offers to play and download. */
  readonly pages: readonly string[];
  /** `app.launch`, when it names one. */
  readonly launch?: Launch | undefined;
}

/**
 * The pages and the launch a commit's `forge.json` names — or, for a
 * commit pinned before the repository named any pages, what its default
 * branch names now. A page the old build does not serve is simply not
 * found when played.
 */
export async function demoFactsAt(app: App, repo: Repo, oid: string): Promise<DemoFacts> {
  if (!isSafeOid(oid)) return { pages: [] };
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const read = async (at: string): Promise<DemoFacts> => {
    const [forgeJson, packageJson] = await Promise.all([
      readFileAt(dir, at, "forge.json"),
      readFileAt(dir, at, "package.json"),
    ]);
    const manifest = parseManifest(forgeJson, packageJson);
    if (!manifest.ok) return { pages: [] };
    return {
      pages: manifest.value.pages ?? [],
      ...(manifest.value.launch === undefined ? {} : { launch: manifest.value.launch }),
    };
  };
  const own = await read(oid);
  if (own.pages.length > 0) return own;
  // Only a commit this repository holds borrows anything.
  const stat = await readerFor(dir).stat(oid);
  if (!stat.ok || stat.value.type !== "commit") return own;
  const tip = await exactRefOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined || tip === oid) return own;
  const now = await read(tip);
  return { pages: now.pages, ...((own.launch ?? now.launch) === undefined ? {} : { launch: own.launch ?? now.launch }) };
}

/** The facts a pin's demo starts from, before anyone edits them. */
export function demoDefaults(repo: Repo, label: string, pages: readonly string[]): Pick<Demo, "name" | "version" | "page"> {
  return { name: repo.name, version: label, page: pages[0] ?? "/" };
}

/** A person who writes the repository, never an agent, and not on a mirror: who may change a demo. */
export function writerOf(app: App, actor: User | undefined, repo: Repo): Result<User, AccessError | "mirrored"> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (writer.value.kind === "agent") return err("forbidden");
  if (isMirror(app, repo)) return err("mirrored");
  return writer;
}

/**
 * Set the pin's demo facts, keeping its cover. A demo that opens as a file
 * and has no capture of its page gets one started; `capture` asks for one
 * again after a failure.
 */
export async function saveDemo(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  input: DemoInput,
  options: CaptureOptions & { readonly capture?: boolean } = {},
): Promise<Result<BuildPin, PinDemoError>> {
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const pin = await readBuildPin(dir, label);
  if (pin === undefined) return err("not_found");
  const demo: Demo = {
    name: input.name.trim(),
    version: input.version.trim(),
    ...(input.launch === undefined ? {} : { launch: input.launch }),
    page: input.page.trim() || "/",
    showcase: input.showcase,
    ...(pin.demo?.cover === undefined ? {} : { cover: pin.demo.cover }),
  };
  if (!isDemo(demo)) return err("invalid_demo");
  const set = await setPinDemo(dir, label, demo);
  if (!set.ok) return set;
  app.bus.append({
    kind: "build.demo",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { label, oid: pin.oid, demo: demo.name, version: demo.version, launch: demo.launch ?? null, showcase: demo.showcase },
  });
  const facts = await demoFactsAt(app, repo, pin.oid);
  if (launchOf(demo, facts.launch, facts.pages) === "file") {
    const state = captureState(app, repo, pin.oid, demo.page).state;
    if (state === "none" || (options.capture === true && state === "failed"))
      void startCapture(app, writer.value, repo, pin.oid, demo.page, options);
  }
  return ok(set.value);
}

/** Take the pin's demo off display pages; the demo and the pin stay. */
export async function unshowcaseDemo(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
): Promise<Result<BuildPin, PinDemoError>> {
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const pin = await readBuildPin(dir, label);
  if (pin?.demo === undefined) return err("not_found");
  if (!pin.demo.showcase) return ok(pin);
  const set = await setPinDemo(dir, label, { ...pin.demo, showcase: false });
  if (!set.ok) return set;
  app.bus.append({
    kind: "build.demo",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { label, oid: pin.oid, demo: pin.demo.name, version: pin.demo.version, showcase: false },
  });
  return ok(set.value);
}

/**
 * Put the pin in the showcase or take it out: the Iterations page's
 * Showcased chip. In: its demo as it stands, else a demo from the pin's
 * defaults, saved with the showcase switch on (`saveDemo`). Out:
 * `unshowcaseDemo`. The demo itself stays either way.
 */
export async function setShowcase(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  on: boolean,
): Promise<Result<BuildPin, PinDemoError>> {
  if (!on) return unshowcaseDemo(app, actor, repo, label);
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const pin = await readBuildPin(repoDir(app.reposRoot, repo.ownerName, repo.name), label);
  if (pin === undefined) return err("not_found");
  if (pin.demo?.showcase === true) return ok(pin);
  const facts = pin.demo === undefined ? await demoFactsAt(app, repo, pin.oid) : undefined;
  const base = pin.demo ?? { ...demoDefaults(repo, label, facts?.pages ?? []), showcase: false };
  return saveDemo(app, writer.value, repo, label, {
    name: base.name,
    version: base.version,
    ...(pin.demo?.launch === undefined ? {} : { launch: pin.demo.launch }),
    page: base.page,
    showcase: true,
  });
}

/**
 * Clear the pin's demo: its tag is written again without the demo
 * trailers. The pin, its commit and its screenshots stay.
 */
export async function deleteDemo(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
): Promise<Result<BuildPin, PinDemoError>> {
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const pin = await readBuildPin(dir, label);
  if (pin?.demo === undefined) return err("not_found");
  const set = await setPinDemo(dir, label, undefined);
  if (!set.ok) return set;
  app.bus.append({
    kind: "build.demo",
    repoId: repo.id,
    actorId: writer.value.id,
    payload: { label, oid: pin.oid, demo: null, previous: pin.demo.name, version: pin.demo.version },
  });
  return ok(set.value);
}

/**
 * Build a pin's page and keep it: its capture, started in the background
 * as the writer who asked (`startCapture`), when the pin opens as a file
 * and its page is not captured or its capture failed. What the Iterations
 * page's Build and play does; the page then waits on `captureState`.
 */
export async function captureBuild(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  options: CaptureOptions = {},
): Promise<Result<CaptureState["state"], PinDemoError>> {
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const pin = await readBuildPin(dir, label);
  if (pin === undefined) return err("not_found");
  const facts = await demoFactsAt(app, repo, pin.oid);
  if (launchOf(pin.demo, facts.launch, facts.pages) !== "file") return err("not_a_file");
  const page = pin.demo?.page ?? demoDefaults(repo, label, facts.pages).page;
  const state = captureState(app, repo, pin.oid, page).state;
  if (state === "done" || state === "capturing") return ok(state);
  void startCapture(app, writer.value, repo, pin.oid, page, options);
  return ok("capturing");
}
