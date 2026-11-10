/**
 * `sandboxCause` names why no sandbox can be made: each cause the probe
 * (`sandboxAvailable`) can report, and the unknown case that keeps its text
 * (#10745).
 */
import { describe, expect, test } from "bun:test";
import { sandboxCause, skipReason } from "../src/crew/sandbox_cause.ts";

const NO_NS =
  "bwrap: No permissions to create a new namespace, likely because " +
  "the kernel does not allow non-privileged user namespaces.";

const wrapped = (line: string) => `user namespaces are refused here (${line})`;

describe("sandboxCause", () => {
  test("user namespaces refused, as this probe reports them", () => {
    const cause = sandboxCause(wrapped(NO_NS));
    expect(cause.kind).toBe("user-namespaces");
    expect(cause.words).toBe(`user namespaces refused (${NO_NS})`);
  });

  test("user namespaces refused with no bwrap line", () => {
    expect(sandboxCause("user namespaces are refused here")).toEqual({
      kind: "user-namespaces",
      words: "user namespaces refused",
    });
  });

  test("a uid map refused is a namespace refused", () => {
    const line = "bwrap: setting up uid map: Permission denied";
    expect(sandboxCause(wrapped(line)).kind).toBe("user-namespaces");
  });

  test("a mount denied, though the probe called it namespaces", () => {
    const line =
      "bwrap: Can't mount proc on /newroot/proc: Operation not permitted";
    expect(sandboxCause(wrapped(line))).toEqual({
      kind: "mount",
      words: `a mount denied (${line})`,
    });
    const slave = "bwrap: Failed to make / slave: Operation not permitted";
    expect(sandboxCause(wrapped(slave)).kind).toBe("mount");
  });

  test("a missing binary, by name", () => {
    expect(sandboxCause("bwrap is not installed")).toEqual({
      kind: "missing-binary",
      binary: "bwrap",
      words: "missing binary: bwrap",
    });
    expect(sandboxCause("socat is not installed").words).toBe(
      "missing binary: socat",
    );
    expect(sandboxCause('Executable not found in $PATH: "bwrap"').words).toBe(
      "missing binary: bwrap",
    );
    expect(sandboxCause("missing binary: srt").words).toBe(
      "missing binary: srt",
    );
  });

  test("an unknown failure keeps the probe's own text", () => {
    expect(sandboxCause("no sandbox on win32")).toEqual({
      kind: "unknown",
      words: "no sandbox on win32",
    });
    const odd = wrapped("bwrap: execvp /bin/true: Exec format error");
    expect(sandboxCause(odd)).toEqual({ kind: "unknown", words: odd });
  });

  test("the skip reason opens with the cause, never the old catch-all", () => {
    const reason = skipReason(sandboxCause(wrapped(NO_NS)));
    expect(
      reason.startsWith("no sandbox can be made here: user namespaces refused"),
    ).toBe(true);
    expect(reason).not.toContain("nested");
    expect(skipReason(sandboxCause("bwrap is not installed"))).toBe(
      "no sandbox can be made here: missing binary: bwrap",
    );
  });
});
