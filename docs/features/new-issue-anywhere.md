# A new issue from any page

Pressing `c` (or Shift C) outside a text field opens a new issue from the page
you are on. The same door is a "New issue" link in the user menu (and the
guest menu), so touch, mouse and no-script readers have it too.

- Page: `/new/issue?from=/path`. Signed out, it is the sign-in path, never a
  form. From a page inside a repository you can read, it lands on that
  repository's new-issue form; anywhere else it is a picker over the
  repositories you may write. The form keeps `from` in a hidden field and the
  stored body ends with ``Opened from `/path` ``.
- Keys: a page with its own write box keeps `c` for it; Shift C is the door
  there. The help overlay (`?`) names `c / Shift C` or `Shift C` accordingly.
- Terminal: the palette's "New issue" row asks which repository (the ones you
  may write), then opens its new-issue form.
- Read-only origin browse pages show no link: there is nowhere to write.

`from` is a path on this forge only, limited to letters, digits and `/ . _ ~ % -`;
anything else is dropped at the boundary, since it ends up in a markdown body.
Tests: `test/new-issue-anywhere.test.ts`, `test/tui-new-issue.test.ts`.
