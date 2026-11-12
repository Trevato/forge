/** A GraphQL schema as its types: type, enum, input, arguments, roots first, plain rows, escaping, caps, the registry. */
import { describe, expect, test } from "bun:test";
import { BLOCK_CAP, graphql, parseGraphql } from "../src/web/render/graphql.ts";
import { fileKind, kindByName, RENDER_CAP } from "../src/web/render/kinds.ts";
import { RENDERERS, rendererFor } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => graphql({ path: "schema.graphql", size: text.length, body: enc(text), media: "/m", download: "/d" });
const out = (r: ReturnType<typeof draw>): string => String(r.content);

const SCHEMA = `# the schema
"""A user."""
type User implements Node & Entity @key(fields: "id") {
  id: ID!
  "their name"
  name(format: String = "full", upper: Boolean): String
  friends(first: Int! = 10, after: String): [User!]!
  old: String @deprecated(reason: "no")
}
enum Role { ADMIN
  GUEST @deprecated }
input NewUser {
  name: String!
  tags: [String!] = ["a", "b"]
}
union Result = User | Error
scalar Date
type Query {
  user(id: ID!): User
}
type Mutation { addUser(input: NewUser!): User }
`;

describe("graphql", () => {
  test("registered for .graphql and .gql", () => {
    expect(fileKind("a/schema.graphql", new Uint8Array())).toBe("graphql");
    expect(kindByName("x.gql")).toBe("graphql");
    expect(RENDERERS.graphql).toBe(graphql);
    expect(RENDER_CAP.graphql).toBe(1_000_000);
  });

  test("a type, an enum, an input and a field with arguments", () => {
    const doc = parseGraphql(SCHEMA)!;
    expect(doc.blocks.map((b) => (b.kind === "other" ? "other" : b.name))).toEqual(["Query", "Mutation", "User", "Role", "NewUser", "other", "other"]);
    const user = doc.blocks.find((b) => b.kind === "type" && b.name === "User");
    if (user?.kind !== "type") throw new Error("type");
    expect(user.header).toContain("implements Node & Entity");
    expect(user.fields.map((f) => [f.name, f.args, f.type])).toEqual([
      ["id", "", "ID!"],
      ["name", 'format: String = "full", upper: Boolean', "String"],
      ["friends", "first: Int! = 10, after: String", "[User!]!"],
      ["old", "", "String"],
    ]);
    expect(user.fields[3]!.note).toContain("@deprecated");
    const en = doc.blocks.find((b) => b.kind === "enum");
    if (en?.kind !== "enum") throw new Error("enum");
    expect(en.fields.map((f) => f.name)).toEqual(["ADMIN", "GUEST"]);
    const inp = doc.blocks.find((b) => b.kind === "input");
    if (inp?.kind !== "input") throw new Error("input");
    expect(inp.fields.map((f) => [f.name, f.type])).toEqual([["name", "String!"], ["tags", '[String!] = ["a", "b"]']]);
    const others = doc.blocks.filter((b) => b.kind === "other").map((b) => (b.kind === "other" ? b.text : ""));
    expect(others).toEqual(["union Result = User | Error", "scalar Date"]);
    const r = draw(SCHEMA);
    expect(r.summary).toContain("7 definitions");
    expect(out(r)).toContain("[User!]!");
  });

  test("an unreadable body is one plain row, not an error", () => {
    const doc = parseGraphql("type A { ??? }\ntype B { x: Int }")!;
    expect(doc.blocks.map((b) => b.kind)).toEqual(["other", "type"]);
  });

  test("a file with no definition falls back", () => {
    expect(draw("just words").fallback).toBeDefined();
    expect(draw("").fallback).toBeDefined();
  });

  test("every name is escaped", () => {
    const r = draw(`type Query { f(a: String = "<img src=x onerror=1>"): Int @x(v: "<script>") }\nscalar S_<b>\nunion <i> = A`);
    const h = out(r);
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script>");
    expect(h).not.toContain("<b>");
    expect(h).not.toContain("<i>");
    expect(h).toContain("&lt;");
  });

  test("blocks are capped", () => {
    const text = Array.from({ length: BLOCK_CAP + 5 }, (_, n) => `type T${n} { a: Int }`).join("\n");
    const doc = parseGraphql(text)!;
    expect(doc.blocks.length).toBe(BLOCK_CAP);
    expect(doc.total).toBe(BLOCK_CAP + 5);
    expect(out(draw(text))).toContain("more not shown");
  });

  test("an extend type renders as a block marked extend", () => {
    const doc = parseGraphql("extend type Query @x { more: Int }\ntype A { a: Int }")!;
    const q = doc.blocks[0]!;
    if (q.kind !== "type") throw new Error("type");
    expect([q.extend, q.name, q.header, q.fields.map((f) => f.name)]).toEqual([true, "Query", "@x", ["more"]]);
    expect(out(draw("extend type Query { more: Int }"))).toContain("extend type");
  });

  test("a type-header directive is kept in the header line", () => {
    expect(out(draw('type A @key(fields: "id") { a: Int }'))).toContain("@key(fields:");
  });

  test("a file over the cap opens as text", () => {
    const blob = (size: number) => ({ kind: "text", size, body: enc("type A { a: Int }") }) as never;
    expect(rendererFor("a.graphql", blob(RENDER_CAP.graphql))?.render).toBe(graphql);
    expect(rendererFor("a.graphql", blob(RENDER_CAP.graphql + 1))).toBeUndefined();
  });

  test("the Directives column is drawn only when a field has one", () => {
    expect(out(draw("type A { a: Int }"))).not.toContain("Directives");
    expect(out(draw("type A { a: Int @deprecated }"))).toContain("Directives");
  });
});
