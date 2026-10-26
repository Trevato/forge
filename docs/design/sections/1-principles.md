## 1. Principles

1. **Border-first, not shadow-first.** Elevation in a light theme is a hairline
   plus a 5%-opacity shadow. In a dark theme it is a lighter surface and a
   stronger border — dark themes have no shadows. If something looks flat in
   the dark, its surface is wrong, not its shadow.
2. **One accent per page.** `--accent` means _interaction_: focus rings, links
   on hover, the active choice. It is never a status color. If two things on a
   page are accent-colored and only one is the action, one of them is wrong.
3. **Hierarchy from weight and color, not size.** 14px does almost everything.
   A title is 20px because it is a title, not to be noticed.
4. **Everything works with JavaScript off.** Script may make a thing instant.
   It may never make a thing possible. A control that does nothing without JS
   is worse than no control.
5. **Anything that navigates is `<a>`; anything that mutates is a `<button>`
   in a `<form method=post>`.** There is no third case, and the CSP forbids
   inventing one.
6. **Never say what you don't know.** A missing thing and a thing you may not
   see are the same 404, with the same words.
