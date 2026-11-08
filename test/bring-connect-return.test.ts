import { describe, expect, test } from "bun:test";
import { linkOf, thenOf, thenQuery, thenTarget } from "../src/web/pages/origins.ts";

describe("a connect begun on /bring comes back to it with the link kept (#9388)", () => {
  const link = "https://forge-apps.benjivers.com/ben/notes";
  test("the query carries the link and the target restores it", () => {
    expect(thenOf("bring")).toBe("/bring");
    expect(thenQuery("/bring", link)).toBe(`then=bring&link=${encodeURIComponent(link)}`);
    expect(thenTarget("/bring", link)).toBe(`/bring?link=${encodeURIComponent(link)}&connected=1`);
    expect(thenTarget("/migrate")).toBe("/migrate?connected=1");
    expect(thenTarget(undefined)).toBe("/settings/origins?connected=1");
  });
  test("only an http(s) link of reasonable size comes back; nothing else is followed", () => {
    expect(linkOf(link)).toBe(link);
    expect(linkOf("javascript:alert(1)")).toBeUndefined();
    expect(linkOf("//evil.example/x")).toBeUndefined();
    expect(linkOf(`${link}\n`)).toBeUndefined();
    expect(linkOf(link.padEnd(400, "a"))).toBeUndefined();
    expect(linkOf(null)).toBeUndefined();
    // The return is always a path on this forge, whatever the link says.
    expect(thenTarget("/bring", "https://evil.example/")).toStartWith("/bring?");
  });
});
