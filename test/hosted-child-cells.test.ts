/**
 * A hosted child runs in its parent's process, and its admin is its owner,
 * not this machine's: the cells its code runs in hide the parent's data as
 * well as its own, and take no egress grant, which would open this
 * machine's private network to whoever claimed the child.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { cellHides, grantsHere, markHostedChild } from "../src/spawn/hosted-mark.ts";

const tmp = mkdtempSync(join(tmpdir(), "hosted-cells-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("a hosted child's cells", () => {
  const parent = createApp({ dataDir: join(tmp, "parent") });
  const child = createApp({ dataDir: join(tmp, "parent", "children", "hosted-1") });
  markHostedChild(child, parent.config.dataDir);
  afterAll(() => {
    child.close();
    parent.close();
  });

  test("hide the parent's data as well as the child's own", () => {
    expect(cellHides(child)).toContain(parent.config.dataDir);
    expect(cellHides(child)).toContain(child.config.dataDir);
    expect(cellHides(parent)).not.toContain(child.config.dataDir);
    expect(cellHides(parent)).toContain(parent.config.dataDir);
  });

  test("take no egress grant, whatever the child's own admin stored", () => {
    expect(grantsHere(child, () => ["192.168.1.10:8080"])).toEqual([]);
    expect(grantsHere(parent, () => ["192.168.1.10:8080"])).toEqual(["192.168.1.10:8080"]);
  });
});
