/**
 * One page of rendered markdown that is wide by nature: a 3-column, a
 * 7-column, a numeric, a long-text-cell and a one-column table, a wide code
 * block and a wide image. Built from the forge's own stylesheet and renderer,
 * so a phone look and a width measurement see what a person sees.
 */
import { renderMarkdown } from "../../src/web/markdown.ts";
import { css } from "../../src/web/style.ts";

export const MD_TABLE_SOURCE = `# Release notes

A short paragraph before the first table, so the page has some text around it.

| Name | Kind | Owner |
| --- | --- | --- |
| forge | app | trevato |
| crew | service | omato |
| paper | job | trevato |

## Seven columns

| Area | Issue | Pull | State | Owner | Opened | Closed |
| --- | --- | --- | --- | --- | --- | --- |
| tables | #13001 | #13010 | merged | scout | 2026-11-12 | 2026-11-13 |
| code | #13002 | #13011 | open | ada | 2026-11-12 | none |
| images | #13003 | #13012 | held | bo | 2026-11-13 | none |

## Numbers

| Run | Tokens | Cost | Seconds |
| --- | ---: | ---: | ---: |
| plan | 12,480 | 0.42 | 31.5 |
| build | 1,204,880 | 18.07 | 912.0 |
| review | 88,002 | 2.9 | 77.25 |

## Long text

| Step | What happened |
| --- | --- |
| one | The runner started the check, waited for the registry, and then retried the push three times because the first two attempts died at the edge with a 499 before any layer landed. |
| two | Fine. |

## One column

| Only |
| --- |
| a |
| b |

## Code

\`\`\`ts
export const wide = "this line is intentionally far longer than a phone is wide so the block has to scroll inside its own box and never the page";
\`\`\`

The end.
`;

/** A whole page: the forge's stylesheet, a theme, and the markdown inside a card the way a README is. */
export function mdTablePage(theme: "light" | "dark", source = MD_TABLE_SOURCE): string {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head><body><main class="page"><div class="card prose">${String(renderMarkdown(source))}</div></main></body></html>`;
}
