# The data explorer's sentence box

The box on `/boards/data` (and `/` in the terminal's Data screen) takes a sentence such as "memory over the last 3 days" and fills the explorer's form from it.

- **Rules first.** `parseSentence` reads topics (cpu, memory, spend, deploys, slowest pages) and windows. A hit costs nothing and never reaches the model; the web redirects to the chart's own link.
- **The model on a miss.** A sentence the rules cannot read ("how pricey were the robots") goes to the model as one short question with no tools. It runs on the asker's own granted account, at most $0.05 a question. Each question is written to `one_shot_spend` with its cap before it starts and its real cost when it ends, and that table counts toward the account's daily ceiling like every run and conversation turn, so a spent ceiling stops the model too.
- **Checked before it is used.** The model may answer only with the explorer's own fields. Every source, column, aggregate, chart, operator and time is checked against `SOURCES` and `readParams`; anything else is refused and the query runs under the same gate as any link.
- **Six asks a minute** per person. Past that the box says the model is asked only a few times a minute.
- **The note.** When the model filled the form, the chart's foot (and the terminal's result) says "The model filled this form from your sentence. Check it before you trust it." A rules hit shows no note. The web draws a model fill in place rather than redirecting, so the note cannot be put on a link by hand, and a reload asks again.
- **Only the page's own form.** The box posts to `/boards/data`, and only that POST may ask the model; like every form it is refused when another site sent it (`readForm`, `crossOrigin`). A `?ask=` link is read by the rules only, so no link, clicked from a mail, a chat or another site, can spend an admin's budget.

## What it needs

The crew on (the forge started with a model configured) and a signed-in site admin who is a person with an account granted to them. Without either, a sentence the rules cannot read says "I could not read that" and nothing is spent.

## Try it

Sign in as a site admin, open `/boards/data`, type "how pricey were the robots" into the box and press Show; read the note under the chart. The same words as `/boards/data?ask=how+pricey+were+the+robots` say "I could not read that" and spend nothing.
