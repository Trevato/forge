import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../src/core/schema.ts";
import {
  appendTurn,
  archiveConversation,
  getConversation,
  listConversations,
  newConversation,
  renameConversation,
  TITLE_MAX,
  listTurns,
  MAX_TURN_CHARS,
  openConversation,
  setClaudeSession,
  TURNS_KEPT,
} from "../src/core/conversations.ts";
import { openDb } from "../src/kernel/db.ts";

const dir = mkdtempSync(join(tmpdir(), "forge-conversations-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open = (name: string) => {
  const db = openDb(join(dir, name), migrations);
  for (const u of ["u1", "u2"])
    db.query("INSERT OR IGNORE INTO user (id, username, email, password_hash) VALUES (?1,?1,?2,'x')").run(u, `${u}@x`);
  return db;
};

describe("conversations", () => {
  test("a conversation keeps its newest TURNS_KEPT turns and no more (#8321)", () => {
    const db = open("bounded.db");
    const c = openConversation(db, "u1");
    for (let i = 0; i < TURNS_KEPT + 5; i++) appendTurn(db, "u1", c.id, { role: "person", text: `t${i}` });
    const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM conversation_turn WHERE conversation_id = ?1").get(c.id)!.n;
    expect(n).toBe(TURNS_KEPT);
    const last = listTurns(db, "u1", c.id, { limit: 1 });
    expect(last.ok && last.value[0]!.text).toBe(`t${TURNS_KEPT + 4}`);
    db.close();
  });

  test("one conversation per person, returned on the second open", () => {
    const db = open("one.db");
    const a = openConversation(db, "u1");
    expect(openConversation(db, "u1").id).toBe(a.id);
    expect(openConversation(db, "u2").id).not.toBe(a.id);
    db.close();
  });

  test("turns written, database reopened, read back in order", () => {
    const db = open("reopen.db");
    const c = openConversation(db, "u1");
    for (const [role, text] of [["person", "hi"], ["agent", "hello"], ["tool", "ran"], ["confirm", "ok?"]] as [string, string][])
      expect(appendTurn(db, "u1", c.id, { role, text }).ok).toBe(true);
    setClaudeSession(db, "u1", c.id, "sess-1");
    db.close();
    const again = open("reopen.db");
    const c2 = openConversation(again, "u1");
    expect(c2.id).toBe(c.id);
    expect(c2.claudeSessionId).toBe("sess-1");
    const r = listTurns(again, "u1", c.id);
    expect(r.ok && r.value.map((t) => `${t.role}:${t.text}`)).toEqual([
      "person:hi", "agent:hello", "tool:ran", "confirm:ok?",
    ]);
    again.close();
  });

  test("pages back from the newest, newest last", () => {
    const db = open("page.db");
    const c = openConversation(db, "u1");
    for (let i = 1; i <= 5; i++) appendTurn(db, "u1", c.id, { role: "person", text: `t${i}` });
    const last = listTurns(db, "u1", c.id, { limit: 2 });
    expect(last.ok && last.value.map((t) => t.text)).toEqual(["t4", "t5"]);
    const before = last.ok ? last.value[0]!.id : "";
    const prev = listTurns(db, "u1", c.id, { limit: 2, before });
    expect(prev.ok && prev.value.map((t) => t.text)).toEqual(["t2", "t3"]);
    db.close();
  });

  test("many turns in one burst page back without gaps or repeats", () => {
    const db = open("burst.db");
    const c = openConversation(db, "u1");
    for (let i = 0; i < 120; i++) appendTurn(db, "u1", c.id, { role: "person", text: `n${i}` });
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const r = listTurns(db, "u1", c.id, before === undefined ? { limit: 50 } : { limit: 50, before });
      if (!r.ok || r.value.length === 0) break;
      seen.unshift(...r.value.map((t) => t.text));
      before = r.value[0]!.id;
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `n${i}`));
    db.close();
  });

  test("a before id from another conversation pages nothing", () => {
    const db = open("cross.db");
    const a = openConversation(db, "u1");
    const b = openConversation(db, "u2");
    const t = appendTurn(db, "u2", b.id, { role: "person", text: "b" });
    appendTurn(db, "u1", a.id, { role: "person", text: "a" });
    const r = listTurns(db, "u1", a.id, { before: t.ok ? t.value.id : "" });
    expect(r.ok && r.value).toEqual([]);
    db.close();
  });

  test("the Claude session id is checked", () => {
    const db = open("sess.db");
    const c = openConversation(db, "u1");
    expect(setClaudeSession(db, "u1", c.id, "x".repeat(129))).toEqual({ ok: false, error: "bad_session" });
    expect(setClaudeSession(db, "u1", c.id, "a b;c")).toEqual({ ok: false, error: "bad_session" });
    expect(setClaudeSession(db, "u1", c.id, "")).toEqual({ ok: false, error: "bad_session" });
    expect(setClaudeSession(db, "u1", c.id, "3f2a-9b").ok).toBe(true);
    db.close();
  });

  test("another person's conversation is not_found", () => {
    const db = open("own.db");
    const c = openConversation(db, "u1");
    expect(appendTurn(db, "u2", c.id, { role: "person", text: "x" })).toEqual({ ok: false, error: "not_found" });
    expect(listTurns(db, "u2", c.id)).toEqual({ ok: false, error: "not_found" });
    expect(setClaudeSession(db, "u2", c.id, "s")).toEqual({ ok: false, error: "not_found" });
    db.close();
  });

  test("turn text is checked at the boundary", () => {
    const db = open("bounds.db");
    const c = openConversation(db, "u1");
    const add = (role: string, text: string) => appendTurn(db, "u1", c.id, { role, text });
    expect(add("person", "x".repeat(MAX_TURN_CHARS)).ok).toBe(true);
    expect(add("person", "x".repeat(MAX_TURN_CHARS + 1))).toEqual({ ok: false, error: "text_too_long" });
    expect(add("person", "  ")).toEqual({ ok: false, error: "empty_text" });
    expect(add("robot", "hi")).toEqual({ ok: false, error: "bad_role" });
    db.close();
  });
});

describe("many conversations (#8814)", () => {
  test("new starts another; the list is newest activity first and the latest is where messages go", () => {
    const db = open("many.db");
    const a = openConversation(db, "u1");
    const b = newConversation(db, "u1");
    expect(b.id).not.toBe(a.id);
    expect(listConversations(db, "u1").map((c) => c.id)).toEqual([b.id, a.id]);
    Bun.sleepSync(3);
    appendTurn(db, "u1", a.id, { role: "person", text: "hi" });
    expect(listConversations(db, "u1").map((c) => c.id)).toEqual([a.id, b.id]);
    expect(openConversation(db, "u1").id).toBe(a.id);
  });

  test("rename keeps a clean title and refuses a long or multi-line one", () => {
    const db = open("rename.db");
    const c = openConversation(db, "u1");
    const named = renameConversation(db, "u1", c.id, "  Plan the week ");
    expect(named.ok && named.value.title).toBe("Plan the week");
    expect(renameConversation(db, "u1", c.id, "x".repeat(TITLE_MAX + 1))).toEqual({ ok: false, error: "bad_title" });
    expect(renameConversation(db, "u1", c.id, "a\nb")).toEqual({ ok: false, error: "bad_title" });
    expect(getConversation(db, "u1", c.id)?.title).toBe("Plan the week");
  });

  test("archive puts one behind the filter, restore brings it back, turns survive", () => {
    const db = open("archive.db");
    const a = openConversation(db, "u1");
    appendTurn(db, "u1", a.id, { role: "person", text: "keep me" });
    const b = newConversation(db, "u1");
    expect(archiveConversation(db, "u1", b.id, true).ok).toBe(true);
    expect(listConversations(db, "u1").map((c) => c.id)).toEqual([a.id]);
    expect(listConversations(db, "u1", { archived: true }).map((c) => c.id)).toEqual([b.id]);
    expect(openConversation(db, "u1").id).toBe(a.id);
    archiveConversation(db, "u1", a.id, true);
    expect(openConversation(db, "u1").id).not.toBe(a.id);
    archiveConversation(db, "u1", a.id, false);
    expect(listTurns(db, "u1", a.id)).toMatchObject({ ok: true, value: [{ text: "keep me" }] });
  });

  test("another person's id is not found for every call", () => {
    const db = open("other.db");
    const mine = openConversation(db, "u1");
    expect(getConversation(db, "u2", mine.id)).toBeUndefined();
    expect(renameConversation(db, "u2", mine.id, "x")).toEqual({ ok: false, error: "not_found" });
    expect(archiveConversation(db, "u2", mine.id, true)).toEqual({ ok: false, error: "not_found" });
    expect(listConversations(db, "u2")).toEqual([]);
    expect(listTurns(db, "u2", mine.id)).toEqual({ ok: false, error: "not_found" });
  });
});
