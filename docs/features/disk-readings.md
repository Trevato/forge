# Disk readings per machine (#10465)

The forge keeps `smartctl --json` readings of NVMe disks per machine and
device, and shows the bytes written in the last 30 days and the date the
vendor's rated TBW is reached at that rate. The rating comes from
`src/machines/disk_catalog.ts` (vendor figures, not measured); the date is a
projection, never an alert. A model not in the catalog gets a rate and no date;
a drive behind a RAID controller is recorded as such and not assessed.

Who: the owner, a forge admin who is a person. A member, an agent account
(admin or not) and a stranger get 404 on both doors, and nothing is stored.

## File a reading

```
smartctl --json -a /dev/nvme0 | jq -n --slurpfile s /dev/stdin \
  '{smartctl: $s[0], cpu: "AMD EPYC 7302", memoryBytes: 64000000000}' |
  curl -X PUT -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
    --data @- "$FORGE_URL/api/v1/admin/machines/rack1/disks/nvme0"
```

`cpu` and `memoryBytes` are optional and update the machine's inventory. A
reading that does not parse, a `cpu` with a control character, or a new
machine past 256 (a new device past 64 on one machine) answers 422 with the
reason and stores nothing. Each write prunes that device's readings older than
60 days, always keeping its newest two.
The token needs `admin` scope.

## Read

- `GET /api/v1/admin/machines/rack1/disks` (any scope of the owner's token):
  per device the latest reading, `bytesWrittenInWindow` over `spanDays` (≤ 30:
  from the oldest reading inside the 30 days before the latest, so a figure for
  30 days only once readings go back that far),
  `ratedReachedAt` and the assessment. A counter that went backwards gives no
  rate and no date.
- The terminal: `:` → "Disks", pick a machine.

Rate: latest reading against the oldest one inside the 30 days before it,
bytes per day = Δbytes ÷ Δdays; date = latest + (rated TBW − written) ÷ rate.
