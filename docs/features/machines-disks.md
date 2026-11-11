# Disks on the machines page (#10466)

Settings → Machines lists, under each declared machine's own row, its disks
from the readings the forge keeps (`docs/features/disk-readings.md`). One quiet
row per disk: device and model, then written of rated TBW with its percentage
and the temperature. Open
it for every figure beside its rating: percentage used (alert at the assessment's
threshold), spare against its threshold, media errors, minutes above warning and
critical, power-on hours, unsafe shutdowns, projected TBW date.

- An alert adds a "needs a look" badge and its reasons in words on a muted line
  under the row, readable without opening it; nothing is red when nothing is
  wrong.
- A disk behind a controller reads "behind a controller; SMART not visible".
- A model not in the catalog shows its numbers and "no spec sheet" for ratings.
- A machine with no reading says "No disk reading yet."

Who: readings belong to the host and are keyed by machine name alone, so the
section is shown to the owner (a forge admin who is a person) and to no other
writer; a name two repositories share never carries disks from one to the other.
The page itself is writers' only. This is narrower than the issue's "writers"
on purpose: a reading is keyed by host, not by repository.

The terminal: `:` → "Machines of a repository" → pick the repository; the owner
sees each machine's disk lines under the sessions. `:` → "Disks" lists every
machine with a reading.
