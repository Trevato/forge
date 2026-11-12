# The data explorer starts from a question

`/boards/data` (admins) opens on a plain-named source with a sensible chart.

- **Names and defaults** (`src/boards/guide.ts`): each source has a plain name ("Machine readings") and says what a row is. A source with no `aggregate` in the URL opens on its default: an average of its main value per day for samples, a count per day for events. `count` says what it counts, and for samples that it counts readings, not time.
- **Ready questions**: "CPU over the last week", "Slowest pages today", "Who used the forge's time", "Apps shipped per day" and more, one press each. Their links carry every choice in the URL, so they can be shared or pinned.
- **Pickers** show each column's meaning and unit (from `docs` in `sources.ts`, else a shared note; every number column names its unit).
- **One line** under every chart, in the result card's foot: "Average CPU cores per day, by machine." An empty box is no sentence: Show with nothing typed just draws the page.
- **Ask in a sentence**: type a topic and a window into "Ask in a sentence" at the top of the page (or press `/` in the terminal's Data explorer, in the palette after Boards) and press Show. Topics: cpu, memory, temperature, load, slowest pages, visitors, spend, tokens, shipped, deploys, pulls, reviews, sign-ins, runs, requests. Windows: "last 3 days", "last week", "today", "yesterday" (that calendar day, UTC); "per hour", "per day" and, for the machine, "by machine". "memory over the last 3 days" redirects (303) to the filled form, whose URL keeps every choice.
- **A phrase the parser cannot read gets an error message and nothing more**: "I could not read that", with the topics to try. No model is asked and nothing is guessed.
- **Both doors**: the terminal screen (`src/tui/screens/ask_data.ts`) lists the same questions and plain source names, shows the one-line description and the rows, and takes the same sentences. Both are for a site admin who is a person; others are not offered it and read nothing.

Not done: the crew/model fallback for phrasings the parser misses (#9569), and picking filter *values* from a list (they stay typed).
