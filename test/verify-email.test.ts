import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { emailVerified } from "../src/core/verify.ts";
import { sendMail, type Mail } from "../src/kernel/mail.ts";
import { serve, type Servers } from "../src/http/server.ts";

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
    base = servers.url;
    // The owner predates verification; the first account is never held back.
    const owner = await signUp(app, {
      username: "owner",
      email: "owner@f.dev",
      password: "owner-passphrase",
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

  test("the first account on a fresh forge is verified", () => {
    expect(emailVerified(app.db, getUserByName(app.db, "owner")!.id)).toBe(
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
      expect(await res.json()).toEqual({
        error: "unverified",
        message: "verify your email first",
      });
    }
    expect(getUserByName(app.db, "mallory-org")).toBeUndefined();
  });

  test("following the link verifies, and the account can create at once", async () => {
    const { user, token, link } = await join_("grace");
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
    const { ensureEdgeUser } = await import("../src/core/users.ts");
    const first = await ensureEdgeUser(edged.db, "founder", "forge.example");
    const second = await ensureEdgeUser(edged.db, "newcomer", "forge.example");
    expect(emailVerified(edged.db, first!.id)).toBe(true);
    expect(emailVerified(edged.db, second!.id)).toBe(false);
    edged.close();
  });

  test("an account a trusted path made (no signup) is not held back", async () => {
    const made = await createUser(app.db, {
      username: "seeded",
      email: "seeded@f.dev",
      password: "seeded-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    expect(emailVerified(app.db, made.value.id)).toBe(true);
  });

  test("agents are never held back by email", async () => {
    const made = await createUser(app.db, {
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
