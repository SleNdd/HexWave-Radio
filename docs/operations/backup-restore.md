# Backup, restore, and rollback

## Backup

Stop or pause mutations, request a SQLite checkpoint, then copy:

- `var/data/discord-radio.sqlite` and any `-wal`/`-shm` files as one consistent snapshot;
- deployment configuration with secrets stored separately;
- Spotify/YTM/IVONA credential volumes using owner-only permissions;
- the immutable image/tag and Git revision being replaced.

Record SHA-256 checksums and verify the SQLite copy with `PRAGMA integrity_check`. Media
and TTS caches are rebuildable and are not part of the minimum recovery set.
On Docker Desktop for Windows, the radio database is in the persistent
`hexwave-radio_radio-data` named volume when using the Windows Compose
override, not in the host `var/data` bind directory. Stop the radio and copy
the database from that volume as a consistent unit (or use SQLite's online
backup API), then verify the copy. Never infer live state by opening a stale
host-side SQLite file while the container is running. Do not delete the named
volume during routine container/image updates.

## Restore

Restore into an empty data directory, verify checksums and SQLite integrity, start without
Discord output, inspect recovered queue/request counts, then enable connections. Work that
was `playing` is marked `interrupted` and restarted from its beginning.

## Rollback

Stop the new container, preserve its database and logs, restore the database snapshot that
matches the previous image, and start that immutable image. Never run an older binary on a
newer schema unless its documented compatibility explicitly allows it. Schema migrations
are additive during the MVP and each release keeps a pre-migration snapshot.
