/**
 * A hosted child has no crew runner (#4416): only `main.ts` starts one, for
 * the parent. The crew readiness says so, for the child and only the child.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import type { Ctx } from "../src/http/context.ts";
import { closeHostedChildren, resolveHostedChild } from "../src/spawn/host.ts";
import { crewReadiness } from "../src/web/pages/crew.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let parent: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-hosted-crew-"));
  parent = createApp({ dataDir: dir, url: "https://forge.example" });
  await mkdir(join(dir, "spawn"), { recursive: true });
  await writeFile(
    join(dir, "spawn", "kid.json"),
    JSON.stringify({ name: "kid", bodyId: "b1", done: true, placement: "hosted" }),
  );
});

afterAll(async () => {
  closeHostedChildren(parent);
  parent.close();
  await rm(dir, { recursive: true, force: true });
});

const say = (app: App): string => String(crewReadiness({ app } as unknown as Ctx));

test("a hosted child says its crew cannot run, the parent does not", async () => {
  const child = await resolveHostedChild(
    parent,
    new Request("http://x/", { headers: { host: "kid--forge.example" } }),
  );
  expect(typeof child).toBe("object");
  expect(childDirOf(parent, "b1")).toContain("b1");
  expect(say(child as App)).toContain("hosted inside another forge");
  expect(say(parent)).not.toContain("hosted inside another forge");
  expect(say(parent)).toContain("No crew runner is up");
});
