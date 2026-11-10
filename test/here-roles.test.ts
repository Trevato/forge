/**
 * The manifest is a promise (#10384): for one repository path,
 * /api/v1/here answers differently for a stranger, a signed-in non-member, a
 * writer and an admin; a verb the caller cannot do is absent; every MCP tool
 * it names exists; a private path answers exactly as a missing one.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { requestTiming } from "./helpers/request-timing.ts";
import { statements } from "./helpers/statements.ts";
import { expectWork } from "./helpers/work.ts";
import { WALL_CLOCK_FLOOR_MS } from "../scripts/flake.ts";

let dataDir = "";
let app: App, servers: Servers;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-here-roles-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (name: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: name, email: `${name}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const users: Record<string, Awaited<ReturnType<typeof mk>>> = {};
  for (const [n, f] of [["boss", true], ["wren", false], ["wes", false], ["nina", false]] as const)
    users[n] = await mk(n, f);
  promote(app.db, ...Object.values(users));
  const org = createOrg(app.db, "acme", users["wren"]!.id);
  if (!org.ok) throw new Error(String(org.error));
  const team = createTeam(app.db, org.value.id, "Writers", "write");
  if (!team.ok) throw new Error(String(team.error));
  addTeamMember(app.db, team.value, users["wes"]!.id);
  const made = await newApp(app, users["wren"]!, { name: "pub", owner: "acme", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const priv = await createRepo(app, users["wren"]!, { name: "vault", owner: "acme", visibility: "private" });
  if (!priv.ok) throw new Error(String(priv.error));
  for (const n of Object.keys(users)) tokens[n] = createToken(app.db, users[n]!.id, "t", "rw").token;
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const ask = async (path: string, who?: string) => {
  const res = await fetch(`${servers.url}/api/v1/here?path=${encodeURIComponent(path)}`, {
    headers: who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` },
  });
  return { status: res.status, text: await res.text() };
};
interface Verb {
  do: string;
  mcp?: string;
  noMcp?: string;
  account?: boolean;
}
const verbs = async (who?: string): Promise<Verb[]> =>
  JSON.parse((await ask("/acme/pub", who)).text).can;
const names = (a: Verb[]) => a.map((x) => x.do);

test("each role gets its own list for one repository", async () => {
  const stranger = names(await verbs());
  const member = names(await verbs("nina"));
  const writer = names(await verbs("wes"));
  const admin = names(await verbs("wren"));
  const whole = async (who?: string) => JSON.stringify(await verbs(who));
  const lists = await Promise.all([undefined, "nina", "wes", "wren"].map(whole));
  expect(new Set(lists).size).toBe(4);
  // absent, not present-and-refused
  expect(stranger).not.toContain("merge a pull");
  expect(member).not.toContain("merge a pull");
  expect(member).not.toContain("tell the crew");
  expect(member).toContain("make it yours");
  expect(writer).toContain("merge a pull");
  expect(writer).not.toContain("make it yours");
  expect(writer).not.toContain("change settings");
  expect(admin).toContain("change settings");
  const raw = await verbs();
  expect(raw.find((a) => a.do === "open an issue")?.account).toBe(true);
  expect((await verbs("nina")).find((a) => a.do === "open an issue")?.account).toBeUndefined();
});

test("every MCP tool a verb names is a real tool, and the verbs name it", async () => {
  const real = new Set([...TOOLS.map((t) => t.name), "report"]);
  for (const who of [undefined, "nina", "wes", "wren"])
    for (const a of await verbs(who)) {
      if (a.mcp !== undefined) expect(real.has(a.mcp)).toBe(true);
      // every verb names its tool or says why it has none
      expect(a.mcp !== undefined || (a.noMcp ?? "") !== "").toBe(true);
    }
  const admin = await verbs("wren");
  const mcp = (d: string) => admin.find((a) => a.do === d)?.mcp;
  expect(mcp("merge a pull")).toBe("merge");
  expect(mcp("approve a pull")).toBe("review");
  expect(mcp("change settings")).toBe("repo_settings");
  expect(mcp("offer a change")).toBe("open_pull");
  expect(mcp("comment")).toBe("say");
});

test("a private repository answers exactly as a missing one", async () => {
  for (const who of [undefined, "nina"]) {
    const hidden = await ask("/acme/vault", who);
    const missing = await ask("/acme/nonesuch", who);
    expect(hidden).toEqual(missing);
    expect(hidden.status).toBe(404);
  }
  expect((await ask("/acme/vault", "wren")).status).toBe(200);
});

test("it answers in a bounded number of statements, and its here phase is timed", async () => {
  await ask("/acme/pub", "wes");
  const n = await statements(app.db, async () => {
    await ask("/acme/pub", "wes");
  });
  // the 50 ms budget is held by the work: a bounded count, not one per verb
  expectWork(n, { max: 45 });
  const durs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${servers.url}/api/v1/here?path=%2Facme%2Fpub`, {
      headers: { authorization: `Bearer ${tokens["wes"]}` },
    });
    await res.text();
    const phases = requestTiming(res).split(", ");
    const names = phases.map((p) => p.split(";")[0]!);
    expect(names.slice(names.indexOf("app") + 1, names.indexOf("app") + 3)).toEqual(["session", "here"]);
    durs.push(Number(/dur=([\d.]+)/.exec(phases.find((p) => p.startsWith("here;"))!)?.[1]));
  }
  const best = Math.min(...durs);
  expect(best).not.toBeNaN();
  // a raw clock under the flake floor goes red on a loaded runner (#7824);
  // this bound catches a hang, the statement count above catches the slide
  expect(best).toBeLessThanOrEqual(WALL_CLOCK_FLOOR_MS);
});
