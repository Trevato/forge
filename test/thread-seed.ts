/** The seed for the thread render budget (#3324): 200 comments, each with markdown, links and a mention. */
export function seedBody(i: number): string {
  const part = (n: number): string => [
    `## Comment ${n} on the plan`,
    "",
    `Thanks @olive — I read **the proposal** and *mostly* agree, see [the spec](https://example.com/spec/${n}) and [local notes](docs/notes-${n}.md).`,
    `Inline \`code${n}\` stays literal, and <b>tags</b> & "quotes" stay escaped.`,
    "",
    "- first point with a [link](/trevato/forge/issues/" + n + ")",
    "- second point, cc @pablo",
    "1. step **one**",
    "2. step two",
    "",
    "> quoted from @olive: *ship it*",
    "",
    "| a | b |",
    "|---|--:|",
    `| ${n} | \`x\` |`,
    "",
    "```ts",
    `export function f${n}(n: number): string { return \`n=\${n}\`; } // @olive`,
    "```",
  ].join("\n");
  // Five of them: a comment on a long thread is not a one-liner.
  return [part(i), part(i + 1000), part(i + 2000), part(i + 3000), part(i + 4000)].join("\n\n");
}
