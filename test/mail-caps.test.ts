/**
 * Mail the forge sends is capped per recipient and forge-wide (#784), not
 * only per account: however many accounts ask, one address hears a few
 * messages a day, and the forge as a whole sends a bounded number; past
 * that ceiling nothing goes, the person waiting is told why, the owner
 * hears once, and the counts hold across a restart.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  CAPPED_WORDS,
  mailCeilingLines,
  mayMail,
  RECIPIENT_DAILY,
} from "../src/actions/mail.ts";
import { sendVerification } from "../src/actions/verify.ts";
import { mailbox, recipientKey } from "../src/core/mail_log.ts";
import { createHash } from "node:crypto";
import { listEvents } from "../src/core/events.ts";
import { createUser, getUserById, type User } from "../src/core/users.ts";
import { RESEND_AFTER_MS } from "../src/core/verify.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Mail } from "../src/kernel/mail.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let owner: User;
const sent: Mail[] = [];
let made = 0;

const open = (): App =>
  createApp({
    dataDir,
    port: 0,
    url: "https://forge.example",
    mailer: async (mail) => {
      sent.push(mail);
      return true;
    },
  });

async function person(email = `p${++made}@example.com`): Promise<User> {
  const u = await createUser(app.db, {
    username: `p${++made}`,
    email,
    password: "a-good-passphrase",
  });
  if (!u.ok) throw new Error(u.error);
  return u.value;
}

/** Point `user` at `email`, as a changed address would. */
function readdress(user: User, email: string): User {
  app.db.query("UPDATE user SET email = ?1 WHERE id = ?2").run(email, user.id);
  return getUserById(app.db, user.id)!;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mail-caps-"));
  app = open();
  servers = await serve(app);
  const o = await createUser(app.db, {
    trusted: true,
    username: "olive",
    email: "olive@forge.example",
    password: "owner-passphrase",
    adminIfFirst: true,
  });
  if (!o.ok) throw new Error(o.error);
  owner = o.value;
});

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("one address hears a few messages a day, whoever asks", () => {
  test("many accounts asking for links to one stranger get past the cap only that often", async () => {
    const stranger = "stranger@example.com";
    let now = Date.now();
    const to = () => sent.filter((m) => m.to === stranger).length;
    // Accounts take the stranger's address one after another, each asking.
    for (let n = 0; n < RECIPIENT_DAILY + 3; n++) {
      if (n > 0)
        app.db
          .query("UPDATE user SET email = ?1 WHERE lower(email) = ?2")
          .run(`moved${n}@example.com`, stranger);
      const asker = readdress(await person(), stranger);
      now += RESEND_AFTER_MS + 1;
      const outcome = await sendVerification(app, asker, now);
      expect(outcome).toBe(n < RECIPIENT_DAILY ? "sent" : "capped");
    }
    expect(to()).toBe(RECIPIENT_DAILY);
    // Another address is not held back by the stranger's count.
    expect(await sendVerification(app, await person(), now)).toBe("sent");
  });

  test("a +tag, Gmail's dots and its second domain make no new person", async () => {
    const variants = [
      ["ann+1@gmail.com", "A.nn@googlemail.com", "ann+news@gmail.com", "an.n@gmail.com"],
      ["bob+1@example.com", "BOB+2@example.com", "bob@example.com", "bob+3@example.com"],
    ];
    let now = Date.now();
    for (const addresses of variants)
      for (const [n, address] of addresses.entries()) {
        const asker = readdress(await person(), address);
        now += RESEND_AFTER_MS + 1;
        expect(await sendVerification(app, asker, now)).toBe(
          n < RECIPIENT_DAILY ? "sent" : "capped",
        );
      }
    // Dots are one mailbox only where the provider says so.
    expect(mailbox("b.ob@example.com")).not.toBe(mailbox("bob@example.com"));
    expect(mailbox("A.n.n+x@GoogleMail.com")).toBe("ann@gmail.com");
  });

  test("the count is keyed with the forge's secret, never a bare hash of the address", () => {
    const stored = app.db
      .query<{ recipient: string }, []>("SELECT recipient FROM mail_sent")
      .all()
      .map((r) => r.recipient);
    expect(stored.length).toBeGreaterThan(0);
    const bare = createHash("sha256").update("stranger@example.com").digest("hex");
    expect(stored).not.toContain(bare);
    expect(stored).toContain(recipientKey(app.config.dataDir, "Stranger+x@example.com"));
  });

  test("the person waiting is told plainly, over the API", async () => {
    const victim = "victim@example.com";
    const asker = readdress(await person(), victim);
    let now = Date.now();
    for (let n = 0; n < RECIPIENT_DAILY; n++) {
      now += RESEND_AFTER_MS + 1;
      expect(await sendVerification(app, asker, now)).toBe("sent");
    }
    const token = createToken(app.db, asker.id, "t", "rw").token;
    const res = await fetch(`${servers.url}/api/v1/user/email/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("capped");
    expect(body.message).toBe(CAPPED_WORDS);
  });
});

describe("the forge as a whole sends a bounded number a day", () => {
  test("past the ceiling no mail goes, and the owner hears once", async () => {
    const already = app.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM mail_sent")
      .get()!.n;
    app.config.mailDailyCap = already + 1;
    try {
      const before = sent.length;
      expect(await sendVerification(app, await person())).toBe("sent");
      expect(await sendVerification(app, await person())).toBe("capped");
      expect(await sendVerification(app, await person())).toBe("capped");
      expect(sent.length).toBe(before + 1);
      // One event a day wakes the notifier, and one line asks the owner.
      expect(
        listEvents(app.db, {}).filter((e) => e.kind === "mail.ceiling"),
      ).toHaveLength(1);
      const lines = mailCeilingLines(app, owner);
      expect(lines).toHaveLength(1);
      expect(mailCeilingLines(app, await person())).toEqual([]);
    } finally {
      delete app.config.mailDailyCap;
    }
  });
});

describe("the counts survive a restart", () => {
  test("a reopened forge still holds a capped address back", async () => {
    const held = "held@example.com";
    const asker = readdress(await person(), held);
    let now = Date.now();
    for (let n = 0; n < RECIPIENT_DAILY; n++) {
      now += RESEND_AFTER_MS + 1;
      expect(await sendVerification(app, asker, now)).toBe("sent");
    }
    servers.stop();
    app.close();
    app = open();
    servers = await serve(app);
    expect(mayMail(app, held, now)).toBe(false);
    expect(mayMail(app, "fresh@example.com", now)).toBe(true);
  });
});
