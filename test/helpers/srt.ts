/**
 * Launching Claude Code's sandbox runtime (`srt`) from a test the way the
 * check host allows: the shapes `crew-sandbox-escape.test.ts` and
 * `crew-sandbox-real.test.ts` share (#10602, #10709).
 */
import { rgPath } from "@vscode/ripgrep";

/**
 * The environment `srt` is launched with, minus any proxy setting. `srt`
 * reads `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` of its own process as its
 * *parent proxy* and chains every allowed request through it. On the check
 * host that is the cell's egress proxy, which refuses `127.0.0.1:<port>`,
 * so the allowed forge host:port got "Unable to connect" (#10602). A crew
 * run's real sandbox is not launched behind one, so the test is not either.
 */
export function withoutParentProxy(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !/^(http|https|all|ftp|no)_proxy$/i.test(key)) kept[key] = value;
  return kept;
}

/**
 * Claude Code's sandbox settings as the runtime reads them. The gap from what
 * Claude Code receives: the runtime wants `deniedDomains`, `denyRead` and
 * `denyWrite` present (empty here), `allowWrite` is the work directory
 * alone, where Claude Code adds its own write grants, and `ripgrep` is the
 * pinned `@vscode/ripgrep` binary: the check host has no `rg` on its PATH.
 * Network and denyRead are the generated ones, untouched.
 */
export function runtimeSettings(
  sandbox: Record<string, any>,
  workDir: string,
): Record<string, unknown> {
  return {
    ripgrep: { command: rgPath },
    network: { deniedDomains: [], ...sandbox.network },
    filesystem: {
      denyRead: [],
      denyWrite: [],
      ...sandbox.filesystem,
      allowWrite: [workDir, ...(sandbox.filesystem?.allowWrite ?? [])],
    },
  };
}
