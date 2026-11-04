/**
 * Seeds one forge of the compatibility lab, run inside its container against
 * that forge's own `src` before the server starts. It imports by path so one
 * file serves both the old tree and the new; only functions stable across the
 * two are used. What it makes is written to /tmp/lab-seed.json (a throwaway
 * forge's throwaway tokens), never printed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const src = process.env.LAB_SRC ?? "/app/src";
const load = (path: string): Promise<any> => import(`${src}/${path}`);

const { createApp } = await load("app.ts");
const { createUser, getUserByName } = await load("core/users.ts");
const { createSession } = await load("core/sessions.ts");
const { createToken } = await load("core/tokens.ts");
const { createRepo, commitToBranch } = await load("actions/repos.ts");
const { setMember } = await load("core/roles.ts");

const app = createApp({ dataDir: process.env.FORGE_DATA ?? "/data", port: 0 });
const bulk = Number(process.env.LAB_BULK ?? 130);
const out: Record<string, unknown> = {};

for (const [username, isAdmin] of [["ann", false], ["rick", false], ["boss", true], ["ona", false], ["pat", false], ["uma", false]] as const) {
  const made = await createUser(app.db, {
    username,
    email: `${username}@lab.test`,
    password: `${username}-lab-password`,
    origin: "seed",
    isAdmin,
    trusted: true,
  });
  if (!made.ok) throw new Error(`no user ${username}: ${String(made.error)}`);
  const user = made.value;
  setMember(app.db, user.id, true, user.id, new Date());
  out[username] = {
    cookie: `forge_session=${createSession(app.db, user.id).token}`,
    ro: createToken(app.db, user.id, "lab ro", "ro").token,
    rw: createToken(app.db, user.id, "lab rw", "rw").token,
    admin: createToken(app.db, user.id, "lab admin", "admin").token,
    revokable: createToken(app.db, user.id, "lab revoke", "ro"),
  };
}
app.db.query("UPDATE email_check SET verified_at = ?1 WHERE verified_at IS NULL").run(new Date().toISOString());

const ann = getUserByName(app.db, "ann");
const rick = getUserByName(app.db, "rick");
const repo = async (owner: unknown, name: string, visibility: string, commits = 0): Promise<void> => {
  const made = await createRepo(app, owner, { name, visibility });
  if (!made.ok) throw new Error(`no repo ${name}: ${String(made.error)}`);
  for (let n = 1; n <= commits; n++) {
    const done = await commitToBranch(app, owner, made.value, {
      branch: "main",
      message: `${name} commit ${n}`,
      files: [{ path: "note.txt", content: `${name} line ${n}\n` }],
    });
    if (!done.ok) throw new Error(`no commit: ${String(done.error)}`);
  }
};
await repo(ann, "widgets", "public", 3);
await repo(ann, "secret", "private", 2);
await repo(ann, "big", "public");
await repo(ann, "huge", "public");
await repo(rick, "ricks", "public", 1);
await repo(rick, "ricks-private", "private", 1);
for (let n = 0; n < bulk; n++) await repo(ann, `bulk-${String(n).padStart(3, "0")}`, n % 10 === 0 ? "private" : "public", 1);

await Bun.write("/tmp/lab-seed.json", JSON.stringify(out));
app.close();
process.exit(0);
