/**
 * A pin's cart: the demo it names (`git/builds.ts`) and the one page of its
 * commit captured to play offline (`arcade/carts.ts`). Reading is the
 * repository's readers'; naming a cart and capturing it is a person who
 * writes it. The capture runs in the background; `cartOf` says how it
 * stands.
 */

import type { App } from "../app.ts";
import { captureState, startCapture, type CaptureOptions, type CaptureState } from "../arcade/carts.ts";
import { canRead, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isDemo, readBuildPin, setPinDemo, type Demo } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { AccessError } from "./access.ts";
import { writerOf } from "./builds.ts";

export interface Cart {
  readonly label: string;
  readonly oid: string;
  readonly demo: Demo | undefined;
  readonly capture: CaptureState;
}

export type CartError = AccessError | "mirrored" | "invalid_demo" | "moved" | "git_failed";

/** What a person names: the cart's name and version, the page it opens, and whether it is in the showcase. */
export interface CartInput {
  readonly name: string;
  readonly version: string;
  readonly page: string;
  readonly showcase: boolean;
}

/** The pin `label`'s cart, to whoever reads the repository. */
export async function cartOf(app: App, actor: User | undefined, repo: Repo, label: string): Promise<Result<Cart, "not_found">> {
  if (!canRead(app.db, repo, actor)) return err("not_found");
  const pin = await readBuildPin(repoDir(app.reposRoot, repo.ownerName, repo.name), label);
  if (pin === undefined) return err("not_found");
  const capture = pin.demo === undefined ? ({ state: "none" } as const) : captureState(app, repo, pin.oid, pin.demo.page);
  return ok({ label: pin.label, oid: pin.oid, demo: pin.demo, capture });
}

/**
 * Name the pin `label`'s cart and start capturing its page. A cart opens as
 * a file: its captured page. The pin's cover, if it has one, stays.
 */
export async function setCart(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  input: CartInput,
  options: CaptureOptions = {},
): Promise<Result<Cart, CartError>> {
  const writer = writerOf(app, actor, repo);
  if (!writer.ok) return writer;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const pin = await readBuildPin(dir, label);
  if (pin === undefined) return err("not_found");
  const demo: Demo = {
    name: input.name.trim(),
    version: input.version.trim(),
    launch: "file",
    page: input.page.trim() || "/",
    showcase: input.showcase,
    ...(pin.demo?.cover === undefined ? {} : { cover: pin.demo.cover }),
  };
  if (!isDemo(demo)) return err("invalid_demo");
  const set = await setPinDemo(dir, label, demo);
  if (!set.ok) return err(set.error);
  if (captureState(app, repo, pin.oid, demo.page).state === "none") void startCapture(app, writer.value, repo, pin.oid, demo.page, options);
  return ok({ label, oid: pin.oid, demo, capture: captureState(app, repo, pin.oid, demo.page) });
}
