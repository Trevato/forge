/**
 * The environment a test's `git` *client* runs in.
 *
 * Server-side git already refuses to inherit the host (`src/git/env.ts`:
 * "Nothing from the host leaks in"). A test drives a real git binary against
 * a forge it booted a second ago, so it needs the same discipline, and for a
 * sharper reason: git reads configuration from the environment as well as
 * from files. `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
 * is configuration no `GIT_CONFIG_GLOBAL=/dev/null` can switch off.
 *
 * On a crew machine that pair is set: the agent's shell carries
 * `http.extraHeader=Authorization: Basic <the agent's forge token>` so its
 * own pushes authenticate. A test that spreads `process.env` into its git
 * child sends that header to *its* forge, where the credential means
 * nothing — and an explicit `Authorization` header wins over the
 * `user:token` in the clone URL, so the push comes back `401 auth required`
 * and the test fails for reasons that have nothing to do with the code.
 *
 * So: build the child environment, never inherit it.
 */

/** Author/committer identity every test commit is made with. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@f.dev",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@f.dev",
} as const;

/**
 * A deterministic environment for a git client under test: `PATH` and
 * nothing else from the host, no global or system config, no prompt, and a
 * fixed identity. `extra` is the test's own additions — a clone URL's
 * askpass, `GIT_SSH_COMMAND`, a different author — and wins.
 */
export function gitClientEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...IDENTITY,
    ...extra,
  };
}
