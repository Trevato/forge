# A `Makefile` opens as its targets

A file named `Makefile`, `GNUmakefile` or `*.mk` opens as what it declares instead of raw text. Source is one tap away (`?view=source`).

- **Variables** come first, in one table: name, assignment operator (`=`, `:=`, `?=`, `+=`, `!=`), value.
- **Targets** follow, one row each: the target name, its prerequisites, its recipe (mono, one line per command). Order-only prerequisites (after `|`) sit under the prerequisites. A `::` rule and a `target: ; cmd` inline recipe read the same way.
- **Phony:** a target named in `.PHONY` carries a `phony` badge, wherever the declaration sits in the file. The `.PHONY` line itself is **not** repeated as a row (the badges already say it); a name listed there with no rule of its own shows nowhere.
- **Comments** stay in place as muted notes. A trailing backslash joins the next line.
- **Not understood** (`include`, `ifeq`/`endif`, a `define` block, a target-specific variable, a recipe with no target) stays as source text where it was; nothing else is dropped except blank lines.
- **Cap:** at most 500 items, then `N more not shown`. Files over 1 MB keep Source.
- **At 360 px** each table sits in a `table-scroll` region (the existing wrapper, focusable): the table scrolls sideways inside it and the page never does. Recipe cells wrap (`.table td pre`), so most recipes need no scrolling. I chose scroll over stacking because it keeps the three columns aligned for comparing targets, and adds no CSS.
- Every value is escaped and the page is drawn on the server. No script, no new CSS.

Code: `src/web/render/makefile.ts`, `src/web/render/kinds.ts`. Tests: `test/render-makefile.test.ts`.
