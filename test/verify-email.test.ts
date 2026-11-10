import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createApp, type App } from "../src/app.ts";
import { setLimit } from "../src/settings/limits.ts";
import { migrations } from "../src/core/schema.ts";
import { signUp } from "../src/actions/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { setSecret } from "../src/core/secret_store.ts";
import { emailVerified } from "../src/core/verify.ts";
import { missing } from "./helpers/tools.ts";
import { sendMail, type Mail } from "../src/kernel/mail.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

// A fresh outsider signs up and, until the link in its email is followed,
// can read but cannot make or cost anything.
describe("verified email", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const sent: Mail[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-verify-"));
    app = createApp({
      dataDir,
      port: 0,
      url: "https://forge.example",
      mailer: async (mail) => {
        sent.push(mail);
        return true;
      },
    });
    servers = await serve(app);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    base = servers.url;
    // The owner is the admin, made proven as the operator's is. No password:
    // nothing here signs in as the owner, and hashing one is the slow part of
    // setup, which a loaded machine stretched past the hook's 5 s.
    const owner = await seedAdmin(app, {
      username: "olive",
      email: "olive@f.dev",
    });
    if (!owner.ok) throw new Error(owner.error);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const api = (path: string, token: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
    });

  const join_ = async (name: string) => {
    const before = sent.length;
    const res = await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: name,
        email: `${name}@outsider.test`,
        password: "outsider-passphrase",
      }),
    });
    expect(res.status).toBe(201);
    const user = getUserByName(app.db, name)!;
    const mail = sent
      .slice(before)
      .find((m) => m.to === `${name}@outsider.test`);
    return {
      user,
      token: createToken(app.db, user.id, "t", "admin").token,
      link: mail?.text.match(
        /https:\/\/forge\.example\/verify\?token=[A-Za-z0-9_-]+/,
      )?.[0],
    };
  };

  test("signup sends one verification link to the address given", async () => {
    const { link } = await join_("ada");
    expect(link).toBeDefined();
    const mail = sent.find((m) => m.to === "ada@outsider.test")!;
    expect(mail.subject).toContain("Verify");
  });

  test("the admin is verified", () => {
    expect(emailVerified(app.db, getUserByName(app.db, "olive")!.id)).toBe(
      true,
    );
  });

  test("an unverified account can read, but cannot make or cost anything", async () => {
    const { token } = await join_("mallory");
    expect((await api("/api/v1/user", token)).status).toBe(200);
    const refusals = [
      api("/api/v1/repos", token, {
        method: "POST",
        body: JSON.stringify({ name: "x" }),
      }),
      api("/api/v1/apps", token, {
        method: "POST",
        body: JSON.stringify({ name: "y" }),
      }),
      api("/api/v1/orgs", token, {
        method: "POST",
        body: JSON.stringify({ name: "mallory-org" }),
      }),
    ];
    for (const res of await Promise.all(refusals)) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "unverified",
        message: "verify your email first",
      });
    }
    expect(getUserByName(app.db, "mallory-org")).toBeUndefined();
  });

  test("following the link verifies, and the account can create at once", async () => {
    const { user, token, link } = await join_("grace");
    promote(app.db, user);
    expect(emailVerified(app.db, user.id)).toBe(false);
    const before = await api("/api/v1/repos", token, {
      method: "POST",
      body: JSON.stringify({ name: "first" }),
    });
    expect(before.status).toBe(403);
    const followed = await fetch(link!.replace("https://forge.example", base));
    expect(followed.status).toBe(200);
    expect(await followed.text()).toContain("verified");
    expect(emailVerified(app.db, user.id)).toBe(true);
    const after = await api("/api/v1/repos", token, {
      method: "POST",
      body: JSON.stringify({ name: "first" }),
    });
    expect(after.status).toBe(201);
  });

  test("a link works once, and a wrong one verifies nothing", async () => {
    const { user, link } = await join_("hopper");
    const bad = await fetch(`${base}/verify?token=not-a-real-token`);
    expect(bad.status).toBe(400);
    expect(emailVerified(app.db, user.id)).toBe(false);
    expect(
      (await fetch(link!.replace("https://forge.example", base))).status,
    ).toBe(200);
    expect(
      (await fetch(link!.replace("https://forge.example", base))).status,
    ).toBe(400);
  });

  test("a link expires", async () => {
    const { user, link } = await join_("lovelace");
    app.db
      .query(
        "UPDATE email_check SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?1",
      )
      .run(user.id);
    expect(
      (await fetch(link!.replace("https://forge.example", base))).status,
    ).toBe(400);
    expect(emailVerified(app.db, user.id)).toBe(false);
  });

  test("re-sending is rate limited", async () => {
    const { token } = await join_("turing");
    const first = await api("/api/v1/user/email/verify", token, {
      method: "POST",
    });
    expect(first.status).toBe(429);
    app.db
      .query(
        "UPDATE email_check SET last_sent_at = '2000-01-01T00:00:00.000Z' WHERE user_id = (SELECT id FROM user WHERE username = 'turing')",
      )
      .run();
    const later = await api("/api/v1/user/email/verify", token, {
      method: "POST",
    });
    expect(later.status).toBe(202);
    const again = await api("/api/v1/user/email/verify", token, {
      method: "POST",
    });
    expect(again.status).toBe(429);
  });

  test("changing the email asks for it to be proven again", async () => {
    const { user, token, link } = await join_("noether");
    await fetch(link!.replace("https://forge.example", base));
    expect(emailVerified(app.db, user.id)).toBe(true);
    const before = sent.length;
    const patched = await api("/api/v1/user", token, {
      method: "PATCH",
      body: JSON.stringify({ email: "noether@elsewhere.test" }),
    });
    expect(patched.status).toBe(200);
    expect(emailVerified(app.db, user.id)).toBe(false);
    expect(
      sent.slice(before).some((m) => m.to === "noether@elsewhere.test"),
    ).toBe(true);
  });

  test("an account the edge makes must prove an address too", async () => {
    const edged = createApp({
      dataDir: await mkdtemp(join(tmpdir(), "forge-verify-edge-")),
      port: 0,
      url: "https://forge.example",
      edgeToken: "edge-secret",
      mailer: async () => true,
    });
    const { createUser, ensureEdgeUser } = await import("../src/core/users.ts");
    // The edge makes none now; an account it made earlier is still unproven.
    expect(ensureEdgeUser(edged.db, "founder")).toBeUndefined();
    const made = await createUser(edged.db, { origin: "edge", username: "founder", email: "founder@forge.example" });
    expect(made.ok && emailVerified(edged.db, made.value.id)).toBe(false);
    edged.close();
  });

  test("a way in that does not vouch for the address is held back (fail closed)", async () => {
    // Any future path that makes a person without saying "trusted" — a
    // linked sign-in, an invite — starts unproven.
    const made = await createUser(app.db, {
      origin: "seed",
      username: "unvouched",
      email: "unvouched@f.dev",
      password: "unvouched-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    expect(emailVerified(app.db, made.value.id)).toBe(false);
    const token = createToken(app.db, made.value.id, "t", "admin").token;
    const res = await api("/api/v1/repos", token, {
      method: "POST",
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(403);
  });

  test("an account a caller vouches for (a seed, a claim) is not held back", async () => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "seeded",
      email: "seeded@f.dev",
      password: "seeded-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    expect(emailVerified(app.db, made.value.id)).toBe(true);
  });

  test("accounts that existed before verification are proven by the migration", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, created_at TEXT)");
    db.exec("INSERT INTO user VALUES ('u1', '2026-01-01T00:00:00.000Z')");
    db.exec(migrations.find((m) => m.includes("TABLE IF NOT EXISTS email_check"))!);
    const row = db
      .query<{ verified_at: string | null }, []>(
        "SELECT verified_at FROM email_check WHERE user_id = 'u1'",
      )
      .get();
    expect(row?.verified_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("agents are never held back by email", async () => {
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username: "crewbot",
      email: "crewbot@agents.invalid",
      agent: true,
    });
    if (!made.ok) throw new Error(made.error);
    expect(emailVerified(app.db, made.value.id)).toBe(true);
  });

  test("the account says when the email is not proven yet", async () => {
    const { token } = await join_("babbage");
    const me = (await (await api("/api/v1/user", token)).json()) as {
      emailVerified: boolean;
    };
    expect(me.emailVerified).toBe(false);
  });
});

// The transport: SMTP submission, the open standard, no dependency. A tiny
// local server plays the provider.
describe("mail over SMTP", () => {
  test("a message is submitted with AUTH, envelope, headers and dot-stuffing", async () => {
    const seen: string[] = [];
    let data = "";
    const server = Bun.listen<{ inData: boolean }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) {
          s.data = { inData: false };
          s.write("220 test ESMTP\r\n");
        },
        data(s, chunk) {
          const text = new TextDecoder().decode(chunk);
          if (s.data.inData) {
            data += text;
            if (data.endsWith("\r\n.\r\n")) {
              s.data.inData = false;
              s.write("250 queued\r\n");
            }
            return;
          }
          for (const line of text.split("\r\n").filter((l) => l !== "")) {
            seen.push(line);
            if (line.startsWith("EHLO"))
              s.write("250-test\r\n250 AUTH PLAIN\r\n");
            else if (line.startsWith("AUTH PLAIN")) s.write("235 ok\r\n");
            else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO"))
              s.write("250 ok\r\n");
            else if (line === "DATA") {
              s.data.inData = true;
              s.write("354 go\r\n");
            } else if (line === "QUIT") {
              s.write("221 bye\r\n");
              s.end();
            }
          }
        },
      },
    });
    try {
      const ok = await sendMail(
        {
          url: `smtp://user:secret@127.0.0.1:${server.port}`,
          from: "forge@f.dev",
        },
        {
          to: "ada@outsider.test",
          subject: "Verify",
          text: "line one\n.hidden dot\n",
        },
      );
      expect(ok).toBe(true);
      expect(seen).toContain(
        `AUTH PLAIN ${Buffer.from("\0user\0secret").toString("base64")}`,
      );
      expect(seen).toContain("MAIL FROM:<forge@f.dev>");
      expect(seen).toContain("RCPT TO:<ada@outsider.test>");
      expect(data).toContain("Subject: Verify");
      expect(data).toContain("\r\n..hidden dot\r\n");
    } finally {
      server.stop(true);
    }
  });

  test("a header that would inject a line is refused before connecting", async () => {
    const ok = await sendMail(
      { url: "smtp://u:p@127.0.0.1:1", from: "forge@f.dev" },
      { to: "a@b.test\r\nBcc: x@y.test", subject: "Verify", text: "x" },
    );
    expect(ok).toBe(false);
  });

  test("plain smtp:// is refused for anything but this machine", async () => {
    const ok = await sendMail(
      { url: "smtp://u:p@mail.example.com:25", from: "forge@f.dev" },
      { to: "a@b.test", subject: "Verify", text: "x" },
    );
    expect(ok).toBe(false);
  });
});

// Over TLS the forge says nothing — above all not the password — to a server
// whose certificate does not verify and name the host it dialled.
describe.skipIf(missing("openssl"))("mail over SMTP, TLS", () => {
  let dir: string;
  /** A self-signed certificate (key + cert PEM) for `name`. */
  const certFor = async (name: string) => {
    const key = join(dir, `${name}.key`);
    const cert = join(dir, `${name}.pem`);
    const made = await Bun.spawn(
      [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", cert, "-days", "1",
        "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
    if (made !== 0) throw new Error("openssl");
    return { key: await Bun.file(key).text(), cert: await Bun.file(cert).text() };
  };

  /** An SMTP stand-in over TLS that records every line it is sent. */
  const standIn = (pem: { key: string; cert: string }) => {
    const seen: string[] = [];
    let inData = false;
    const server = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: pem.key, cert: pem.cert },
      socket: {
        open(s) {
          s.write("220 test ESMTP\r\n");
        },
        data(s, chunk) {
          const text = new TextDecoder().decode(chunk);
          if (inData) {
            if (text.endsWith("\r\n.\r\n")) {
              inData = false;
              s.write("250 queued\r\n");
            }
            return;
          }
          for (const line of text.split("\r\n").filter((l) => l !== "")) {
            seen.push(line);
            if (line.startsWith("EHLO")) s.write("250-test\r\n250 AUTH PLAIN\r\n");
            else if (line.startsWith("AUTH")) s.write("235 ok\r\n");
            else if (line.startsWith("MAIL") || line.startsWith("RCPT")) s.write("250 ok\r\n");
            else if (line === "DATA") {
              inData = true;
              s.write("354 go\r\n");
            } else if (line === "QUIT") {
              s.write("221 bye\r\n");
              s.end();
            }
          }
        },
      },
    });
    return { server, seen };
  };

  const mail = { to: "ada@outsider.test", subject: "Verify", text: "x" };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-mail-tls-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a self-signed certificate is refused before AUTH", async () => {
    const { server, seen } = standIn(await certFor("localhost"));
    try {
      const ok = await sendMail(
        { url: `smtps://user:secret@localhost:${server.port}`, from: "forge@f.dev" },
        mail,
      );
      expect(ok).toBe(false);
      expect(seen.some((l) => l.startsWith("AUTH"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a certificate that verifies but names another host is refused before AUTH", async () => {
    const other = await certFor("other.example");
    const { server, seen } = standIn(other);
    try {
      const ok = await sendMail(
        {
          url: `smtps://user:secret@localhost:${server.port}`,
          from: "forge@f.dev",
          ca: other.cert,
        },
        mail,
      );
      expect(ok).toBe(false);
      expect(seen.some((l) => l.startsWith("AUTH"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a certificate that verifies and names the host is talked to", async () => {
    const good = await certFor("localhost");
    const { server, seen } = standIn(good);
    try {
      const ok = await sendMail(
        {
          url: `smtps://user:secret@localhost:${server.port}`,
          from: "forge@f.dev",
          ca: good.cert,
        },
        mail,
      );
      expect(ok).toBe(true);
      expect(seen.some((l) => l.startsWith("AUTH PLAIN"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

// The owner configures mail live, in the forge-level secrets store.
describe("mail settings come from the secrets store first", () => {
  test("a signup's link goes to the relay the secrets name, with no restart", async () => {
    const rcpts: string[] = [];
    let inData = false;
    const relay = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) {
          s.write("220 relay\r\n");
        },
        data(s, chunk) {
          const text = new TextDecoder().decode(chunk);
          if (inData) {
            if (text.endsWith("\r\n.\r\n")) {
              inData = false;
              s.write("250 queued\r\n");
            }
            return;
          }
          for (const line of text.split("\r\n").filter((l) => l !== "")) {
            if (line.startsWith("EHLO")) s.write("250 relay\r\n");
            else if (line.startsWith("RCPT TO:")) {
              rcpts.push(line);
              s.write("250 ok\r\n");
            } else if (line.startsWith("MAIL")) s.write("250 ok\r\n");
            else if (line === "DATA") {
              inData = true;
              s.write("354 go\r\n");
            } else if (line === "QUIT") {
              s.write("221 bye\r\n");
              s.end();
            }
          }
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "forge-mail-secrets-"));
    const live = createApp({ dataDir: dir, port: 0, url: "https://forge.example" });
    try {
      // Before the secrets are set the forge sends nothing.
      const first = await signUp(live, { username: "founder", email: "f@f.dev", password: "founder-passphrase" }, { slot: fixtureSlot(live) });
      expect(first.ok).toBe(true);
      setSecret(live.db, live.config.dataDir, "forge", "", "MAIL_SMTP_URL", `smtp://127.0.0.1:${relay.port}`);
      setSecret(live.db, live.config.dataDir, "forge", "", "MAIL_FROM", "forge@f.dev");
      const made = await signUp(live, { username: "newcomer", email: "newcomer@outsider.test", password: "newcomer-passphrase" }, { slot: fixtureSlot(live) });
      expect(made.ok).toBe(true);
      expect(rcpts).toContain("RCPT TO:<newcomer@outsider.test>");
    } finally {
      relay.stop(true);
      live.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
