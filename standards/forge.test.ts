/**
 * Conformance, forge side: FORGE_URL (and FORGE_TOKEN for what needs an
 * account). Every check names the standard page it breaks.
 */
import { afterAll, beforeAll, describe } from "bun:test";
import { FORGE_TOKEN, FORGE_URL, conform, forge, must } from "./conform.ts";

const on = FORGE_URL !== "";
const withToken = on && FORGE_TOKEN !== "";
const IDS = ["app-manifest", "identity", "permissions", "feedback", "adapters"];

describe.skipIf(!on)("a forge", () => {
  conform("app-manifest", "/.well-known/forge lists the five standards with whole-number versions", async () => {
    const res = await forge("/.well-known/forge");
    must(res.status === 200, `GET /.well-known/forge answered ${res.status}`);
    must((res.headers.get("content-type") ?? "").includes("application/json"), "not application/json");
    const doc = (await res.json()) as { forge?: { name?: string; version?: string }; standards?: { id: string; version: number; page: string }[] };
    must(typeof doc.forge?.name === "string" && typeof doc.forge?.version === "string", "forge.name and forge.version are strings");
    for (const id of IDS) {
      const entry = doc.standards?.find((s) => s.id === id);
      must(entry !== undefined, `standard ${id} is not listed`);
      must(Number.isInteger(entry!.version) && entry!.version >= 1, `${id}: version is not a whole number`);
      must(entry!.page === `docs/standards/${id}.md`, `${id}: page is ${entry!.page}`);
    }
  });

  conform("feedback", "a report to a missing repository is 404, with no account", async () => {
    const res = await forge("/api/v1/repos/nobody-here/none/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    must(res.status === 404, `answered ${res.status}`);
  });

  conform("feedback", "anonymous GET of an app's notes is 401", async () => {
    const res = await forge("/api/v1/repos/nobody-here/none/app/notes");
    must(res.status === 401, `answered ${res.status}`);
  });
});

describe.skipIf(!withToken)("a forge, with a token: a scratch public repository", () => {
  let owner = "";
  const name = `standards-${Math.random().toString(36).slice(2, 10)}`;
  const api = (path: string, init: RequestInit & { token?: boolean } = {}) => forge(`/api/v1/repos/${owner}/${name}${path}`, init);
  const post = (path: string, body: unknown, token = true) =>
    api(path, { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let ready = true;
  const secret = `${name}-private`;
  const secretApi = (path: string, init: RequestInit = {}) => forge(`/api/v1/repos/${owner}/${secret}${path}`, init);

  beforeAll(async () => {
    if (!withToken) return;
    const me = await forge("/api/v1/user", { token: true });
    if (me.status !== 200) {
      ready = false;
      throw new Error(`FORGE_TOKEN is not accepted: GET /api/v1/user answered ${me.status}`);
    }
    owner = ((await me.json()) as { username: string }).username;
    const made = await forge("/api/v1/repos", {
      method: "POST",
      token: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, visibility: "public" }),
    });
    must(made.status === 201, `could not create the scratch repository: ${made.status}`);
    const hidden = await forge("/api/v1/repos", {
      method: "POST",
      token: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: secret, visibility: "private" }),
    });
    must(hidden.status === 201, `could not create the private scratch repository: ${hidden.status}`);
    const files = [
      { path: "forge.json", content: JSON.stringify({ app: { run: "bun run src/server.ts", health: "/healthz", ready: 30 }, egress: [] }) },
      {
        path: "contract.json",
        content: JSON.stringify({
          roles: {
            anon: { above: [], held: { by: "everyone" } },
            user: { above: ["anon"], held: { by: "identity", role: "user" } },
          },
          resources: { note: { can: { create: "user", read: "anon", update: "user", delete: "user", list: "anon" } } },
        }),
      },
    ];
    const committed = await post("/contents", { message: "standards fixtures", files });
    must(committed.status < 300, `could not commit the fixtures: ${committed.status}`);
  }, 60_000);

  afterAll(async () => {
    if (withToken && ready) {
      await api("", { method: "DELETE", token: true });
      await forge(`/api/v1/repos/${owner}/${secret}`, { method: "DELETE", token: true });
    }
  });

  const file = async (path: string): Promise<unknown> => {
    const res = await api(`/contents/${path}`, { token: true });
    must(res.status === 200, `GET contents/${path} answered ${res.status}`);
    return JSON.parse(((await res.json()) as { content: string }).content);
  };

  conform("app-manifest", "forge.json is JSON with app.run a string, app.health a path, egress a list of hosts", async () => {
    const m = (await file("forge.json")) as { app?: { run?: unknown; health?: unknown; ready?: unknown }; egress?: unknown };
    must(typeof m.app?.run === "string" && m.app.run !== "", "app.run");
    must(typeof m.app?.health === "string" && m.app.health.startsWith("/"), "app.health");
    must(Number.isInteger(m.app?.ready), "app.ready");
    must(Array.isArray(m.egress) && m.egress.every((h) => typeof h === "string"), "egress");
  });

  conform("permissions", "contract.json has one everyone role, declared lower roles, no cycles, closed verbs", async () => {
    const c = (await file("contract.json")) as {
      roles: Record<string, { above: string[]; held: { by: string; role?: string; column?: string } }>;
      resources: Record<string, { can: Record<string, string> }>;
    };
    const roles = Object.entries(c.roles);
    must(roles.filter(([, r]) => r.held.by === "everyone").length === 1, "exactly one role is held by everyone");
    for (const [n, r] of roles) {
      must(["everyone", "identity", "row"].includes(r.held.by), `${n}: held.by`);
      must(r.above.every((b) => c.roles[b] !== undefined), `${n}: above names an undeclared role`);
    }
    const visiting = new Set<string>();
    const walk = (n: string): void => {
      must(!visiting.has(n), `cycle through ${n}`);
      visiting.add(n);
      c.roles[n]!.above.forEach(walk);
      visiting.delete(n);
    };
    Object.keys(c.roles).forEach(walk);
    for (const [res, { can }] of Object.entries(c.resources)) {
      must(JSON.stringify(Object.keys(can).sort()) === JSON.stringify(["create", "delete", "list", "read", "update"]), `${res}: verbs`);
      for (const role of Object.values(can)) must(c.roles[role] !== undefined, `${res}: undeclared role ${role}`);
      must(c.roles[can["create"]!]!.held.by !== "row", `${res}: create needs a row role`);
    }
  });

  conform("feedback", "a stranger's report is accepted (202, pending, anonymous) and an empty title is refused", async () => {
    const res = await post("/reports", { title: "It is down", body: "since noon" }, false);
    must(res.status === 202, `report answered ${res.status}`);
    const r = (await res.json()) as { id?: string; state?: string; filedBy?: { how?: string; name?: unknown } };
    must(typeof r.id === "string" && r.state === "pending", "id and state pending");
    must(r.filedBy?.how === "anonymous" && r.filedBy.name === null, "filedBy anonymous");
    const empty = await post("/reports", { title: "" }, false);
    must(empty.status >= 400 && empty.status < 500, `empty title answered ${empty.status}`);
  });

  conform("feedback", "a title over 200 characters is refused", async () => {
    const res = await post("/reports", { title: "x".repeat(201) }, false);
    must(res.status >= 400 && res.status < 500, `answered ${res.status}`);
  });

  conform("feedback", "a report over the size limit is refused with 413", async () => {
    const res = await post("/reports", { title: "big", body: "x".repeat(70 * 1024) }, false);
    must(res.status === 413, `answered ${res.status}`);
  });

  conform("feedback", "a private repository answers a stranger's report exactly as a missing one does", async () => {
    const send = (url: string) =>
      forge(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    const hidden = await send(`/api/v1/repos/${owner}/${secret}/reports`);
    const missing = await send(`/api/v1/repos/${owner}/${secret}-missing/reports`);
    must(hidden.status === 404, `private repository answered ${hidden.status}`);
    must(missing.status === hidden.status && (await missing.text()) === (await hidden.text()), "private and missing answers differ");
  });

  conform("feedback", "app notes are 401 without a token, and a token is accepted", async () => {
    must((await api("/app/notes")).status === 401, "anonymous app/notes");
    const own = await api("/app/notes", { token: true });
    must(own.status !== 401 && own.status < 500, `owner's app/notes answered ${own.status}`);
  });

  conform("adapters", "pull runs are 401/404 anonymously and are a JSON answer, not a missing route, with a token", async () => {
    const anon = await api("/app/pulls");
    must(anon.status === 401 || anon.status === 404, `anonymous answered ${anon.status}`);
    must(!(await anon.text()).includes('"runs"'), "anonymous answer carries rows");
    const own = await api("/app/pulls", { token: true });
    must(own.status === 200 || own.status === 404, `owner answered ${own.status}`);
    must((own.headers.get("content-type") ?? "").includes("application/json"), "owner's answer is not JSON");
  });
});
