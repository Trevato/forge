/**
 * Drives the compatibility lab with real HTTP and real git between containers
 * (`scripts/forge-compat-lab.sh`). Every check is one cell of the matrix: it
 * passes, fails with what was seen, or says the feature is absent. A failed
 * cell never stops the run, so a partial matrix is still a true one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runShapes } from "./shapes.ts";

type Seeded = { cookie: string; ro: string; rw: string; admin: string; revokable: { id: string; token: string } };
type Seed = Record<"ann" | "rick" | "boss" | "ona" | "pat" | "uma" | "dee", Seeded>;
type Verdict = "pass" | "fail" | "absent";
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RUN = process.env.LAB_RUN ?? "/run-lab";
const seedOf = (name: string): Seed => JSON.parse(readFileSync(`${RUN}/${name}.json`, "utf8")) as Seed;
const addr = (name: string): string => `https://${name}:8443`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const cells: { pair: string; area: string; check: string; verdict: Verdict; note: string }[] = [];
const record = (pair: string, area: string, check: string, verdict: Verdict, note = ""): void => {
  cells.push({ pair, area, check, verdict, note: note.replace(/\s+/g, " ").slice(0, 160) });
  console.log(`${verdict.toUpperCase().padEnd(6)} ${pair} ${area}: ${check}${note ? ` -- ${note.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
};
const cell = async (pair: string, area: string, check: string, run: () => Promise<string | void>): Promise<void> => {
  try {
    const note = await run();
    record(pair, area, check, "pass", note ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("ABSENT")) record(pair, area, check, "absent", message.slice(7));
    else record(pair, area, check, "fail", message);
  }
};
const must = (ok: unknown, said: string): void => {
  if (!ok) throw new Error(said);
};

/** The host side of the lab: stop or start a forge, or run a statement in its database. */
const ctl = async (command: string): Promise<void> => {
  const at = `${RUN}/ctl.${Date.now()}`;
  writeFileSync(`${at}.tmp`, command);
  spawnSync("mv", [`${at}.tmp`, `${RUN}/ctl-request`]);
  for (let i = 0; i < 300; i++) {
    try {
      if (readFileSync(`${RUN}/ctl-done`, "utf8").trim() === command) {
        writeFileSync(`${RUN}/ctl-done`, "");
        return;
      }
    } catch {
      // not yet
    }
    await sleep(200);
  }
  throw new Error(`ctl timed out: ${command}`);
};
const upAgain = async (base: string): Promise<void> => {
  for (let i = 0; i < 150; i++) {
    const r = await fetch(`${base}/api/v1/health`).catch(() => null);
    if (r?.ok) return;
    await sleep(200);
  }
  throw new Error(`${base} did not come up`);
};

/** One person's browser: cookies per origin, redirects by hand, the Origin a form sends. */
class Browser {
  private readonly jar = new Map<string, Map<string, string>>();
  constructor(seed: Record<string, string> = {}) {
    for (const [origin, cookie] of Object.entries(seed)) this.jar.set(origin, new Map([cookie.split("=") as [string, string]]));
  }
  async go(url: URL, init: RequestInit = {}): Promise<Response> {
    const held = this.jar.get(url.origin);
    const headers = new Headers(init.headers);
    if (held) headers.set("cookie", [...held].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0]!;
      const at = pair.indexOf("=");
      const kept = this.jar.get(url.origin) ?? new Map<string, string>();
      kept.set(pair.slice(0, at), pair.slice(at + 1));
      this.jar.set(url.origin, kept);
    }
    return response;
  }
  async walk(start: string | URL, first: RequestInit = {}): Promise<{ url: URL; status: number; text: string; location: string | null }> {
    let url = new URL(start);
    let response = await this.go(url, first);
    for (let hops = 0; hops < 10 && response.status >= 300 && response.status < 400; hops++) {
      url = new URL(response.headers.get("location")!, url);
      response = await this.go(url);
    }
    return { url, status: response.status, text: await response.text(), location: response.headers.get("location") };
  }
  post(to: string | URL, fields: Record<string, string>): ReturnType<Browser["walk"]> {
    const url = new URL(to);
    return this.walk(url, {
      method: "POST",
      headers: { origin: url.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }
  /** A form post answered by a redirect, not followed: the consent form's answer. */
  async postHold(to: string | URL, fields: Record<string, string>): Promise<Response> {
    const url = new URL(to);
    return this.go(url, {
      method: "POST",
      headers: { origin: url.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }
}

const api = async (base: string, path: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: Json; text: string; headers: Headers }> => {
  const headers: Record<string, string> = { "content-type": "application/json", origin: base };
  if (auth.startsWith("forge_session=")) headers.cookie = auth;
  else if (auth !== "") headers.authorization = auth;
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let data: Json = {};
  try {
    data = JSON.parse(text) as Json;
  } catch {
    // a page
  }
  return { status: response.status, data, text, headers: response.headers };
};
const rows = (data: Json): Json[] => (Array.isArray(data) ? (data as Json[]) : ((data.items ?? data.issues ?? data.pulls ?? data.labels ?? data.comments ?? data.repos ?? []) as Json[]));

const unescapeHtml = (text: string): string => text.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&#x3D;", "=");
const plain = (html: string): string => unescapeHtml(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** What a page says went wrong: its alert, not its chrome. */
const said = (page: string): string => plain(/class="[^"]*\b(?:flash|alert|error)\b[^"]*"[^>]*>([\s\S]{0,400}?)<\/(?:div|p|section)>/.exec(page)?.[1] ?? "(no message on the page)").trim();
const said_ = said;
const continueLink = (page: string): string => {
  const hit = /href="([^"]*\/oauth\/authorize[^"]*)"/.exec(page);
  if (hit === null) throw new Error(`no authorize link on the flow page: ${said(page)}`);
  return unescapeHtml(hit[1]!);
};
const consentFields = (page: string, decision: "allow" | "deny", lifetime = "never"): Record<string, string> => {
  const form = /<form method="post" action="\/oauth\/authorize">[\s\S]*?<\/form>/.exec(page)?.[0];
  if (form === undefined) throw new Error(`no consent form: ${plain(page).slice(0, 120)}`);
  const fields: Record<string, string> = { decision, grant: "ro", name: "another forge", lifetime };
  for (const input of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) fields[input[1]!] = unescapeHtml(input[2]!);
  return fields;
};

const gitEnv = (user: string, token: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: user,
  GIT_AUTHOR_EMAIL: `${user}@lab.test`,
  GIT_COMMITTER_NAME: user,
  GIT_COMMITTER_EMAIL: `${user}@lab.test`,
  // The token never on argv, as the forge carries its own.
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
});
const git = (args: string[], env: NodeJS.ProcessEnv, cwd?: string): string => {
  const done = spawnSync("git", args, { env, ...(cwd ? { cwd } : {}), encoding: "utf8", maxBuffer: 1 << 28 });
  if (done.status !== 0) throw new Error(`git ${args[0]}: ${(done.stderr ?? "").slice(0, 140)}`);
  return (done.stdout ?? "").trim();
};
const refsOf = (base: string, full: string, user: string, token: string): string =>
  git(["ls-remote", "--heads", "--tags", `${base}/${full}.git`], gitEnv(user, token)).split("\n").filter((l) => !/refs\/(pull|following)/.test(l)).sort().join("\n");

/** Waits on a mirror job to finish and says how it ended. */
const got = (fullName: string): string => `got-${fullName.split("/")[1]}`;
const mirror = async (r: string, cookie: string, originId: string, fullName: string, limitMs = 300_000): Promise<Json> => {
  const start = await api(r, `/api/v1/user/origins/${originId}/mirror`, cookie, { method: "POST", body: { fullName, name: got(fullName) } });
  if (start.status !== 202) throw new Error(`mirror ${start.status} ${start.text.slice(0, 120)}`);
  const job = (start.data.job?.id ?? start.data.job ?? start.data.id) as string;
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const seen = await api(r, `/api/v1/user/origins/${originId}/mirror/${job}`, cookie);
    const stage = (seen.data.stage ?? seen.data.job?.stage) as string | undefined;
    if (stage === "done" || stage === "failed" || stage === "error") return seen.data.job ?? seen.data;
    await sleep(500);
  }
  throw new Error("mirror job never finished");
};

/** What a source forge carries before anyone connects: issues, a pull, labels, comments by two people. */
const seedWork = async (s: string, seed: Seed): Promise<{ issue: number; pull: number }> => {
  const ann = `Bearer ${seed.ann.rw}`;
  const rick = `Bearer ${seed.rick.rw}`;
  const dir = `/tmp/work-${new URL(s).hostname}`;
  mkdirSync(dir, { recursive: true });
  const env = gitEnv("ann", seed.ann.rw);
  git(["clone", "-q", `${s}/ann/widgets.git`, `${dir}/widgets`], env);
  git(["checkout", "-q", "-b", "feature"], env, `${dir}/widgets`);
  writeFileSync(`${dir}/widgets/feature.txt`, "a feature\n");
  git(["add", "."], env, `${dir}/widgets`);
  git(["commit", "-q", "-m", "a feature"], env, `${dir}/widgets`);
  git(["tag", "v1.0"], env, `${dir}/widgets`);
  git(["push", "-q", "origin", "feature", "v1.0"], env, `${dir}/widgets`);

  const label = await api(s, "/api/v1/repos/ann/widgets/labels", seed.ann.cookie, { method: "POST", body: { name: "bug", color: "ff0000" } });
  must(label.status < 300, `label ${label.status} ${label.text.slice(0, 100)}`);
  const made = await api(s, "/api/v1/repos/ann/widgets/issues", rick, { method: "POST", body: { title: "It breaks", body: "rick reports", labels: ["bug"] } });
  must(made.status === 201, `issue ${made.status} ${made.text.slice(0, 100)}`);
  const issue = (made.data.number ?? made.data.issue?.number) as number;
  const labelled = await api(s, `/api/v1/repos/ann/widgets/issues/${issue}/labels`, seed.ann.cookie, { method: "PUT", body: { labels: ["bug"] } });
  must(labelled.status < 300, `labelling ${labelled.status} ${labelled.text.slice(0, 100)}`);
  const said = await api(s, `/api/v1/repos/ann/widgets/issues/${issue}/comments`, ann, { method: "POST", body: { body: "ann answers" } });
  must(said.status === 201, `comment ${said.status}`);
  const pull = await api(s, "/api/v1/repos/ann/widgets/pulls", ann, { method: "POST", body: { title: "Add a feature", body: "from ann", head: "feature", base: "main" } });
  must(pull.status === 201, `pull ${pull.status} ${pull.text.slice(0, 100)}`);
  return { issue, pull: (pull.data.number ?? pull.data.pull?.number) as number };
};

const results = async (): Promise<void> => {
  const mark = { pass: "pass", fail: "FAIL", absent: "absent" } as const;
  const lines = cells.map((c) => `| ${c.pair} | ${c.area} | ${c.check} | ${mark[c.verdict]} | ${c.note.replaceAll("|", "/")} |`);
  writeFileSync(`${RUN}/matrix.md`, ["| Direction | Area | Check | Result | Seen |", "|---|---|---|---|---|", ...lines, ""].join("\n"));
  writeFileSync(`${RUN}/matrix.json`, JSON.stringify(cells));
};

/** Direct answers of a source forge's own endpoints, no receiver in between. */
const probeSource = async (name: string, s: string, seed: Seed): Promise<void> => {
  const tag = name;
  await cell(tag, "1 discovery", "health names version and commit", async () => {
    const h = await api(s, "/api/v1/health", "");
    must(h.status === 200 && typeof h.data.version === "string", `health ${h.status}`);
    const v = await api(s, "/api/v1/version", "");
    return `version ${h.data.version}; /api/v1/version ${v.status}; /user/repos ${(await api(s, "/api/v1/user/repos", `Bearer ${seed.ann.ro}`)).status}`;
  });
  for (const [scheme, header] of [
    ["Bearer", `Bearer ${seed.ann.ro}`],
    ["token", `token ${seed.ann.ro}`],
    ["Basic", `Basic ${Buffer.from(`ann:${seed.ann.ro}`).toString("base64")}`],
  ] as const) {
    await cell(tag, "2 token scheme", `GET /user with ${scheme}`, async () => {
      const seen = await api(s, "/api/v1/user", header);
      // The cause of "That token was refused": an old forge knows no `token` scheme.
      if (tag === "forge-old" && scheme === "token") {
        must(seen.status === 401, `answered ${seen.status}`);
        return "401: an old forge reads Bearer and Basic only, so a forge must send Bearer";
      }
      must(seen.status === 200, `answered ${seen.status}: ${seen.text.slice(0, 80)}`);
      return `200 as ${seen.data.username}`;
    });
  }
  await cell(tag, "3 oauth endpoints", "register, consent, token, refresh rotates, reused code and refresh refused", async () => {
    const redirect = "https://client.lab.test/cb";
    const reg = await api(s, "/oauth/register", "", { method: "POST", body: { client_name: "lab", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" } });
    must(reg.status === 201, `register ${reg.status} ${reg.text.slice(0, 100)}`);
    const verifier = "lab-verifier-lab-verifier-lab-verifier-lab-verifier";
    const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.data.client_id as string, redirect_uri: redirect, scope: "ro", state: "lab-state", code_challenge: challenge, code_challenge_method: "S256" });
    const b = new Browser({ [s]: seed.ann.cookie });
    const consent = await b.walk(`${s}/oauth/authorize?${q}`);
    must(consent.status === 200, `consent ${consent.status}`);
    const kept = "day";
    const fields = consentFields(consent.text, "allow", kept);
    const answer = await b.postHold(`${s}/oauth/authorize`, fields);
    must(answer.status === 303, `allow ${answer.status}`);
    const back = new URL(answer.headers.get("location")!);
    must(back.searchParams.get("state") === "lab-state", "state not returned");
    const code = back.searchParams.get("code")!;
    const token = (extra: Record<string, string>) =>
      fetch(`${s}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: reg.data.client_id as string, redirect_uri: redirect, ...extra }) });
    const wrong = await token({ grant_type: "authorization_code", code, code_verifier: "not-the-verifier-not-the-verifier-not-the-verifier" });
    must(wrong.status === 400, `wrong verifier ${wrong.status}`);
    // A failed verifier may spend the code, as it should: mint another for the good path.
    const again = await b.postHold(`${s}/oauth/authorize`, fields);
    const code2 = new URL(again.headers.get("location")!).searchParams.get("code")!;
    const good = await token({ grant_type: "authorization_code", code: code2, code_verifier: verifier });
    must(good.status === 200, `token ${good.status}`);
    const first = (await good.json()) as Json;
    const reused = await token({ grant_type: "authorization_code", code: code2, code_verifier: verifier });
    must(reused.status === 400, `reused code ${reused.status}`);
    must(typeof first.refresh_token === "string", `no refresh token for lifetime ${kept}`);
    const fresh = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token as string });
    must(fresh.status === 200, `refresh ${fresh.status}`);
    const second = (await fresh.json()) as Json;
    must(second.refresh_token !== first.refresh_token, "refresh token did not rotate");
    const me = await api(s, "/api/v1/user", `Bearer ${second.access_token as string}`);
    must(me.status === 200, `oauth token on /user ${me.status}`);
    const spent = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token as string });
    must(spent.status === 400, `spent refresh ${spent.status}`);
    return `lifetime ${kept}; ${first.token_type as string} ${first.scope as string}`;
  });
  await cell(tag, "3 oauth endpoints", "redirect-URI mismatch refused before any code", async () => {
    const reg = await api(s, "/oauth/register", "", { method: "POST", body: { client_name: "lab2", redirect_uris: ["https://client.lab.test/cb"], token_endpoint_auth_method: "none" } });
    const q = new URLSearchParams({ response_type: "code", client_id: reg.data.client_id as string, redirect_uri: "https://evil.example/cb", scope: "ro", state: "x", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    const r = await fetch(`${s}/oauth/authorize?${q}`, { headers: { cookie: seed.ann.cookie }, redirect: "manual" });
    must(r.status === 400 && !(r.headers.get("location") ?? "").includes("evil"), `answered ${r.status} ${r.headers.get("location") ?? ""}`);
  });
};

const signIn = async (pair: string, r: string, s: string, rSeed: Seed, sSeed: Seed, lifetime: string): Promise<{ text: string; url: URL }> => {
  const me = new Browser({ [r]: rSeed.ona.cookie });
  const flow = await me.post(`${r}/settings/origins/oauth`, { host: s });
  must(flow.url.pathname.startsWith("/settings/origins/flows/"), `flow page not reached: ${flow.status} ${flow.url.pathname} ${said(flow.text)}`);
  const link = continueLink(flow.text);
  must(new URL(link).origin === s, `authorize at ${new URL(link).origin}`);
  const them = new Browser({ [s]: sSeed.ann.cookie });
  const consent = await them.walk(link);
  must(consent.status === 200, `consent ${consent.status} ${plain(consent.text).slice(0, 100)}`);
  const answer = await them.postHold(`${s}/oauth/authorize`, consentFields(consent.text, "allow", lifetime));
  must(answer.status === 303, `allow answered ${answer.status}`);
  const back = await me.walk(answer.headers.get("location")!);
  return { text: back.text, url: back.url };
};

/** One direction: `r` reads `s`. */
const runPair = async (rName: string, sName: string, work: { issue: number; pull: number } | null): Promise<void> => {
  const pair = `${rName} reads ${sName}`;
  const r = addr(rName);
  const s = addr(sName);
  const rSeed = seedOf(rName);
  const sSeed = seedOf(sName);
  const ann = rSeed.ann.cookie;
  const del = (id: string) => api(r, `/api/v1/user/origins/${id}`, ann, { method: "DELETE" });
  const origins = async (): Promise<Json[]> => rows((await api(r, "/api/v1/user/origins", ann)).data);

  await cell(pair, "1 discovery", "an address that is no forge is refused in words", async () => {
    const seen = await api(r, "/api/v1/user/origins", ann, { method: "POST", body: { host: "https://forge-gone:8443", token: "forge_nope" } });
    must(seen.status === 422 && seen.data.error === "unreachable", `${seen.status} ${seen.text.slice(0, 100)}`);
    return `${seen.data.error}: ${seen.data.message ?? ""}`;
  });

  await cell(pair, "2 connect by token", "a made-up token is refused", async () => {
    const seen = await api(r, "/api/v1/user/origins", ann, { method: "POST", body: { host: s, token: "forge_madeupmadeupmadeup" } });
    must(seen.status === 422 && seen.data.error === "bad_token", `${seen.status} ${seen.text.slice(0, 100)}`);
  });
  await cell(pair, "2 connect by token", "an administrator connects as themselves, a person's own account", async () => {
    const seen = await api(r, "/api/v1/user/origins", rSeed.boss.cookie, { method: "POST", body: { host: s, token: sSeed.boss.ro } });
    if (seen.status !== 201 && rName === "forge-old") throw new Error(`ABSENT ${seen.data.error}: an old forge reads another forge as Gitea and finds no login`);
    must(seen.status === 201, `${seen.status} ${seen.data.error}: ${seen.data.message ?? ""}`);
    return `login ${seen.data.login}`;
  });
  let originId = "";
  await cell(pair, "2 connect by token", "an everyday ro token connects", async () => {
    const seen = await api(r, "/api/v1/user/origins", ann, { method: "POST", body: { host: s, token: sSeed.ann.ro } });
    if (seen.status !== 201 && rName === "forge-old") throw new Error(`ABSENT ${seen.data.error}: an old forge reads another forge as Gitea and finds no login`);
    must(seen.status === 201, `${seen.status} ${seen.data.error ?? ""}: ${seen.data.message ?? seen.text.slice(0, 100)}`);
    must(!seen.text.includes(sSeed.ann.ro), "token echoed");
    originId = seen.data.id as string;
    return `login ${seen.data.login}, software ${seen.data.software}`;
  });
  await cell(pair, "1 discovery", "the address is stored as a forge", async () => {
    if (originId === "" && rName === "forge-old") throw new Error("ABSENT not connected, so nothing stored");
    const row = (await origins()).find((o) => o.id === originId);
    must(row?.software === "forge", `software ${row?.software}, kind ${row?.kind}`);
    return `kind ${row?.kind}`;
  });

  if (originId === "" && rName === "forge-old") {
    await cell(pair, "3 sign-in", "the old forge offers no sign-in to another forge", async () => {
      const me = new Browser({ [r]: rSeed.ona.cookie });
      const flow = await me.post(`${r}/settings/origins/oauth`, { host: s });
      must(!flow.url.pathname.startsWith("/settings/origins/flows/"), "it reached a flow page");
      throw new Error(`ABSENT landed ${flow.url.pathname}; ${said(flow.text)}`);
    });
    record(pair, "4-7", "list, bring, sync, failure", "absent", "a forge older than forge-to-forge cannot connect another forge at all; upgrade it. Nothing here can fix an old build.");
    return;
  }

  await cell(pair, "4 list", "own repositories across pages, private ones included, nobody else's", async () => {
    must(originId, "not connected");
    const names = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const seen = await api(r, `/api/v1/user/origins/${originId}/repos?refresh=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, ann);
      must(seen.status === 200, `${seen.status} ${seen.text.slice(0, 100)}`);
      for (const row of rows(seen.data)) names.add((row.fullName ?? row.full_name) as string);
      cursor = (seen.data.next ?? seen.data.next_cursor ?? undefined) as string | undefined;
      pages++;
    } while (cursor && pages < 40);
    must(names.has("ann/secret"), "private repository missing");
    must(names.has("ann/widgets"), "public repository missing");
    must(![...names].some((n) => n.startsWith("rick/")), "another account's repositories listed");
    const want = Number(process.env.LAB_BULK ?? 130) + 5;
    // A forge that has brought repositories itself has more than it was seeded with.
    must(names.size >= want, `saw ${names.size} of ${want} in ${pages} pages`);
    return `${names.size} in ${pages} pages`;
  });

  // Whole: the repository with all its work, brought with a ro token.
  await cell(pair, "5 bring", "a public repository: history, branches, tags identical", async () => {
    must(originId, "not connected");
    const job = await mirror(r, ann, originId, "ann/widgets");
    must(job.stage === "done", `job ${job.stage}: ${job.error ?? job.message ?? ""}`);
    const theirs = refsOf(s, "ann/widgets", "ann", sSeed.ann.ro);
    const ours = refsOf(r, "ann/got-widgets", "ann", rSeed.ann.ro);
    must(theirs === ours, `refs differ: ${theirs.split("\n").length} there, ${ours.split("\n").length} here`);
    return `${ours.split("\n").length} refs`;
  });
  await cell(pair, "5 bring", "issues and comments, authors kept", async () => {
    const list = await api(r, "/api/v1/repos/ann/got-widgets/issues?state=all", ann);
    const issue = rows(list.data).find((i) => i.title === "It breaks");
    must(issue, `issue not here: ${list.status} ${rows(list.data).length} rows`);
    must(issue!.originAuthor === "rick" || issue!.author === "rick" || issue!.author?.username === "rick", `author ${JSON.stringify(issue!.author)} / ${issue!.originAuthor}`);
    const comments = await api(r, `/api/v1/repos/ann/got-widgets/issues/${issue!.number}/comments`, ann);
    const answer = rows(comments.data).find((c) => c.body === "ann answers");
    must(answer, `comment not here: ${comments.text.slice(0, 100)}`);
    return `#${issue!.number}, ${rows(comments.data).length} comment`;
  });
  await cell(pair, "5 bring", "pulls", async () => {
    const list = await api(r, "/api/v1/repos/ann/got-widgets/pulls?state=all", ann);
    const pull = rows(list.data).find((p) => p.title === "Add a feature");
    must(pull, `pull not here: ${list.status} ${list.text.slice(0, 100)}`);
    return `#${pull!.number} ${pull!.state}`;
  });
  await cell(pair, "5 bring", "labels", async () => {
    const list = await api(r, "/api/v1/repos/ann/got-widgets/labels", ann);
    must(rows(list.data).some((l) => l.name === "bug"), `no label here (${list.status}, ${rows(list.data).length} labels)`);
  });
  await cell(pair, "5 bring", "a label stays on its issue", async () => {
    const list = await api(r, "/api/v1/repos/ann/got-widgets/issues?state=all", ann);
    const issue = rows(list.data).find((i) => i.title === "It breaks");
    must(JSON.stringify(issue?.labels ?? "").includes("bug"), `issue labels ${JSON.stringify(issue?.labels)}`);
  });
  await cell(pair, "5 bring", "a private repository, with the credential", async () => {
    must(originId, "not connected");
    const job = await mirror(r, ann, originId, "ann/secret");
    must(job.stage === "done", `job ${job.stage}: ${job.error ?? job.message ?? ""}`);
    must(refsOf(s, "ann/secret", "ann", sSeed.ann.ro) === refsOf(r, "ann/got-secret", "ann", rSeed.ann.ro), "refs differ");
    const anon = await fetch(`${r}/api/v1/repos/ann/got-secret`);
    must(anon.status === 404 || anon.status === 401, `the copy is readable anonymously: ${anon.status}`);
  });
  await cell(pair, "5 bring", "a big repository, whole tree", async () => {
    must(originId, "not connected");
    const started = Date.now();
    const job = await mirror(r, ann, originId, "ann/big");
    must(job.stage === "done", `job ${job.stage}: ${job.error ?? job.message ?? ""}`);
    const theirs = refsOf(s, "ann/big", "ann", sSeed.ann.ro);
    must(theirs === refsOf(r, "ann/got-big", "ann", rSeed.ann.ro), "refs differ");
    return `${Math.round((Date.now() - started) / 1000)} s, main ${theirs.slice(0, 8)}`;
  });

  // Keep in sync.
  const sApi = (path: string, init: { method?: string; body?: unknown } = {}) => api(s, path, `Bearer ${sSeed.ann.rw}`, init);
  const sync = () => api(r, `/api/v1/user/origins/${originId}/sync`, ann, { method: "POST", body: {} });
  const eventually = async (what: () => Promise<boolean>, ms = 30_000): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await what()) return true;
      await sleep(500);
    }
    return false;
  };
  await cell(pair, "6 sync", "a commit there arrives here with a sync", async () => {
    must(originId, "not connected");
    const wrote = await sApi("/api/v1/repos/ann/widgets/contents", { method: "POST", body: { branch: "main", message: "later commit", files: [{ path: "later.txt", content: "later\n" }] } });
    must(wrote.status < 300, `contents ${wrote.status}`);
    const synced = await sync();
    must(synced.status < 300, `sync ${synced.status} ${synced.text.slice(0, 100)}`);
    must(await eventually(async () => refsOf(s, "ann/widgets", "ann", sSeed.ann.ro) === refsOf(r, "ann/got-widgets", "ann", rSeed.ann.ro)), "the commit did not arrive");
  });
  await cell(pair, "6 sync", "an issue opened there appears here (webhook, else sync)", async () => {
    must(originId, "not connected");
    const made = await sApi("/api/v1/repos/ann/widgets/issues", { method: "POST", body: { title: "Opened there", body: "x" } });
    must(made.status === 201, `issue ${made.status}`);
    const here = async () => rows((await api(r, "/api/v1/repos/ann/got-widgets/issues?state=all", ann)).data).some((i) => i.title === "Opened there");
    if (await eventually(here, 5_000)) return "by webhook";
    await sync();
    must(await eventually(here), "not here after a sync");
    return "by sync (no webhook seen)";
  });
  await cell(pair, "6 sync", "a pull opened there appears here", async () => {
    must(originId, "not connected");
    const branch = await sApi("/api/v1/repos/ann/widgets/contents", { method: "POST", body: { branch: "second", message: "second", files: [{ path: "second.txt", content: "2\n" }] } });
    must(branch.status < 300, `contents ${branch.status}`);
    const made = await sApi("/api/v1/repos/ann/widgets/pulls", { method: "POST", body: { title: "Opened there too", body: "x", head: "second", base: "main" } });
    must(made.status === 201, `pull ${made.status} ${made.text.slice(0, 100)}`);
    const here = async () => rows((await api(r, "/api/v1/repos/ann/got-widgets/pulls?state=all", ann)).data).some((p) => p.title === "Opened there too");
    if (await eventually(here, 5_000)) return "by webhook";
    await sync();
    must(await eventually(here), "not here after a sync");
    return "by sync";
  });
  await cell(pair, "6 sync", "with a ro token, writing here is refused in words, nothing kept", async () => {
    must(originId, "not connected");
    const list = rows((await api(r, "/api/v1/repos/ann/got-widgets/issues?state=all", ann)).data);
    const issue = list.find((i) => i.title === "It breaks");
    must(issue, "no issue");
    const wrote = await api(r, `/api/v1/repos/ann/got-widgets/issues/${issue!.number}/comments`, ann, { method: "POST", body: { body: "from a ro token" } });
    must(wrote.status >= 400, `written: ${wrote.status}`);
    const there = await sApi(`/api/v1/repos/ann/widgets/issues/${issue!.number}/comments`);
    must(!there.text.includes("from a ro token"), "reached the origin");
    return `${wrote.status} ${wrote.data.error}: ${wrote.data.message ?? ""}`;
  });

  // Failure: token gone, access gone, forge gone.
  await cell(pair, "7 failure", "a revoked token: said plainly, marked to reconnect, and a new token repairs it", async () => {
    must(originId, "not connected");
    await del(originId);
    const fresh = await api(r, "/api/v1/user/origins", ann, { method: "POST", body: { host: s, token: sSeed.ann.revokable.token } });
    must(fresh.status === 201, `reconnect ${fresh.status} ${fresh.data.error ?? ""}`);
    originId = fresh.data.id as string;
    const revoked = await api(s, `/api/v1/tokens/${sSeed.ann.revokable.id}`, sSeed.ann.cookie, { method: "DELETE" });
    must(revoked.status < 300, `revoke ${revoked.status}`);
    const direct = await api(s, "/api/v1/user", `Bearer ${sSeed.ann.revokable.token}`);
    must(direct.status === 401, `the source still takes the revoked token: ${direct.status}`);
    const job = await mirror(r, ann, originId, "ann/bulk-010").catch((e: Error) => ({ stage: "refused", error: e.message }));
    must(job.stage !== "done", "a private repository came across on a revoked token");
    const listed = await api(r, `/api/v1/user/origins/${originId}/repos?refresh=1`, ann);
    const row = (await origins()).find((o) => o.id === originId);
    must(row?.needsReauth === true, `list ${listed.status}; needsReauth ${row?.needsReauth}, lastError ${row?.lastError}`);
    must(!/could not be reached/.test(String(job.error)), `it blames the network: ${job.error}`);
    return `${job.stage}: ${job.error}; needsReauth`;
  });
  await cell(pair, "7 failure", "connecting a new token after that works", async () => {
    if (originId) await del(originId);
    const again = await api(r, "/api/v1/user/origins", ann, { method: "POST", body: { host: s, token: sSeed.ann.rw } });
    must(again.status === 201, `rw reconnect ${again.status} ${again.data.error}`);
    originId = again.data.id as string;
    return "rw";
  });
  await cell(pair, "6 sync", "with a rw token, a comment here lands there, under the same issue", async () => {
    must(originId, "not connected");
    const list = rows((await api(r, "/api/v1/repos/ann/got-widgets/issues?state=all", ann)).data);
    const issue = list.find((i) => i.title === "It breaks");
    must(issue, "no issue");
    const wrote = await api(r, `/api/v1/repos/ann/got-widgets/issues/${issue!.number}/comments`, ann, { method: "POST", body: { body: "from the other forge" } });
    must(wrote.status === 201, `${wrote.status} ${wrote.data.error}: ${wrote.data.message ?? wrote.text.slice(0, 100)}`);
    const there = await sApi(`/api/v1/repos/ann/widgets/issues/${issue!.number}/comments`);
    must(there.text.includes("from the other forge"), "not on the origin");
  });
  await cell(pair, "6 sync", "with a rw token, an issue opened here is opened there", async () => {
    must(originId, "not connected");
    const wrote = await api(r, "/api/v1/repos/ann/got-widgets/issues", ann, { method: "POST", body: { title: "Opened here", body: "x" } });
    must(wrote.status === 201, `${wrote.status} ${wrote.data.error}: ${wrote.data.message ?? wrote.text.slice(0, 100)}`);
    const there = await sApi("/api/v1/repos/ann/widgets/issues?state=all");
    must(rows(there.data).some((i) => i.title === "Opened here"), "not on the origin");
  });
  await cell(pair, "6 sync", "webhook: a rw or signed-in token cannot register one (a hook needs admin scope there)", async () => {
    must(originId, "not connected");
    const job = await mirror(r, ann, originId, "ann/bulk-003");
    must(job.stage === "done", `job ${job.stage}`);
    await sleep(2000);
    const hooks = await api(s, "/api/v1/repos/ann/bulk-003/hooks", sSeed.ann.cookie);
    if (rows(hooks.data).length === 0) throw new Error("ABSENT no hook registered: the sweep is the only way back without admin scope");
    return `${rows(hooks.data).length} hook`;
  });
  await cell(pair, "6 sync", "webhook with an admin-scope token: an issue opened there arrives without a sync", async () => {
    const connected = await api(r, "/api/v1/user/origins", rSeed.pat.cookie, { method: "POST", body: { host: s, token: sSeed.ann.admin } });
    must(connected.status === 201, `${connected.status} ${connected.data.error}`);
    const job = await mirror(r, rSeed.pat.cookie, connected.data.id as string, "ann/bulk-004");
    must(job.stage === "done", `job ${job.stage}`);
    await sleep(2000);
    const hooks = await api(s, "/api/v1/repos/ann/bulk-004/hooks", sSeed.ann.cookie);
    must(rows(hooks.data).length > 0, `no hook: ${hooks.text.slice(0, 100)}`);
    const made = await sApi("/api/v1/repos/ann/bulk-004/issues", { method: "POST", body: { title: "By hook", body: "x" } });
    must(made.status === 201, `issue ${made.status}`);
    const arrived = await eventually(async () => rows((await api(r, "/api/v1/repos/pat/got-bulk-004/issues?state=all", rSeed.pat.cookie)).data).some((i) => i.title === "By hook"), 15_000);
    const id = rows(hooks.data)[0]!.id as string;
    const deliveries = await api(s, `/api/v1/repos/ann/bulk-004/hooks/${id}/deliveries`, sSeed.ann.cookie);
    if (!arrived && deliveries.text.includes("private address")) throw new Error("ABSENT the hook is registered; its delivery is refused by the source's SSRF guard, as it should be for this lab's private network. Not verified end to end.");
    must(arrived, `no delivery in 15 s: ${deliveries.text.slice(0, 160)}`);
  });
  const pushed = async (full: string, branch: string): Promise<boolean> => {
    const dir = `/tmp/here-${rName}-${branch}`;
    const env = gitEnv("ann", rSeed.ann.rw);
    git(["clone", "-q", `${r}/ann/got-${full}.git`, dir], env);
    git(["checkout", "-q", "-b", branch], env, dir);
    writeFileSync(`${dir}/here.txt`, "here\n");
    git(["add", "."], env, dir);
    git(["commit", "-q", "-m", "from here"], env, dir);
    git(["push", "-q", "origin", branch], env, dir);
    return refsOf(s, `ann/${full}`, "ann", sSeed.ann.ro).includes(`refs/heads/${branch}`);
  };
  await cell(pair, "6 sync", "a git push to a fresh mirror lands on the origin, and a pull opened here opens there", async () => {
    must(originId, "not connected");
    const job = await mirror(r, ann, originId, "ann/bulk-007");
    must(job.stage === "done", `job ${job.stage}`);
    must(await pushed("bulk-007", "from-here"), "the pushed branch stayed here");
    const made = await api(r, "/api/v1/repos/ann/got-bulk-007/pulls", ann, { method: "POST", body: { title: "Opened here pull", body: "x", head: "from-here", base: "main" } });
    must(made.status === 201, `${made.status} ${made.data.error}: ${made.data.message ?? made.text.slice(0, 100)}`);
    const there = await sApi("/api/v1/repos/ann/bulk-007/pulls?state=all");
    must(rows(there.data).some((p) => p.title === "Opened here pull"), "not on the origin");
  });
  await cell(pair, "6 sync", "a git push to a mirror whose origin was disconnected and connected again still lands there", async () => {
    must(originId, "not connected");
    must(await pushed("widgets", "after-reconnect"), "accepted here and never sent to the origin: the mirror is now ahead of it");
  });
  await cell(pair, "7 failure", "a repository this account cannot read does not come across", async () => {
    const seen = await api(r, "/api/v1/user/origins", rSeed.rick.cookie, { method: "POST", body: { host: s, token: sSeed.rick.ro } });
    must(seen.status === 201, `rick could not connect: ${seen.status} ${seen.data.error}`);
    const job = await api(r, `/api/v1/user/origins/${seen.data.id}/mirror`, rSeed.rick.cookie, { method: "POST", body: { fullName: "ann/secret", name: "stolen" } });
    if (job.status !== 202) {
      must(job.status === 404 || job.status === 403, `answered ${job.status}`);
      return `${job.status} ${job.data.error}`;
    }
    const jobId = (job.data.job?.id ?? job.data.job) as string;
    for (let i = 0; i < 60; i++) {
      const row = await api(r, `/api/v1/user/origins/${seen.data.id}/mirror/${jobId}`, rSeed.rick.cookie);
      const end = (row.data.job ?? row.data) as Json;
      if (end.stage === "done") throw new Error("a repository he cannot read came across");
      if (end.stage === "failed" || end.stage === "error") return `job failed: ${end.error ?? end.message ?? ""}`;
      await sleep(300);
    }
    throw new Error("the job never ended");
  });
  await cell(pair, "7 failure", "a token that lost access: the repository went private there, a sync says so and keeps the copy", async () => {
    const list = rows((await api(r, "/api/v1/user/origins", rSeed.rick.cookie)).data);
    const id = list[0]?.id as string | undefined;
    must(id, "rick not connected");
    const brought = await mirror(r, rSeed.rick.cookie, id!, "ann/bulk-005");
    must(brought.stage === "done", `job ${brought.stage}`);
    const hide = await api(s, "/api/v1/repos/ann/bulk-005", sSeed.ann.cookie, { method: "PATCH", body: { visibility: "private" } });
    must(hide.status < 300, `private there: ${hide.status} ${hide.text.slice(0, 80)}`);
    const synced = await api(r, `/api/v1/user/origins/${id}/sync`, rSeed.rick.cookie, { method: "POST", body: {} });
    await sleep(3000);
    const repo = await api(r, "/api/v1/repos/rick/got-bulk-005", rSeed.rick.cookie);
    const row = rows((await api(r, "/api/v1/user/origins", rSeed.rick.cookie)).data)[0];
    must(repo.status === 200, `copy gone: ${repo.status}`);
    return `sync ${synced.status} ${synced.data.error ?? ""}; lastError ${row?.lastError ?? row?.syncError ?? "none"}; needsReauth ${row?.needsReauth}`;
  });
  await cell(pair, "7 failure", "the origin down in the middle of a bring: fails in words, then succeeds", async () => {
    must(originId, "not connected");
    await ctl(`down ${sName}`);
    let said = "";
    try {
      const start = await api(r, `/api/v1/user/origins/${originId}/mirror`, ann, { method: "POST", body: { fullName: "ann/bulk-001", name: "got-bulk-001" } });
      if (start.status === 202) {
        const jobId = (start.data.job?.id ?? start.data.job) as string;
        for (let i = 0; i < 120 && said === ""; i++) {
          const seen = await api(r, `/api/v1/user/origins/${originId}/mirror/${jobId}`, ann);
          const job = (seen.data.job ?? seen.data) as Json;
          if (job.stage === "done") throw new Error("done with the origin down");
          if (job.stage === "failed" || job.stage === "error") said = `job failed: ${job.error ?? job.message ?? ""}`;
          await sleep(500);
        }
        must(said, "the job never ended");
      } else {
        must(start.status >= 400, `answered ${start.status}`);
        said = `${start.status} ${start.data.error}: ${start.data.message ?? ""}`;
      }
    } finally {
      await ctl(`up ${sName}`);
      await upAgain(s);
    }
    const job = await mirror(r, ann, originId, "ann/bulk-001");
    must(job.stage === "done", `retry: job ${job.stage}: ${job.error ?? job.message ?? ""}`);
    return said;
  });
  await cell(pair, "7 failure", "the origin killed while a big bring runs: fails in words, then succeeds", async () => {
    must(originId, "not connected");
    const start = await api(r, `/api/v1/user/origins/${originId}/mirror`, ann, { method: "POST", body: { fullName: "ann/huge", name: "got-huge" } });
    must(start.status === 202, `${start.status} ${start.text.slice(0, 100)}`);
    await ctl(`down ${sName}`);
    await sleep(1000);
    const jobId = (start.data.job?.id ?? start.data.job) as string;
    let end: Json = {};
    try {
      for (let i = 0; i < 240; i++) {
        const seen = await api(r, `/api/v1/user/origins/${originId}/mirror/${jobId}`, ann);
        end = (seen.data.job ?? seen.data) as Json;
        if (end.stage === "done" || end.stage === "failed" || end.stage === "error") break;
        await sleep(500);
      }
    } finally {
      await ctl(`up ${sName}`);
      await upAgain(s);
    }
    must(end.stage !== "done", "the kill came after the job finished");
    const retry = await mirror(r, ann, originId, "ann/huge", 300_000);
    must(retry.stage === "done", `retry: ${retry.stage} ${retry.error ?? ""}`);
    must(refsOf(s, "ann/huge", "ann", sSeed.ann.ro) === refsOf(r, "ann/got-huge", "ann", rSeed.ann.ro), "refs differ after the retry");
    return `first: ${end.stage} ${end.error ?? ""}; retry done, refs identical`;
  });

  // Someone who owns nothing there: the owner's first real connection.
  const dee = rSeed.dee.cookie;
  let deeId = "";
  const groupOf = async (group: string, extra = ""): Promise<{ names: string[]; next: string | null }> => {
    const seen = await api(r, `/api/v1/user/origins/${deeId}/repos?group=${group}${extra}`, dee);
    must(seen.status === 200, `${group} ${seen.status} ${seen.text.slice(0, 100)}`);
    return { names: rows(seen.data).map((x) => x.fullName as string), next: (seen.data.next_cursor ?? null) as string | null };
  };
  await cell(pair, "4 groups", "owning nothing: yours is empty, the organization's repository is shared, others' are public", async () => {
    const seen = await api(r, "/api/v1/user/origins", dee, { method: "POST", body: { host: s, token: sSeed.dee.ro } });
    must(seen.status === 201, `${seen.status} ${seen.data.error}`);
    deeId = seen.data.id as string;
    // Empty on a forge that has brought nothing; a forge earlier in this run holds what dee brought.
    const yours = (await groupOf("yours")).names;
    must(yours.every((n) => n.startsWith("dee/")), `yours ${yours.join(",")}`);
    const shared = (await groupOf("shared")).names;
    must(shared.length === 1 && shared[0] === "dee-crew/crew-thing", `shared ${shared.join(",")}`);
    const open = (await groupOf("public")).names;
    must(open.length > 0 && !open.includes("ann/secret") && !open.includes("rick/ricks-private"), `public ${open.slice(0, 5).join(",")}`);
    return `${open.length} public on the first page`;
  });
  await cell(pair, "4 groups", "public pages past the first, and search narrows it", async () => {
    must(deeId, "not connected");
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { names: string[]; next: string | null } = await groupOf("public", cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      for (const name of page.names) seen.add(name);
      cursor = page.next;
      pages++;
    } while (cursor !== null && pages < 20);
    must(seen.has("ann/bulk-129") || seen.size > 100, `${seen.size} in ${pages} pages`);
    const found = (await groupOf("public", "&q=lantern")).names;
    must(found.length === 1 && found[0] === "ann/lantern", `search ${found.join(",")}`);
    return `${seen.size} in ${pages} pages`;
  });
  await cell(pair, "4 groups", "the page labels all three", async () => {
    must(deeId, "not connected");
    const page = await new Browser({ [r]: dee }).walk(`${r}/settings/origins/${deeId}/repos?q=e`);
    for (const word of ["Yours", "Shared with you", "Public on this forge", "ann/lantern", "dee-crew/crew-thing"])
      must(page.text.includes(word), `no "${word}" on the page`);
  });
  const contribute = (id: string) =>
    api(r, `/api/v1/user/origins/${id}/browse/ann/lantern/contribute`, dee, {
      method: "POST",
      body: { branch: "from-dee", base: "main", message: "from dee", files: [{ path: "dee.txt", content: "dee\n" }], openPull: { title: "From dee", body: "work back" } },
    });
  await cell(pair, "6 work with", "someone else's public repository comes across for someone with read only", async () => {
    must(deeId, "not connected");
    const job = await mirror(r, dee, deeId, "ann/lantern");
    must(job.stage === "done", `job ${job.stage}: ${job.error ?? ""}`);
    must(refsOf(s, "ann/lantern", "ann", sSeed.ann.ro) === refsOf(r, "dee/got-lantern", "dee", rSeed.dee.ro), "refs differ");
  });
  await cell(pair, "6 work with", "ro: sending work back is refused in words, nothing there", async () => {
    must(deeId, "not connected");
    const sent = await contribute(deeId);
    must(sent.status === 403 && /cannot write/.test(String(sent.data.message)), `${sent.status} ${sent.text.slice(0, 120)}`);
    must(!(await sApi("/api/v1/repos/ann/lantern/pulls?state=all")).text.includes("From dee"), "a pull opened there");
    return String(sent.data.message);
  });
  await cell(pair, "6 work with", "rw: sending work back forks it there and opens a pull, authored by them", async () => {
    must(deeId, "not connected");
    await api(r, `/api/v1/user/origins/${deeId}`, dee, { method: "DELETE" });
    const again = await api(r, "/api/v1/user/origins", dee, { method: "POST", body: { host: s, token: sSeed.dee.rw } });
    must(again.status === 201, `${again.status} ${again.data.error}`);
    deeId = again.data.id as string;
    const sent = await contribute(deeId);
    must(sent.status < 300, `${sent.status} ${sent.text.slice(0, 140)}`);
    const there = rows((await sApi("/api/v1/repos/ann/lantern/pulls?state=all")).data).find((p) => p.title === "From dee");
    must(there, "no pull there");
    must(there!.authorName === "dee", `author ${there!.authorName}`);
    return `#${there!.number} by dee, from their fork`;
  });

  // Followed sources: a plain copy here follows a repository there, by address.
  await cell(pair, "6 follow", "a followed source: a new commit there opens one pull here", async () => {
    const made = await api(r, "/api/v1/repos", ann, { method: "POST", body: { name: "follower", visibility: "public" } });
    must(made.status === 201, `repo ${made.status} ${made.text.slice(0, 100)}`);
    const dir = `/tmp/follow-${rName}`;
    git(["clone", "-q", `${s}/ann/bulk-009.git`, dir], gitEnv("ann", sSeed.ann.ro));
    git(["push", "-q", `${r}/ann/follower.git`, "main"], gitEnv("ann", rSeed.ann.rw), dir);
    const browser = new Browser({ [r]: ann });
    const added = await browser.post(`${r}/ann/follower/settings/sources`, { sources: `${s}/ann/bulk-009.git` });
    must(added.status === 200, `add ${added.status} ${said(added.text)}`);
    const wrote = await sApi("/api/v1/repos/ann/bulk-009/contents", { method: "POST", body: { branch: "main", message: "new there", files: [{ path: "new.txt", content: "new\n" }] } });
    must(wrote.status < 300, `contents ${wrote.status}`);
    const checked = await browser.post(`${r}/ann/follower/settings/sources/check`, {});
    const pulls = await eventually(async () => rows((await api(r, "/api/v1/repos/ann/follower/pulls?state=all", ann)).data).length > 0, 15_000);
    must(pulls, `no pull: ${said(checked.text)}`);
  });

  // Sign-in, as a person who has not used up the connect limit.
  const ona = rSeed.ona.cookie;
  let signedIn = "";
  await cell(pair, "3 sign-in", "through the flow page, the approve form and back, connected as forge", async () => {
    const back = await signIn(pair, r, s, rSeed, sSeed, "day");
    must(back.url.pathname === "/settings/origins" && back.url.search.includes("connected=1"), `landed ${back.url.pathname}${back.url.search}: ${said(back.text)}`);
    const row = rows((await api(r, "/api/v1/user/origins", ona)).data).find((o) => o.authKind === "oauth");
    must(row?.software === "forge" && row?.login === "ann", `row ${JSON.stringify(row)?.slice(0, 120)}`);
    signedIn = row!.id as string;
    return `authKind ${row!.authKind}, expires ${row!.expiresAt}`;
  });
  await cell(pair, "4 list", "with the signed-in token", async () => {
    must(signedIn, "not signed in");
    const seen = await api(r, `/api/v1/user/origins/${signedIn}/repos?refresh=1`, ona);
    must(seen.status === 200 && seen.text.includes("ann/secret"), `${seen.status} ${seen.text.slice(0, 100)}`);
    return `${rows(seen.data).length} repositories`;
  });
  await cell(pair, "5 bring", "a bring with the signed-in token", async () => {
    must(signedIn, "not signed in");
    const job = await mirror(r, ona, signedIn, "ann/bulk-002");
    must(job.stage === "done", `job ${job.stage}: ${job.error ?? job.message ?? ""}`);
    must(refsOf(s, "ann/bulk-002", "ann", sSeed.ann.ro) === refsOf(r, "ona/got-bulk-002", "ona", rSeed.ona.ro), "refs differ");
  });
  await cell(pair, "3 sign-in", "an expiring token refreshes itself before expiry", async () => {
    must(signedIn, "not signed in");
    const before = rows((await api(r, "/api/v1/user/origins", ona)).data).find((o) => o.id === signedIn)!.expiresAt as string;
    await ctl(`sql ${rName} UPDATE origin SET expires_at = '${new Date(Date.now() + 30_000).toISOString()}' WHERE id = '${signedIn}'`);
    const seen = await api(r, `/api/v1/user/origins/${signedIn}/repos?refresh=1`, ona);
    must(seen.status === 200, `${seen.status} ${seen.text.slice(0, 100)}`);
    const after = rows((await api(r, "/api/v1/user/origins", ona)).data).find((o) => o.id === signedIn)!.expiresAt as string;
    must(after > new Date(Date.now() + 3_600_000).toISOString(), `expiry stayed ${after} (was ${before})`);
    return `expiry moved to ${after}`;
  });
  await cell(pair, "7 failure", "a wrong state at the callback connects nothing and says so", async () => {
    const me = new Browser({ [r]: ann });
    const seen = await me.walk(`${r}/settings/origins/callback?state=forged&code=x`);
    must(seen.url.search.includes("error=state"), `landed ${seen.url.pathname}${seen.url.search}`);
    return said(seen.text);
  });
  await cell(pair, "7 failure", "a code used twice at the callback connects nothing the second time", async () => {
    const me = new Browser({ [r]: rSeed.pat.cookie });
    const flow = await me.post(`${r}/settings/origins/oauth`, { host: s });
    const link = continueLink(flow.text);
    const them = new Browser({ [s]: sSeed.pat.cookie });
    const consent = await them.walk(link);
    const answer = await them.postHold(`${s}/oauth/authorize`, consentFields(consent.text, "allow"));
    const back = answer.headers.get("location")!;
    const first = await me.walk(back);
    const second = await me.walk(back);
    must(second.url.search.includes("error="), `second landed ${second.url.pathname}${second.url.search}`);
    return `first ${first.url.search}, second ${second.url.search}`;
  });
  await cell(pair, "7 failure", "the wrong verifier and a mismatched redirect at the origin", async () => {
    const me = new Browser({ [r]: rSeed.pat.cookie });
    const flow = await me.post(`${r}/settings/origins/oauth`, { host: s });
    const link = new URL(continueLink(flow.text));
    const elsewhere = new URL(link);
    elsewhere.searchParams.set("redirect_uri", "https://evil.example/cb");
    const refused = await fetch(elsewhere, { headers: { cookie: sSeed.ann.cookie }, redirect: "manual" });
    must(refused.status === 400, `redirect mismatch answered ${refused.status}`);
  });
  await cell(pair, "7 failure", "the origin down at sign-in says so in words, then signs in", async () => {
    await ctl(`down ${sName}`);
    let said = "";
    const said2 = said_;
    try {
      const me = new Browser({ [r]: rSeed.uma.cookie });
      const flow = await me.post(`${r}/settings/origins/oauth`, { host: s });
      must(!flow.url.pathname.startsWith("/settings/origins/flows/"), "reached a flow page with the origin down");
      said = `${flow.status}: ${said2(flow.text)}`;
    } finally {
      await ctl(`up ${sName}`);
      await upAgain(s);
    }
    const me = new Browser({ [r]: rSeed.uma.cookie });
    const flow = await me.post(`${r}/settings/origins/oauth`, { host: s });
    must(flow.url.pathname.startsWith("/settings/origins/flows/"), `no flow after it came back: ${plain(flow.text).slice(0, 100)}`);
    return said;
  });
  void work;
};

const main = async (): Promise<void> => {
  const names = ["forge-old", "forge-new", "forge-new2"];
  const seeds = Object.fromEntries(names.map((n) => [n, seedOf(n)])) as Record<string, Seed>;
  for (const name of names) await upAgain(addr(name));
  const only = (process.env.LAB_ONLY ?? "").split(",").filter(Boolean);
  const wanted = (p: string): boolean => only.length === 0 || only.includes(p);
  const work: Record<string, { issue: number; pull: number } | null> = {};
  for (const name of names) {
    if (wanted(`probe:${name}`)) await probeSource(name, addr(name), seeds[name]!);
    await cell(name, "seed", "issues, a pull, labels, comments, a tag, by two people, and a big tree", async () => {
      work[name] = await seedWork(addr(name), seeds[name]!);
      const env = gitEnv("ann", seeds[name]!.ann.rw);
      const dir = `/tmp/big-${name}`;
      mkdirSync(dir, { recursive: true });
      git(["init", "-q", "-b", "main", dir], env);
      spawnSync("sh", ["-c", `cp -r /app/src ${dir}/src`], { env });
      git(["add", "."], env, dir);
      git(["commit", "-q", "-m", "a whole tree"], env, dir);
      git(["push", "-q", `${addr(name)}/ann/big.git`, "main"], env, dir);
      spawnSync("sh", ["-c", `head -c 200000000 /dev/urandom > ${dir}/blob.bin`], { env });
      git(["add", "."], env, dir);
      git(["commit", "-q", "-m", "a large file"], env, dir);
      git(["push", "-q", `${addr(name)}/ann/huge.git`, "main"], env, dir);
      return `${git(["ls-files"], env, dir).split("\n").length} files`;
    });
  }
  for (const [r, s] of [["forge-new", "forge-old"], ["forge-old", "forge-new"], ["forge-new2", "forge-new"]] as const)
    if (wanted(`${r}:${s}`)) await runPair(r, s, work[s] ?? null);
  // Opt-in until the cells have run once on a docker host (docs/features/forge-origin.md).
  if (only.includes("shapes"))
    await runShapes({
      a: { base: addr("forge-new"), user: "ann", rw: seeds["forge-new"]!.ann.rw },
      b: { base: addr("forge-new2"), user: "ann", rw: seeds["forge-new2"]!.ann.rw },
      api,
      git,
      gitEnv,
      cell,
      must,
    });
  await results();
  console.log(`${cells.filter((c) => c.verdict === "pass").length} pass, ${cells.filter((c) => c.verdict === "fail").length} fail, ${cells.filter((c) => c.verdict === "absent").length} absent`);
};

await main();
process.exit(0);
