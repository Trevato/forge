# Milestones

## Fits a 390 px phone (#9326)

`/:owner/:name/milestones` and `/:owner/:name/milestones/:number` are stacked
blocks and one-line rows; nothing in them fixes a width. The one addition is
the attribute `data-milestone` (not a class) on the page's wrapper, which wraps
long words anywhere (`overflow-wrap: anywhere`) so the longest unbroken title
or reason in the `h1`, the estimate or a trim note cannot push the page
sideways. Limb rows already wrap through `.setting-list`; issue rows ellipsize
on one line, so no row grows taller than a screen. Like `data-bet-card`, it is
on both the list and an opened milestone.

Issue titles cap at 256 characters, so the test seeds a 250-character
unbroken word as the longest title that can exist; the estimate and trim notes
are built from titles and counts, so no field takes 300. It is an attribute
because the area adds no component class. Every preview of the forge takes
`/preview-admin/sample/milestones` at desk and phone (`PREVIEW_OWNER_LOOKS`).

## Rows under headings, not boxes (#9693)

The milestone list, and every section of an opened milestone (limbs, building
now, blocked, cost, merged, issues, re-planned), is a heading over plain rows:
a `ul.list.setting-list` with no `.card` around it, and a folded tail is a
`details` under the rows, not a card foot. How far it is stands as a plain
`#ms-progress` stack. No new component class; `limb.ts` and the re-plan page
share the same rows.

## Front door lines

The few biggest open milestones on the home and an app's page are plain `row`s in a `ul.list.setting-list`, the same rows as the milestone list; the "Last moved in wave" line on a milestone is one such row. They paint nothing when nothing moved. No new component class.
