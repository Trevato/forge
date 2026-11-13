/**
 * A hosted forge's cell has no DNS and no route: its one way out is its
 * parent's gate, by name. Here the gate is a stand-in that is asked for a
 * name nothing resolves, so a client that looks the name up itself, or dials
 * an address, cannot get through; only one that goes by name does.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, hostAllowed, isPublicAddress } from "../src/apps/egress.ts";
import { gitEnv, runGit } from "../src/git/env.ts";
import { pinFor, remoteGitEnv } from "../src/git/remote-env.ts";
import { discover } from "../src/origins/discover.ts";
import {
  GateRefusedError,
  outboundFetch,
  RefusedError,
  vetHost,
} from "../src/kernel/outbound.ts";
import {
  fakeGate,
  type FakeGate,
  selfSigned,
  seedRepo,
  serveGit,
} from "./helpers/gate-fixture.ts";

const NAME = "commons--forge.example.test";
const pair = selfSigned(NAME);
const t = pair ? test : test.skip;
const nothing = () => Promise.reject(new Error("a cell resolves nothing"));

let repo = "";
let server: ReturnType<typeof serveGit> | undefined;
const gates: FakeGate[] = [];
beforeAll(() => {
  if (pair === undefined) return;
  repo = seedRepo();
  server = serveGit(repo, pair);
});
afterAll(() => {
  server?.stop(true);
  gates.forEach((g) => g.stop());
});
const gate = (rule: Parameters<typeof fakeGate>[0]): FakeGate => {
  const g = fakeGate(rule);
  gates.push(g);
  return g;
};
/** A gate that carries the one name to the local server and refuses the rest, as the real one does. */
const allowing = () =>
  gate((host, port) =>
    host === NAME && port === server!.port
      ? { tunnelTo: server!.port }
      : host === "nowhere.example.test"
        ? { status: 403, why: "nowhere.example.test does not resolve" }
        : {
            status: 403,
            why: `${host}:${port} is not in this repository's egress (forge.json "egress")`,
          },
  );

describe("vetHost in a cell", () => {
  test("goes by name through the gate and resolves nothing itself", async () => {
    const vetted = await vetHost(NAME, {
      resolve: nothing,
      proxy: "http://127.0.0.1:3128",
    });
    expect(vetted).toEqual({
      ok: true,
      value: { via: "gate", proxy: "http://127.0.0.1:3128" },
    });
  });

  test("an address literal stays refused, whatever the gate would say", async () => {
    for (const literal of [
      "93.184.216.34",
      "10.0.0.1",
      "127.0.0.1",
      "[2001:db8::1]",
      "::1",
    ])
      expect(
        await vetHost(literal, { proxy: "http://127.0.0.1:3128" }),
      ).toEqual({ ok: false, error: "refused" });
  });

  test("a name is vetted by the gate even when the forge's own list would have trusted it", async () => {
    const vetted = await vetHost(NAME, {
      trusted: [NAME],
      resolve: () => Promise.resolve(["10.0.0.1"]),
      proxy: "http://127.0.0.1:3128",
    });
    expect(vetted.ok && vetted.value.via).toBe("gate");
  });
});

describe("vetHost outside a cell is unchanged", () => {
  test("it resolves, judges and pins; the proxy is not asked", async () => {
    const vetted = await vetHost("hooks.example.com", {
      resolve: () => Promise.resolve(["93.184.216.34"]),
    });
    expect(vetted).toEqual({
      ok: true,
      value: { via: "pin", addresses: ["93.184.216.34"] },
    });
    expect(
      await vetHost("hooks.example.com", {
        resolve: () => Promise.resolve(["10.0.0.1"]),
      }),
    ).toEqual({ ok: false, error: "refused" });
    expect(await vetHost("hooks.example.com", { resolve: nothing })).toEqual({
      ok: false,
      error: "unresolved",
    });
  });

  test("a proxy variable on a developer's machine does not make a forge a hosted one", async () => {
    const before = [
      process.env["HTTPS_PROXY"],
      process.env["FORGE_PARENT_LOCAL"],
    ];
    process.env["HTTPS_PROXY"] = "http://127.0.0.1:3128";
    delete process.env["FORGE_PARENT_LOCAL"];
    try {
      const vetted = await vetHost("hooks.example.com", {
        resolve: () => Promise.resolve(["93.184.216.34"]),
      });
      expect(vetted.ok && vetted.value.via).toBe("pin");
    } finally {
      for (const [i, name] of ["HTTPS_PROXY", "FORGE_PARENT_LOCAL"].entries()) {
        if (before[i] === undefined) process.env[name] = "";
        else process.env[name] = before[i]!;
      }
    }
  });
});

describe("outboundFetch in a cell", () => {
  t("asks the gate for the name and reaches the host through it", async () => {
    const g = allowing();
    const res = await outboundFetch(
      `https://${NAME}:${server!.port}/hello`,
      {},
      { resolve: nothing, proxy: g.url, ca: pair!.cert },
    );
    expect(await res.text()).toBe("hello over tls");
    expect(g.connects).toEqual([`${NAME}:${server!.port}`]);
  });

  t("an address literal never reaches the gate", async () => {
    const g = allowing();
    await expect(
      outboundFetch(
        `https://127.0.0.1:${server!.port}/hello`,
        {},
        { proxy: g.url, ca: pair!.cert },
      ),
    ).rejects.toBeInstanceOf(RefusedError);
    expect(g.connects).toEqual([]);
  });

  t(
    "a name the gate refuses is the gate's refusal, not a connection failure",
    async () => {
      const g = allowing();
      const failure = await outboundFetch(
        "https://github.com/x",
        {},
        { proxy: g.url },
      ).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(GateRefusedError);
      expect((failure as GateRefusedError).message).toBe(
        "refused: the forge's host does not let it reach github.com",
      );
    },
  );

  t("a name the gate could not resolve says so", async () => {
    const g = allowing();
    const failure = await outboundFetch(
      "https://nowhere.example.test/x",
      {},
      { proxy: g.url },
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("unresolved host");
  });
});

// Bun's fetch keeps a proxy variable it has seen set, even after the variable is deleted: put back as empty, which it reads as none.
describe("git in a cell", () => {
  const saved = [
    "HTTPS_PROXY",
    "https_proxy",
    "FORGE_PARENT_LOCAL",
    "NO_PROXY",
    "no_proxy",
  ].map((name) => [name, process.env[name]] as const);
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) process.env[name] = "";
      else process.env[name] = value;
    }
  });

  t(
    "ls-remote and fetch go by name through the gate, with no address pinned",
    async () => {
      const g = allowing();
      process.env["HTTPS_PROXY"] = g.url;
      process.env["https_proxy"] = g.url;
      process.env["FORGE_PARENT_LOCAL"] = "127.0.0.1:1";
      delete process.env["NO_PROXY"];
      delete process.env["no_proxy"];
      const url = `https://${NAME}:${server!.port}/r.git`;
      const vetted = await vetHost(NAME, { resolve: nothing });
      expect(vetted.ok && vetted.value.via).toBe("gate");
      const pin = pinFor(
        url,
        vetted.ok ? vetted.value : { via: "gate", proxy: g.url },
      );
      expect(pin).toBeUndefined();
      const env = { ...remoteGitEnv({}, pin), GIT_SSL_CAINFO: pair!.certFile };
      expect(Object.values(env).some((v) => v.includes("curloptResolve"))).toBe(
        false,
      );

      const listed = await runGit(["ls-remote", url], { env });
      expect(listed.ok).toBe(true);
      expect(listed.ok && listed.value).toContain("refs/heads/main");

      const into = mkdtempSync(join(tmpdir(), "forge-gate-fetch-"));
      expect((await runGit(["init", "--bare", into], { env })).ok).toBe(true);
      const fetched = await runGit(
        ["fetch", url, "+refs/heads/*:refs/heads/*"],
        { cwd: into, env },
      );
      expect(fetched.ok).toBe(true);
      expect((await runGit(["rev-parse", "main"], { cwd: into })).ok).toBe(
        true,
      );
      expect(g.connects.length).toBeGreaterThanOrEqual(2);
      expect(new Set(g.connects)).toEqual(new Set([`${NAME}:${server!.port}`]));
    },
  );

  t(
    "outside a cell git is pinned to the judged address and carries no proxy",
    async () => {
      delete process.env["FORGE_PARENT_LOCAL"];
      process.env["HTTPS_PROXY"] = "http://127.0.0.1:9";
      const vetted = await vetHost("git.example.test", {
        resolve: () => Promise.resolve(["93.184.216.34"]),
      });
      expect(vetted.ok && vetted.value.via).toBe("pin");
      const env = remoteGitEnv(
        {},
        pinFor(
          "https://git.example.test/a/b.git",
          vetted.ok ? vetted.value : { via: "gate", proxy: "" },
        ),
      );
      expect(env["GIT_CONFIG_VALUE_1"]).toBe(
        "git.example.test:443:93.184.216.34",
      );
        expect(gitEnv()["HTTPS_PROXY"]).toBeUndefined();
    },
  );
});

describe("a refused host says why", () => {
  const env = { FORGE_ORIGIN_ALLOW: "" };

  t(
    "the gate does not let the forge reach it: the setting an admin changes is named",
    async () => {
      const g = allowing();
      const found = await discover("https://git.sr.ht", env, { proxy: g.url });
      expect(found).toEqual({
        ok: false,
        error: {
          error: "unreachable",
          message:
            "that host could not be reached: this forge's host does not let it reach git.sr.ht; an admin allows it with the setting children.originEgress",
        },
      });
    },
  );

  t("the name did not resolve", async () => {
    const g = allowing();
    const found = await discover("https://nowhere.example.test", env, {
      proxy: g.url,
    });
    expect(found).toEqual({
      ok: false,
      error: {
        error: "unreachable",
        message:
          "that host could not be reached: nowhere.example.test did not resolve",
      },
    });
  });

  t("the host answered, and not with a forge", async () => {
    const g = allowing();
    const found = await discover(`https://${NAME}:${server!.port}`, env, {
      proxy: g.url,
      ca: pair!.cert,
    });
    expect(found).toEqual({
      ok: false,
      error: {
        error: "unreachable",
        message: `that host could not be reached: ${NAME}:${server!.port} answered 404`,
      },
    });
  });
});

describe("the gate's own judgement of an answer", () => {
  test("an IPv4 address in IPv6 clothes is judged as the IPv4 address, in either spelling", () => {
    for (const private4 of [
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::ffff:c0a8:1",
      "::ffff:ac10:1",
    ])
      expect(isPublicAddress(private4)).toBe(false);
    expect(isPublicAddress("::ffff:5db8:d822")).toBe(true);
    expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });

  test("a declared name is judged by the address it resolves to, whatever entry declared it", async () => {
    // `localhost` is a name every machine resolves, and to a loopback address.
    const exact = await decide({ hosts: ["localhost"], origins: [] }, "localhost", 443);
    expect(exact.ok).toBe(false);
    expect(!exact.ok && exact.why).toContain("resolves to a private address");
    const wildcard = await decide({ hosts: ["*.localhost"], origins: [] }, "git.localhost", 443);
    expect(wildcard.ok).toBe(false);
  });

  test("the wildcard the cell is given for the parent's neighbours names its children and nothing else", () => {
    const hosts = ["forge.open-platform.sh:443", "*.open-platform.sh:443", "github.com:443"];
    expect(hostAllowed(hosts, "commons--forge.open-platform.sh", 443)).toBe(true);
    expect(hostAllowed(hosts, "open-platform.sh.evil.test", 443)).toBe(false);
    expect(hostAllowed(hosts, "evilopen-platform.sh", 443)).toBe(false);
    expect(hostAllowed(hosts, "commons--forge.open-platform.sh", 80)).toBe(false);
    expect(hostAllowed(hosts, "gist.github.com", 443)).toBe(false);
  });
});
