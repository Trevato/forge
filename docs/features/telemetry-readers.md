# Telemetry readers

Something polling `/api/v1/telemetry` too often shows up here. The owner's `/system` page has a **Telemetry readers** section, and the terminal's **System** dialog (palette) shows the same rows under the history lines. Both are for a forge admin who is a person; nobody else gets the section.

- **What a row says.** Route (`flow`, `system`, …), reader (the account or token name), reads in the window, and the mean interval between the seconds in which it read. Most reads first. A reader with a single read second has no interval (`—`).
- **The window.** The last 10 minutes, counted per process in one-second slots (at most 600 per reader and route); older reads drop out, and a restart empties it.
- **The 5 s rule.** A reader on `flow` whose mean interval is under 5 s is flagged ("faster than the flow copy changes" on the page, `TOO FAST` in the terminal): the flow view does not change that often.
- **The 200-name cap.** At most 200 route/reader pairs are tracked; a new pair beyond that is counted under reader `other`, so no read goes uncounted.
- **Not changed.** `/metrics` keeps `forge_telemetry_reads_total{route,reader}`; the window is the page's and terminal's alone. The terminal lists the top six rows and says how many more.
