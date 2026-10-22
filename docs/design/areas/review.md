# Review

- A pull's row on `/review` carries its look under it as `<li data-look>` in the row's children: a `.looks` strip of `.look[data-slot=thumb]` frames (production, then the pull's preview). It reuses the look component; no new class. The strip stays side by side under 640px (the stacking rule excludes `[data-look] .looks`), the item is inset like a row (8px 14px), and the preview thumb's link has a 44px hit area (a `::after` outset by 7px).
