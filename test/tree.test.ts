/**
 * The tree carries no runtime state (#622): no tracked file is a private
 * key or a SQLite database unless `scripts/tree.ts` lists it as a fixture.
 */

import { describe, expect, test } from "bun:test";
import { auditRepository, auditTree, stateKind } from "../scripts/tree.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
// Spelled in pieces so this file does not trip the rule it tests.
const dashes = "-".repeat(5);
const KEY = `${dashes}BEGIN OPENSSH PRIVATE KEY${dashes}\nb3BlbnNzaC1rZXktdjEA\n${dashes}END OPENSSH PRIVATE KEY${dashes}\n`;
const DB = new Uint8Array([...bytes("SQLite format 3\0"), 16, 0, 1, 1]);

describe("the repository", () => {
  test("no tracked file is a private key or a database", () => {
    expect(auditRepository(new URL("..", import.meta.url).pathname)).toEqual(
      [],
    );
  });
});

describe("stateKind", () => {
  test("a PEM or OpenSSH private key is named, wherever it sits in the file", () => {
    expect(stateKind(bytes(KEY))).toBe("a private key");
    expect(stateKind(bytes(`const k = "${KEY.replace(/\n/g, "\\n")}";`))).toBe(
      "a private key",
    );
    expect(
      stateKind(bytes(`${dashes}BEGIN EC PRIVATE KEY${dashes}\nMHcC\n`)),
    ).toBe("a private key");
  });

  test("a SQLite database is named by its header", () => {
    expect(stateKind(DB)).toBe("a SQLite database");
  });

  test("a public key, source that mentions the header, and short files pass", () => {
    expect(stateKind(bytes("ssh-ed25519 AAAAC3Nza forge\n"))).toBeNull();
    expect(stateKind(bytes(`${dashes}BEGIN PUBLIC KEY${dashes}\n`))).toBeNull();
    expect(stateKind(bytes('if (head === "SQLite format 3") ok();'))).toBeNull();
    expect(stateKind(bytes("SQLite"))).toBeNull();
    expect(stateKind(new Uint8Array())).toBeNull();
  });
});

describe("auditTree", () => {
  const files: Record<string, Uint8Array> = {
    "ssh/host_ed25519": bytes(KEY),
    "ssh/host_ed25519.pub": bytes("ssh-ed25519 AAAA forge\n"),
    "forge.db": DB,
    "src/a.ts": bytes("export const a = 1;\n"),
    "test/fixtures/key.pem": bytes(KEY),
  };
  const read = (file: string) => files[file] ?? new Uint8Array();

  test("each key and database is named in one line, with where it belongs", () => {
    const problems = auditTree(Object.keys(files), read, [
      { file: "test/fixtures/key.pem" },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toStartWith("ssh/host_ed25519 is a private key;");
    expect(problems[1]).toStartWith("forge.db is a SQLite database;");
  });

  test("a fixture is let through only when listed", () => {
    expect(auditTree(["test/fixtures/key.pem"], read, [])).toHaveLength(1);
    expect(
      auditTree(["test/fixtures/key.pem"], read, [
        { file: "test/fixtures/key.pem" },
      ]),
    ).toEqual([]);
  });
});
