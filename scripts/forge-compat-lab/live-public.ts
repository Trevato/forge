/**
 * The public group against a real forge's real answers, by anonymous GETs only
 * (`bun scripts/forge-compat-lab/live-public.ts https://a.forge`). Nobody signs
 * in: a local stand-in answers who the account is and forwards the repository
 * list without any credential.
 */
const live = process.argv[2];
if (live === undefined) throw new Error("name the forge");
const src = process.env.LAB_SRC ?? "/app/src";
const { providerFor } = await import(`${src}/origins/providers/index.ts`);
const { staticCredential } = await import(`${src}/origins/types.ts`);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/user") return Response.json({ username: "nobody-here", displayName: "x" });
    if (url.pathname === "/api/v1/user/orgs") return Response.json({ items: [], next_cursor: null });
    if (request.method !== "GET" || url.pathname !== "/api/v1/repos") return new Response("{}", { status: 404 });
    const answer = await fetch(`${live}${url.pathname}${url.search}`);
    return new Response(await answer.text(), { status: answer.status, headers: { "content-type": "application/json" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const provider = providerFor(staticCredential({ kind: "gitea", software: "forge", apiUrl: `${base}/api/v1`, webUrl: base, login: "nobody-here", token: "unused" }));
for (const group of ["yours", "shared", "public"] as const) {
  const read = await provider.listRepoGroup(group, {});
  if (!read.ok) throw new Error(`${group}: ${read.error.message}`);
  const names: string[] = read.value.items.map((r: { fullName: string }) => r.fullName);
  console.log(`${group}: ${names.length}${names.length > 0 ? ` (${names.slice(0, 6).join(", ")})` : ""}${read.value.next === null ? "" : ", more"}`);
}
server.stop(true);
process.exit(0);
