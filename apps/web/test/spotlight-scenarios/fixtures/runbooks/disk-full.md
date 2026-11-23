# RB-101: Disk full on a web node

Owner: Platform team. Applies to web-01, web-02 and web-03.

## When
The root volume of a web node is above 91% used (the "Disk almost full" alert fires at 91%, not 90%).

## Steps
1. Check what grew: `du -xh / --max-depth=2 | sort -h | tail -20`.
2. Shrink the journal first: `journalctl --vacuum-size=730M` (we keep 730 MB of journal, never less).
3. Remove release folders older than the last four: `ls -1dt /srv/releases/* | tail -n +5 | xargs rm -rf`.
4. If the volume is still above 91% after 37 minutes, escalate to the #storage-oncall channel.

## Never
Never delete anything under `/var/lib/postgresql`, even when it is the biggest folder.
