/**
 * Config files for a preview's sample repository (#7337): a YAML and a TOML
 * file with comments, an anchor and merge key, a date and an array of
 * tables, so the config form (docs/features/config-form.md) can be tried
 * on any preview without bringing a file of one's own.
 */

export const PREVIEW_CONFIG_FILES: readonly { readonly path: string; readonly content: string }[] = [
  {
    path: "service.yml",
    content: `# A service's settings, to try the config form on: press Edit as form.
name: forge-demo # shown on the home page
defaults: &defaults
  retries: 3
  verbose: false
web:
  <<: *defaults
  port: 8080
  host: "0.0.0.0"
tags:
  - alpha
  - beta # second
`,
  },
  {
    path: "service.toml",
    content: `# A service's settings, to try the config form on: press Edit as form.
name = "forge-demo" # shown on the home page

[web]
port = 8080
host = "0.0.0.0"
started = 2026-11-02T09:30:00Z

[[servers]]
name = "one"
weight = 1

[[servers]]
name = "two" # the spare
weight = 0
`,
  },
];
