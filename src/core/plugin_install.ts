/**
 * The one install command for each harness plugin, and the Claude Code
 * marketplace manifest. A leaf module (imports nothing from the forge), so the
 * card, llms.txt, the account page, the terminal and the routes all read the
 * same text without importing each other.
 *
 * Claude Code format (code.claude.com/docs/en/plugin-marketplaces): a
 * marketplace is `{name, owner, plugins[]}`; a plugin entry's `source` may be
 * `{source: "git-subdir", url, path}`; `commands` is a list of paths relative to
 * the plugin root. `claude plugin marketplace add` takes a URL to a
 * marketplace.json, and `claude plugin install <plugin>@<marketplace>` installs.
 */

const bare = (origin: string): string => origin.replace(/\/+$/, "");

/** The one-line OpenCode install: the forge's own origin, no trailing slash. */
export function opencodeInstall(origin: string): string {
  return `mkdir -p .opencode/plugin && curl -fsSo .opencode/plugin/forge.ts ${bare(origin)}/plugins/opencode/forge.ts`;
}

/** The one line for Claude Code: add this forge's marketplace, then install from it. */
export function claudeInstall(origin: string): string {
  return `claude plugin marketplace add ${bare(origin)}/plugins/claude-code/marketplace.json && claude plugin install forge@forge`;
}

/** Where a plugin repository lives: `owner/name` is on this forge's origin, a full URL is its own. */
function pluginBase(origin: string, repo: string): string {
  return repo.startsWith("https://") ? repo : `${bare(origin)}/${repo}`;
}

/** The clone URL of that repository. */
export function pluginSource(origin: string, repo: string): string {
  return `${pluginBase(origin, repo)}.git`;
}

/**
 * The marketplace manifest. A URL marketplace cannot carry files, so the plugin
 * is fetched as the subdirectory plugins/claude-code of the public source
 * repository; `commands` names each command file.
 */
export function claudeMarketplace(origin: string, repo: string, commands: readonly string[]) {
  return {
    name: "forge",
    owner: { name: "forge" },
    metadata: { description: `The forge at ${bare(origin)}: its MCP server and a /forge command.` },
    plugins: [
      {
        name: "forge",
        description: "Your forge inside Claude Code: its MCP server and a /forge command.",
        source: { source: "git-subdir", url: pluginSource(origin, repo), path: "plugins/claude-code" },
        commands: commands.map((c) => `./commands/${c}`),
      },
    ],
  };
}
