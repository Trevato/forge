/** A picture of a browser error page, or of a page off the app's host, is never kept (#7830). */
import { describe, expect, test } from "bun:test";
import { refusal } from "../src/looks/capture.ts";

const HOST = "hello.lab.test";

describe("refusal", () => {
  test("the app's own page is pictured", () => {
    expect(refusal(HOST, undefined, `http://${HOST}:80/`)).toBeUndefined();
  });

  test("a certificate error is refused, with the browser's word", () => {
    const why = refusal(HOST, "net::ERR_CERT_AUTHORITY_INVALID", "chrome-error://chromewebdata/");
    expect(why).toContain("ERR_CERT_AUTHORITY_INVALID");
  });

  test("a browser error page is refused even when navigation reported nothing", () => {
    expect(refusal(HOST, undefined, "chrome-error://chromewebdata/")).toContain("error page");
  });

  test("a redirect off the host is refused and names the host", () => {
    expect(refusal(HOST, undefined, "https://git.open-platform.sh/login")).toContain("git.open-platform.sh");
  });

  test("a page with no address is refused", () => {
    expect(refusal(HOST, undefined, "")).toBeDefined();
  });

  test("the browser's net:: code leads the message, capped at 100 characters", () => {
    const href = "chrome-error://chromewebdata/";
    expect(refusal(HOST, "net::ERR_X", href)).toStartWith("net::ERR_X: the browser showed an error page");
    const why = refusal(HOST, "net::" + "E".repeat(200), href) ?? "";
    expect(why).toStartWith("net::" + "E".repeat(95) + ": the browser showed");
  });
});
