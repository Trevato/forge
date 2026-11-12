// @tree-scan: lists the repository through a walk it hands a rooted path.
/**
 * The roll recipe's surge check (#1588): can a surge pod schedule beside the
 * running forge, and if not, how much headroom it lacks. Every number below
 * is worked by hand in the comment beside it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYeses, yesLine } from "../scripts/dark-roll.ts";
import { run } from "../scripts/roll-preflight.ts";
import { parseQuantity, podRequest, report, surge } from "../scripts/roll.ts";

const Mi = 2 ** 20;

const container = (cpu: string, memory: string) => ({
  name: "c",
  resources: { requests: { cpu, memory } },
});

function pod(
  ns: string,
  name: string,
  spec: Record<string, unknown>,
  phase = "Running",
  nodeName = "droplet",
) {
  return {
    metadata: { namespace: ns, name },
    spec: { nodeName, ...spec },
    status: { phase },
  };
}

// Requests on node "droplet" (Running and Pending pods only):
//   forge        1     cpu  2048 Mi
//   two-box      1.5   cpu  3072 Mi   (1000m/2Gi + 500m/1Gi)
//   init-heavy   0.5   cpu   512 Mi   (max(init 500m/512Mi, main 100m/256Mi))
//   overhead     0.1   cpu   128 Mi   (no container requests, runtime overhead)
//   ─────────────────────────────────
//   requested    3.1   cpu  5760 Mi
// Not counted: a Succeeded job (4 Gi), a Failed one (4 Gi) and a pod on
// another node (4 Gi).
const PODS = {
  items: [
    pod("forge", "forge-abc", { containers: [container("1", "2Gi")] }),
    pod("db", "two-box", {
      containers: [container("1000m", "2Gi"), container("500m", "1Gi")],
    }),
    pod("ops", "init-heavy", {
      initContainers: [container("500m", "512Mi")],
      containers: [container("100m", "256Mi")],
    }),
    pod("ops", "overhead", {
      containers: [{ name: "c" }],
      overhead: { cpu: "100m", memory: "128Mi" },
    }),
    pod("ops", "done-job", { containers: [container("1", "4Gi")] }, "Succeeded"),
    pod("ops", "failed-job", { containers: [container("1", "4Gi")] }, "Failed"),
    pod("ops", "elsewhere", { containers: [container("1", "4Gi")] }, "Running", "other"),
  ],
};

const node = (cpu: string, memory: string) => ({
  metadata: { name: "droplet" },
  status: { allocatable: { cpu, memory } },
});

const STEADY = 3712 * Mi; // 3.625 GiB, what the forge holds once warm

const judge = (cpu: string, memory: string, steadyMemory = STEADY) =>
  surge({ node: node(cpu, memory), pods: PODS, forgePod: "forge/forge-abc", steadyMemory });

describe("quantities", () => {
  test("parse as kubectl prints them", () => {
    expect(parseQuantity("8130464Ki")).toBe(8130464 * 1024);
    expect(parseQuantity("2Gi")).toBe(2 * 2 ** 30);
    expect(parseQuantity("1G")).toBe(1e9);
    expect(parseQuantity("500m")).toBe(0.5);
    expect(parseQuantity("1.5")).toBe(1.5);
    expect(parseQuantity("12e6")).toBe(12e6);
    expect(parseQuantity("250000n")).toBeCloseTo(0.00025, 12);
  });
  test("refuse what is not a quantity", () => {
    for (const bad of ["", "Gi", "2 Gi", "-1", "1Zi", "1e", "0x10", "1Gi;rm"])
      expect(parseQuantity(bad)).toBeNull();
    expect(parseQuantity(5)).toBeNull();
  });
});

describe("a pod's request, as the scheduler reckons it", () => {
  test("init floor, sidecars summed, overhead added", () => {
    // sidecar 100m/64Mi runs throughout; plain init 2 cpu/1Gi runs after it,
    // so its floor is 2.1 cpu / 1088 Mi; containers + sidecar = 0.6 / 576 Mi.
    // max → 2.1 cpu / 1088 Mi, + overhead 50m/32Mi → 2.15 cpu / 1120 Mi.
    const r = podRequest(
      pod("x", "y", {
        initContainers: [
          { ...container("100m", "64Mi"), restartPolicy: "Always" },
          container("2", "1Gi"),
        ],
        containers: [container("500m", "512Mi")],
        overhead: { cpu: "50m", memory: "32Mi" },
      }),
    );
    expect(r).toEqual({ milliCpu: 2150, memory: 1120 * Mi });
  });
  test("tenths of a core are exact millicores", () => {
    // 0.1 × 1000 in floating point is 100.00000000000001; the scheduler says 100.
    expect(podRequest(pod("x", "y", { containers: [container("0.1", "1")] }))).toEqual({
      milliCpu: 100,
      memory: 1,
    });
  });
});

describe("does a surge pod schedule", () => {
  test("the 8 GB droplet: it does not, and it says by how much", () => {
    // allocatable 3.9 cpu / 7680 Mi − requested 3.1 / 5760 → free 0.8 / 1920 Mi
    // need: cpu 1, memory max(2048, 3712) = 3712 Mi
    // short: 0.2 cpu, 3712 − 1920 = 1792 Mi
    const s = judge("3900m", "7680Mi");
    expect(s.podsOnNode).toBe(4);
    expect(s.requested).toEqual({ milliCpu: 3100, memory: 5760 * Mi });
    expect(s.free).toEqual({ milliCpu: 800, memory: 1920 * Mi });
    expect(s.forgeRequest).toEqual({ milliCpu: 1000, memory: 2048 * Mi });
    expect(s.need).toEqual({ milliCpu: 1000, memory: 3712 * Mi });
    expect(s.schedulable).toBe(false);
    expect(s.fits).toBe(false);
    expect(s.shortfall).toEqual({ milliCpu: 200, memory: 1792 * Mi });
    const text = report(s);
    expect(text).toContain("cannot schedule");
    expect(text).toContain("1792 MiB and 200m cpu more free on droplet");
  });

  test("a 16 GB node: it fits, nothing is short", () => {
    // allocatable 7.9 cpu / 12288 Mi − 3.1 / 5760 → free 4.8 / 6528 Mi ≥ 1 / 3712
    const s = judge("7900m", "12Gi");
    expect(s.free).toEqual({ milliCpu: 4800, memory: 6528 * Mi });
    expect(s.schedulable).toBe(true);
    expect(s.fits).toBe(true);
    expect(s.shortfall).toEqual({ milliCpu: 0, memory: 0 });
    const text = report(s);
    expect(text).toContain("fits — the roll is zero-downtime");
    expect(text).not.toContain("short by");
  });

  test("exactly enough is enough", () => {
    // allocatable 4.1 cpu / 9472 Mi − 3.1 / 5760 → free 1 / 3712 Mi = need
    const s = judge("4100m", "9472Mi");
    expect(s.free).toEqual({ milliCpu: 1000, memory: 3712 * Mi });
    expect(s.fits).toBe(true);
    // one byte less is not
    const t = judge("4100m", String(9472 * Mi - 1));
    expect(t.fits).toBe(false);
    expect(t.shortfall).toEqual({ milliCpu: 0, memory: 1 });
  });

  test("schedules on its request, but steady memory does not fit", () => {
    // allocatable 4.1 cpu / 8000 Mi − 3.1 / 5760 → free 1 / 2240 Mi
    // request 2048 Mi ≤ 2240: the scheduler places it; steady 3712 > 2240
    // short: 0 cpu, 3712 − 2240 = 1472 Mi
    const s = judge("4100m", "8000Mi");
    expect(s.schedulable).toBe(true);
    expect(s.fits).toBe(false);
    expect(s.shortfall).toEqual({ milliCpu: 0, memory: 1472 * Mi });
    expect(report(s)).toContain("would schedule, but both pods' steady memory would not");
  });

  test("steady memory below the request: the request is the need", () => {
    // free 4.8 cpu / 6528 Mi; steady 1024 Mi < request 2048 Mi → need 2048 Mi
    const s = judge("7900m", "12Gi", 1024 * Mi);
    expect(s.need.memory).toBe(2048 * Mi);
    expect(s.fits).toBe(true);
  });

  test("short on cpu alone", () => {
    // allocatable 3.5 cpu / 12288 Mi − 3.1 / 5760 → free 0.4 / 6528 Mi
    const s = judge("3500m", "12Gi");
    expect(s.fits).toBe(false);
    expect(s.shortfall).toEqual({ milliCpu: 600, memory: 0 });
  });
});

describe("input that is not what kubectl prints", () => {
  test("is refused, never guessed", () => {
    const bad: Array<[Parameters<typeof surge>[0], RegExp]> = [
      [{ node: node("4", "8Gi"), pods: PODS, forgePod: "forge-abc", steadyMemory: STEADY }, /namespace\/name/],
      [{ node: node("4", "8Gi"), pods: PODS, forgePod: "forge/-x", steadyMemory: STEADY }, /namespace\/name/],
      [{ node: node("4", "8Gi"), pods: PODS, forgePod: "forge/forge-abc", steadyMemory: 0 }, /steady/],
      [{ node: node("4", "8Gi"), pods: PODS, forgePod: "forge/forge-abc", steadyMemory: NaN }, /steady/],
      [{ node: {}, pods: PODS, forgePod: "forge/forge-abc", steadyMemory: STEADY }, /metadata\.name/],
      [{ node: node("4", "lots"), pods: PODS, forgePod: "forge/forge-abc", steadyMemory: STEADY }, /not a quantity/],
      [{ node: { metadata: { name: "droplet" } }, pods: PODS, forgePod: "forge/forge-abc", steadyMemory: STEADY }, /allocatable/],
      [{ node: node("4", "8Gi"), pods: PODS, forgePod: "forge/missing", steadyMemory: STEADY }, /no forge\/missing/],
      [{ node: node("4", "8Gi"), pods: PODS, forgePod: "ops/elsewhere", steadyMemory: STEADY }, /not on node/],
    ];
    for (const [input, why] of bad) expect(() => surge(input)).toThrow(why);
  });
});

describe("the recipe's command", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files = (cpu: string, memory: string) => {
    writeFileSync(join(dir, "node.json"), JSON.stringify(node(cpu, memory)));
    writeFileSync(join(dir, "pods.json"), JSON.stringify(PODS));
    return ["--node", join(dir, "node.json"), "--pods", join(dir, "pods.json"), "--pod", "forge/forge-abc"];
  };

  test("exit 3 and the headroom when it does not fit", () => {
    const { code, out } = run([...files("3900m", "7680Mi"), "--steady", "3712Mi"]);
    expect(code).toBe(3);
    expect(out).toContain("short by");
    expect(out).toContain("1792 MiB and 200m cpu more free");
  });

  test("exit 0 when it fits", () => {
    const { code, out } = run([...files("7900m", "12Gi"), "--steady", "3712Mi"]);
    expect(code).toBe(0);
    expect(out).toContain("zero-downtime");
  });

  test("--json is the same answer as data", () => {
    const { code, out } = run([...files("3900m", "7680Mi"), "--steady", "3712Mi", "--json"]);
    expect(code).toBe(3);
    const s = JSON.parse(out);
    expect(s.fits).toBe(false);
    expect(s.shortfall).toEqual({ milliCpu: 200, memory: 1792 * Mi });
  });

  test("exit 2 on arguments or files that are not right", () => {
    const args = files("3900m", "7680Mi");
    writeFileSync(join(dir, "text.json"), "NAME STATUS\n");
    for (const argv of [
      args, // no --steady
      [...args, "--steady", "lots"],
      [...args, "--steady", "1Gi", "--steady", "2Gi"],
      [...args, "--steady", "1Gi", "--force"],
      [...args, "--steady"],
      ["--node", join(dir, "absent.json"), ...args.slice(2), "--steady", "1Gi"],
      ["--node", join(dir, "text.json"), ...args.slice(2), "--steady", "1Gi"],
    ]) {
      const { code, out } = run(argv);
      expect(code).toBe(2);
      expect(out).toStartWith("roll-preflight: ");
    }
  });
});

describe("what this pull leaves alone", () => {
  test("the chart still rolls with a surge pod", () => {
    // The check above only means something while the chart surges.
    const chart = readFileSync(
      join(import.meta.dir, "../charts/app/templates/deployment.yaml"),
      "utf8",
    );
    expect(chart).toMatch(/maxSurge: 1\n\s+maxUnavailable: 0/);
  });
  test("the roll recipe names the command and the rule", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/ops/ROLL.md"), "utf8");
    expect(doc).toContain("bun scripts/roll-preflight.ts");
    expect(doc).toContain("short by");
  });
});

describe("a dark roll waits for the owner's yes (#1589)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dark-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const base = (cpu: string, memory: string) => {
    writeFileSync(join(dir, "node.json"), JSON.stringify(node(cpu, memory)));
    writeFileSync(join(dir, "pods.json"), JSON.stringify(PODS));
    return ["--node", join(dir, "node.json"), "--pods", join(dir, "pods.json"), "--pod", "forge/forge-abc", "--steady", "3712Mi"];
  };
  const log = (text: string) => {
    writeFileSync(join(dir, "yes.log"), text);
    return ["--yes-file", join(dir, "yes.log")];
  };
  const tight = () => base("3900m", "7680Mi");

  test("no headroom and no yes: no roll, and it says the seconds and the headroom", () => {
    const { code, out } = run([...tight(), "--version", "0.7.104", ...log(""), "--dark-seconds", "90"]);
    expect(code).toBe(3);
    expect(out).toContain("NOT rolling 0.7.104");
    expect(out).toContain("dark for about 90s");
    expect(out).toContain("1792 MiB and 200m cpu");
  });

  test("a yes for another version does not count", () => {
    for (const text of [
      "0.7.103 yes alice 2026-10-15\n",
      "0.7.1040 yes alice 2026-10-15\n",
      "* yes alice 2026-10-15\n",
      "# 0.7.104 yes alice 2026-10-15\n",
      "0.7.104 no alice 2026-10-15\n",
      "0.7.104 yes alice\n",
    ]) {
      expect(run([...tight(), "--version", "0.7.104", ...log(text)]).code).toBe(3);
    }
  });

  test("no version at all: no roll", () => {
    expect(run([...tight(), ...log("0.7.104 yes alice 2026-10-15\n")]).code).toBe(3);
  });

  test("a yes for exactly this version lets the dark roll go, and says whose", () => {
    const { code, out } = run([...tight(), "--version", "0.7.104", ...log("0.7.103 yes bob 2026-10-01\n0.7.104 yes alice 2026-10-15\n")]);
    expect(code).toBe(0);
    expect(out).toContain("dark roll of 0.7.104 allowed: alice said yes on 2026-10-15");
  });

  test("with headroom a yes is not needed", () => {
    expect(run([...base("7900m", "12Gi"), "--version", "0.7.104"]).code).toBe(0);
  });

  test("bad version or seconds is refused", () => {
    expect(run([...tight(), "--version", "latest"]).code).toBe(2);
    expect(run([...tight(), "--dark-seconds", "-1"]).code).toBe(2);
  });

  test("the yes log holds no yes it was not given", () => {
    const text = readFileSync(join(import.meta.dir, "../docs/ops/dark-rolls.log"), "utf8");
    expect(parseYeses(text)).toEqual([]);
  });

  test("no yes line is a standing one", () => {
    expect(parseYeses("latest yes a 2026-01-01\nall yes a 2026-01-01\n1.2 yes a 2026-01-01\n")).toEqual([]);
    expect(() => yesLine("*", "alice", "2026-10-15")).toThrow();
    expect(parseYeses(yesLine("0.7.104", "alice", "2026-10-15"))).toHaveLength(1);
  });

  test("the gitops overlay and the chart never carry maxSurge: 0", () => {
    const root = join(import.meta.dir, "..");
    const seen: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && e.name !== ".git") walk(p);
        } else if (/\.(ya?ml|tpl|json)$/.test(e.name)) seen.push(p);
      }
    };
    for (const d of ["charts", "infra", "gitops", "deploy"]) {
      try {
        walk(join(root, d));
      } catch {}
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) {
      expect(readFileSync(f, "utf8")).not.toMatch(/maxSurge["']?\s*:\s*["']?(0|0%)["']?\s*($|[,\n}])/m);
    }
  });

  test("the recipe makes the yes a per-version, recorded step", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/ops/ROLL.md"), "utf8");
    expect(doc).toContain("dark-rolls.log");
    expect(doc).toContain("yes to **that version**");
    expect(doc).toContain("no standing");
  });
});
