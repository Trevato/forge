/**
 * The outsider suite, against a running forge (#663). It signs up a fresh
 * account over HTTP and tries each thing a stranger must not do, through the
 * JSON API, the web form (with the cookie session) and MCP; every one must be
 * refused. The terminal door cannot be reached over HTTP: `test/outsider-tty.test.ts`.
 * Signup stays shut at the edge until a person has read this suite's result
 * green: `bun scripts/smoke.ts <url> --outsider`.
 *
 * With `ownerToken` it also reaches for the owner's own repositories —
 * private ones must not exist to the stranger, and no repository's crew may
 * take an assignment from it. It writes nothing but the one account
 * (every other attempt is one that must be refused).
 */

export interface Refusal {
  check: string;
  why: string;
}

export interface OutsiderOptions {
  /** The owner's token: names the private repositories to reach for. Without it those checks are not tried, and the run reports that as a refusal not seen. */
  ownerToken?: string;
  fetch?: typeof fetch;
  /** A name for the account; random when left out. */
  username?: string;
}

type Json = Record<string, unknown>;

/** Runs the suite against `base`; returns what was not refused (empty is green). */
export async function outsider(base: string, options: OutsiderOptions = {}): Promise<Refusal[]> {
  const root = new URL(base);
  if (root.protocol !== "http:" && root.protocol !== "https:") throw new Error("url must be http(s)");
  const doFetch = options.fetch ?? globalThis.fetch;
  const bad: Refusal[] = [];
  const call = async (path: string, token: string, method = "GET", json?: unknown): Promise<{ status: number; body: Json }> => {
    const res = await doFetch(new URL(path, root).href, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    let body: Json = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") body = parsed as Json;
    } catch {}
    return { status: res.status, body };
  };
  /**
   * The call must be refused as a refusal: one of `statuses` and, when
   * given, that `error` code. A 404 or 405 from a route that is not there
   * is never a refusal; 404 is accepted only where hiding is the intent.
   */
  const refused = async (
    check: string,
    path: string,
    token: string,
    want: { statuses: number[]; error?: string[]; method?: string; json?: unknown },
  ) => {
    const method = want.method ?? "GET";
    const got = await call(path, token, method, want.json);
    const code = String(got.body["error"] ?? "");
    if (!want.statuses.includes(got.status) || (want.error !== undefined && !want.error.includes(code)))
      bad.push({ check, why: `${method} ${path} answered ${got.status} ${code}, wanted ${want.statuses.join("/")}${want.error ? ` ${want.error.join("/")}` : ""}` });
    return got;
  };

  const username = options.username ?? `outsider-${crypto.randomUUID().slice(0, 8)}`;
  const password = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const signed = await call("/api/v1/users", "", "POST", { username, email: `${username}@example.com`, password });
  if (signed.status !== 201) {
    return [{ check: "sign up", why: `POST /api/v1/users answered ${signed.status} ${String(signed.body["error"] ?? "")}; the suite needs a fresh account` }];
  }
  if (signed.body["isAdmin"] === true || signed.body["is_admin"] === true)
    bad.push({ check: "sign up", why: "a fresh account is an admin" });

  const minted = await call("/api/v1/tokens", "", "POST", { username, password, scope: "rw", name: "outsider-suite" });
  const token = typeof minted.body["token"] === "string" ? minted.body["token"] : "";
  if (!token) return [...bad, { check: "sign in", why: `the fresh account got no token (${minted.status})` }];

  const session = await doFetch(new URL("/api/v1/sessions", root).href, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  await session.body?.cancel();
  const cookies = { cookie: session.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ") };
  if (!cookies.cookie.includes("forge_session=")) bad.push({ check: "sign in", why: `the fresh account got no session (${session.status})` });

  // One MCP tools/call as the stranger. Only an answer that names not-a-member,
  // unverified or forbidden counts as a refusal (an argument error is not one);
  // `hides` also accepts the not_found a door gives where hiding is the intent:
  // "repo" for a repository the stranger may not see, "tool" for the admin tool
  // `signup` (tools/list is checked to still name it, so a moved tool is red).
  const mcp = async (tool: string, args: Json, as = token, hides?: "repo" | "tool"): Promise<{ error: boolean; text: string }> => {
    const res = await doFetch(new URL("/mcp", root).href, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${as}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    const text = await res.text();
    try {
      const result = (JSON.parse(text) as { result?: { isError?: boolean; content?: { text?: string }[] } }).result;
      const said = result?.content?.[0]?.text ?? "";
      // A tool that does not exist refuses everything; that is a moved door, not a closed one
      // (only `signup`, whose presence tools/list proves, may answer no such tool).
      return { error: res.status === 200 && result?.isError === true && (/^(not_member|not.a.member|unverified|forbidden)\b/i.test(said) || (hides === "repo" && /^not_found: no such app or repository\b/i.test(said)) || (hides === "tool" && /^not_found: no such tool\b/i.test(said))), text: said };
    } catch {
      return { error: false, text };
    }
  };
  // tools/list is paged: follow nextCursor, so a tool on a later page still counts.
  let toolsText = "";
  for (let cursor: string | undefined, pages = 0; pages < 10; pages++) {
    const toolList = await doFetch(new URL("/mcp", root).href, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: cursor === undefined ? {} : { cursor } }),
    });
    const text = await toolList.text();
    toolsText += text;
    try {
      const next = (JSON.parse(text) as { result?: { nextCursor?: unknown } }).result?.nextCursor;
      cursor = typeof next === "string" ? next : undefined;
    } catch {
      cursor = undefined;
    }
    if (cursor === undefined) break;
  }
  for (const tool of ["tell", "make_it_yours", "repo", "usage", "apps", "signup"])
    if (!toolsText.includes(`"${tool}"`)) bad.push({ check: "MCP tools", why: `tools/list does not name ${tool}; the suite's doors may have moved` });

  // No wider token than its own, and no made things without membership.
  await refused("no admin token", "/api/v1/tokens", "", { method: "POST", statuses: [403], error: ["forbidden"], json: { username, password, scope: "admin", name: "x" } });
  await refused("no repository of its own", "/api/v1/repos", token, { method: "POST", statuses: [403], error: ["unverified", "not_member"], json: { name: `${username}-repo` } });
  await refused("no app of its own", "/api/v1/apps", token, { method: "POST", statuses: [403], error: ["unverified", "not_member"], json: { name: `${username}-app` } });

  const opened = await mcp("signup", { mode: "open", dryRun: false }, token, "tool");
  if (!opened.error) bad.push({ check: "no admin tool (MCP signup)", why: `signup answered a stranger: ${opened.text.slice(0, 80)}` });

  if (options.ownerToken) {
    const owned = options.ownerToken;
    const ownedRepos = await call("/api/v1/repos?limit=100", owned);
    const items = Array.isArray(ownedRepos.body["items"]) ? (ownedRepos.body["items"] as Json[]) : [];
    if (ownedRepos.status !== 200) bad.push({ check: "owner token", why: `GET /api/v1/repos answered ${ownedRepos.status} for the owner's token` });
    let aimed = 0;
    for (const repo of items.slice(0, 50)) {
      const owner = String(repo["owner"] ?? repo["ownerName"] ?? "");
      const name = String(repo["name"] ?? "");
      if (!owner || !name) continue;
      const at = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      const label = `${owner}/${name}`;
      const hidden = repo["visibility"] === "private";
      if (hidden) {
        for (const sub of ["", "/issues", "/usage", "/runs", "/crew"])
          await refused(`no read of private ${label}`, at + sub, token, { statuses: [404] });
        for (const tool of ["repo", "usage"]) {
          const got = await mcp(tool, { repo: label }, token, "repo");
          if (!got.error) bad.push({ check: `no read of private ${label} (MCP ${tool})`, why: `${tool} answered a stranger: ${got.text.slice(0, 80)}` });
        }
        const listing = await mcp("apps", {});
        if (listing.text.includes(`${label}`)) bad.push({ check: `no read of private ${label} (MCP apps)`, why: "apps lists it for a stranger" });
        await refused(`no issue in private ${label}`, `${at}/issues`, token, { method: "POST", statuses: [404], json: { title: "outsider", body: "" } });
      }
      // Steering: an assignment would start a crew run. Aim at a real issue
      // and a real crew member, through the JSON door and the form door, and
      // read the issue back as the owner: it must not have moved.
      const mine = await mcp("make_it_yours", { repo: label, dryRun: false }, token, "repo");
      if (!mine.error) bad.push({ check: `no copy of ${label} (MCP make_it_yours)`, why: `make_it_yours answered a stranger: ${mine.text.slice(0, 80)}` });
      const issues = await call(`${at}/issues?limit=1`, owned);
      const issue = Array.isArray(issues.body["items"]) ? (issues.body["items"] as Json[])[0] : undefined;
      const crew = await call(`${at}/crew`, owned);
      const agent = Array.isArray(crew.body["items"]) ? (crew.body["items"] as Json[])[0] : undefined;
      const number = issue?.["number"];
      const agentName = String(agent?.["username"] ?? agent?.["name"] ?? "");
      if (typeof number !== "number" || !agentName) continue;
      aimed++;
      const door = `${at}/issues/${number}/assignee`;
      // The route exists and checks permission before it checks the name: the owner meets 422.
      const control = await call(door, owned, "PUT", { assignee: "no-such-account-outsider" });
      if (control.status !== 422) bad.push({ check: "assignee route", why: `PUT ${door} answered ${control.status} for the owner, wanted 422; the route may have moved` });
      const before = issue?.["assigneeName"] ?? null;
      const runs = await call(`${at}/runs?limit=100`, owned);
      const runsBefore = Array.isArray(runs.body["items"]) ? (runs.body["items"] as unknown[]).length : -1;
      const words = hidden ? [404] : [403];
      await refused(`no steering of ${label} (API)`, door, token, { method: "PUT", statuses: words, json: { assignee: agentName } });
      // The form door, as a stranger at a browser: the cookie session, a same-origin POST.
      const formAt = `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/assignee`;
      const form = await doFetch(new URL(formAt, root).href, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { cookie: cookies.cookie, "content-type": "application/x-www-form-urlencoded", origin: root.origin },
        body: new URLSearchParams({ assignee: agentName }),
      });
      await form.body?.cancel();
      const refusedPlainly = form.status === 403 || form.status === 404;
      if (!refusedPlainly) {
        // A redirect is a refusal only when the page it lands on says so.
        const landed = form.status >= 300 && form.status < 400 ? form.headers.get("location") : null;
        let said = "";
        if (landed) {
          const jar = [cookies.cookie, ...form.headers.getSetCookie().map((c) => c.split(";")[0]!)].join("; ");
          const page = await doFetch(new URL(landed, root).href, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { cookie: jar } });
          said = await page.text();
        }
        if (!/need write access|permission|not allowed|forbidden/i.test(said))
          bad.push({ check: `no steering of ${label} (form)`, why: `the assignee form answered ${form.status} and no refusal was seen` });
      }
      if (hidden && form.status !== 404 && form.status !== 403)
        bad.push({ check: `no steering of ${label} (form)`, why: `a private repository's form answered ${form.status}, wanted 404` });
      // The MCP door: the tools that tell the crew or copy an app.
      const told = await mcp("tell", { repo: label, text: "outsider suite: please change something" }, token, hidden ? "repo" : undefined);
      if (!told.error) bad.push({ check: `no steering of ${label} (MCP tell)`, why: "tell was accepted from a stranger" });
      const after = await call(`${at}/issues?limit=1`, owned);
      const runsNow = await call(`${at}/runs?limit=100`, owned);
      if (runsNow.status === 200 && Array.isArray(runsNow.body["items"]) && (runsNow.body["items"] as unknown[]).length !== runsBefore)
        bad.push({ check: `no steering of ${label}`, why: "a run appeared after the stranger's attempts" });
      const now = Array.isArray(after.body["items"]) ? (after.body["items"] as Json[])[0]?.["assigneeName"] ?? null : "unreadable";
      if (now !== before) bad.push({ check: `no steering of ${label}`, why: `the issue's assignee went from ${String(before)} to ${String(now)} by the stranger's hand` });
    }
    const kept = await call(`/api/v1/repos?limit=100`, token);
    if (Array.isArray(kept.body["items"]) && (kept.body["items"] as Json[]).some((r) => String(r["ownerName"] ?? r["owner"]) === username))
      bad.push({ check: "no repository of its own", why: "the stranger owns a repository after the attempts" });
    if (aimed === 0) bad.push({ check: "no steering", why: "no repository of the owner has both an issue and a crew member to aim at" });
  } else {
    bad.push({ check: "owner token", why: "steering and private reads were not tried" });
  }
  return bad;
}
