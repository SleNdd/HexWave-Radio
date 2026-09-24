# HexWave Radio development policy

## Product boundary

`apps/discord-radio` is a lightweight Discord-first station. Keep it independent from
the private modules in `apps/api`; DeadAir is a reference implementation, not a runtime
dependency. The director is the only writer of the running order.

## Ownership

- Core domain and persistence: `apps/discord-radio/src/core` and `src/storage`.
- External boundaries: `apps/discord-radio/src/adapters`.
- Discord commands and voice: `apps/discord-radio/src/discord`.
- Runtime data: `var/`; never commit credentials, databases, audio, or logs.
- Reviewed documentation: `docs/product`, `docs/architecture`, `docs/operations`.

Do not combine provider HTTP details with queue policy. Slow provider, LLM, TTS, and
media work runs outside the director mailbox and must revalidate state before commit.
An unavailable narration is skipped; it must never stop music.

## Upstream watch

During active development, check `robert-dean/deadair` once on the first project task
in each five-hour window and before a release milestone. Check the latest release tag
and the main-branch tip; comparing these refs is enough when neither has moved. If either
advanced, skim the changelog and the
relevant commit summaries once, then inspect only changes affecting our providers,
playout, reliability, security, or licensing. Integrate important applicable fixes into
the compact Discord runtime with focused checks; do not merge the full upstream app or
bring back its heavy services. Record the checked upstream commit and a brief adopt/defer
decision in the current checkpoint. Avoid repeating the same review until upstream moves.

## Required checks

Run package-scoped checks while iterating. Before accepting a source snapshot run:

```bash
pnpm --filter @hexwave/radio test
pnpm --filter @hexwave/radio typecheck
pnpm --filter @hexwave/radio build
```

Real Discord, Spotify, YouTube Music, Tooken Club, and TTS checks use an isolated test guild
and operator-owned accounts. Never print or commit their secrets.
