# Releases

## The releases page at 390 px (#9350)

`/releases` lists the kept releases as rows in a `ul.list` (one `row` each: the short sha and its badges, then the
pull, when it landed and since when it has been healthy, then the Roll back button when there is one). On a
narrow screen a row's text column shrinks and its title and meta lines end in an ellipsis, so the row never pushes the
page wider. Free text on the page (an owner's hold and its reason, a keeper's reason) sits inside
`[data-releases]` (an attribute, not a class), which breaks long words anywhere. The hold's reason input is capped at
100% of its box. The keeper panel's own table keeps the existing `.table-scroll` box. No fixed width. No new class.
