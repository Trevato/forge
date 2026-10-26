## 2. Tokens

Palettes live in `src/design/themes.ts`; the stylesheet only ever reads
variables, so a theme is data. Six ship today. What each role _means_:

| token                            | role                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--bg`                           | the page. Nothing else uses it.                                                                                         |
| `--card`                         | any raised surface: card, menu, dialog, input, button.                                                                  |
| `--muted`                        | a recessed surface: row hover, table head, code block, pill.                                                            |
| `--fg`                           | body text, and the **active tab underline**.                                                                            |
| `--muted-fg`                     | all metadata. Never a hardcoded gray — muted is a desaturated hue of the surface, so it warms and cools with the theme. |
| `--faint`                        | decoration only: separators between crumbs, gutter numbers, icons inside rows. Never load-bearing text.                 |
| `--border`                       | every hairline.                                                                                                         |
| `--border-strong`                | a raised edge, and hover on a control.                                                                                  |
| `--primary` / `--primary-fg`     | the one filled button per page, and the live-activity pill.                                                             |
| `--accent` / `--accent-fg`       | interaction: focus ring, link hover, selection, the review-comment rail.                                                |
| `--success`                      | open issue, mergeable pull, additions.                                                                                  |
| `--danger`                       | closed, destructive, deletions.                                                                                         |
| `--merged`                       | a merged pull. Purple, and only that.                                                                                   |
| `--attn`                         | draft, pending, a highlighted line.                                                                                     |
| `--add-*` / `--del-*` / `--wd-*` | the diff. Tints stay ≤14% so syntax color survives on top.                                                              |
| `--tok-*`                        | syntax, in two layers: eleven colour classes every consumer knows, plus finer kinds the web paints over them (§6c).     |
| `--shadow-1` / `--shadow-2`      | a hint and an overlay. Near-transparent in dark palettes, so one rule serves every theme.                               |
| `--series-0…7` / `--qr-ground`   | the same in every theme (`FIXED_TOKENS`): chart series (Okabe–Ito, colour-vision safe) and a QR code's white ground.    |

**Status surfaces are tinted, never saturated**: `color-mix(in srgb, var(--x)
12%, transparent)` for the fill, the pure token for the text, a 34% mix for the
border.

**Contrast targets**: body ≥7:1 where it's cheap, `--muted-fg` ≥4.5:1 on
`--bg`, borders ≥1.5:1 against their surface, focus ring ≥3:1.
