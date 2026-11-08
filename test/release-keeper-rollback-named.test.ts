// The keeper rolls back by setting the known-good image recorded before the cut, by name; there is no undo path (#7557).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { imageAt, kubeDeployer, tagOf } from "../src/keeper/deploy.ts";
import { tick } from "../src/keeper/keeper.ts";
import { listKeeperReleases } from "../src/keeper/record.ts";
import { rollBackToNamed } from "../src/keeper/rollback.ts";
import { standingHolds } from "../src/keeper/hold.ts";
import { fakeDeployer, keeperForge } from "./helpers/keeper.ts";

const creds = { server: "https://kube.test", token: "t", namespace: "forge" };

describe("the named rollback", () => {
  test("a seeded failing verify sets the recorded known-good image, holds with the numbers, and cuts nothing further", async () => {
    const f = await keeperForge();
    await tick(f.ports);
    expect(f.state.set).toEqual(["reg.test/o/forge:0.7.284"]);
    // The new forge answers, then stops answering /healthz.
    f.world.live = "0.7.284";
    f.world.healthz = (n) => (n >= 20 ? { status: 503, ms: 4 } : { status: 200, ms: 4 });
    const line = await tick(f.ports);
    expect(line).toContain("0.7.284 failed its verify");
    // The image set is the one recorded at the cut, by name — not the controller's "previous" (the broken 0.7.277 here).
    expect(f.state.set).toEqual(["reg.test/o/forge:0.7.284", "reg.test/o/forge:0.7.283"]);
    expect(f.state.image).toBe("reg.test/o/forge:0.7.283");
    const [r] = listKeeperReleases(f.app.db);
    expect(r).toMatchObject({ stage: "rolled_back", probes: 23, badInRow: 3, secondsDark: 3 });
    expect(r!.reason).toContain("rolled back to 0.7.283 (reg.test/o/forge:0.7.283)");
    const [hold] = standingHolds(f.app.db);
    expect(hold).toMatchObject({ kind: "failed", version: "0.7.284", probes: 23, badInRow: 3, worstMs: 40 });
    expect(hold!.reason).toContain("3 bad /healthz probes in a row");
    expect(f.events("release.rolled_back")).toEqual([{ version: "0.7.284", to: "0.7.283", image: "reg.test/o/forge:0.7.283", ok: true }]);
    expect(f.events("release.held")).toHaveLength(1);
    // Back on the known-good version, main moves on, time passes: nothing more is cut.
    f.world.live = "0.7.283";
    f.world.newest = { version: "0.7.284", sha: f.world.main };
    f.world.main = "e".repeat(40);
    f.world.now += 24 * 3_600_000;
    expect(await tick(f.ports)).toContain("held: 0.7.284 failed its verify");
    expect(f.world.tags).toHaveLength(1);
    expect(f.state.set).toHaveLength(2);
  });

  test("a release not live three hours after its cut is set back by name, and held", async () => {
    const f = await keeperForge();
    await tick(f.ports);
    f.world.now += 3 * 3_600_000 + 1;
    expect(await tick(f.ports)).toContain("was not live 3 h after its cut");
    expect(f.state.image).toBe("reg.test/o/forge:0.7.283");
    expect(standingHolds(f.app.db)).toHaveLength(1);
  });

  test("a recorded image that is no image reference is refused, and nothing is set", async () => {
    const { deployer, state } = fakeDeployer("reg.test/o/forge:0.7.284");
    const r = await rollBackToNamed(deployer, { version: "0.7.283", image: "--help" });
    expect(r.ok).toBe(false);
    expect(state.set).toEqual([]);
  });

  test("there is no undo path: the deployer reads or sets a named image — and sends one PATCH naming it", async () => {
    const sent: { url: string; method: string; body: string }[] = [];
    const deployer = kubeDeployer({
      credentials: creds,
      deployment: "forge",
      container: "forge",
      fetch: async (url, init) => {
        sent.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
        return Response.json({ spec: { replicas: 1, template: { spec: { containers: [{ name: "forge", image: "reg.test/o/forge:0.7.284" }] } } } });
      },
    });
    expect(Object.keys(deployer).sort()).toEqual(["image", "setImage"]);
    const r = await rollBackToNamed(deployer, { version: "0.7.283", image: "reg.test/o/forge:0.7.283" });
    expect(r.ok).toBe(true);
    expect(sent).toEqual([
      {
        url: "https://kube.test/apis/apps/v1/namespaces/forge/deployments/forge",
        method: "PATCH",
        body: JSON.stringify({ spec: { template: { spec: { containers: [{ name: "forge", image: "reg.test/o/forge:0.7.283" }] } } } }),
      },
    ]);
    // No code under src/keeper asks for a previous revision: no rollout undo, no rollback subresource, no revision number.
    const dir = join(import.meta.dir, "../src/keeper");
    for (const file of readdirSync(dir)) {
      const code = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code.match(/undo|\/rollback(?!\.ts)|revision|previous/i)?.[0], file).toBeUndefined();
    }
  });

  test("an image keeps its registry port when its tag changes", () => {
    expect(imageAt("reg.test:5000/o/forge:0.7.283", "0.7.284")).toBe("reg.test:5000/o/forge:0.7.284");
    expect(imageAt("reg.test:5000/o/forge", "0.7.284")).toBe("reg.test:5000/o/forge:0.7.284");
    expect(imageAt(`reg.test/o/forge:0.7.283@sha256:${"f".repeat(64)}`, "0.7.284")).toBe("reg.test/o/forge:0.7.284");
    expect(tagOf("reg.test:5000/o/forge:0.7.283")).toBe("0.7.283");
    expect(tagOf("reg.test:5000/o/forge")).toBe("");
  });
});
