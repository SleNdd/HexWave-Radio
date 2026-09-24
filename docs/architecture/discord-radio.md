# Discord radio architecture

## Runtime shape

```text
Discord commands -> RadioDirector -> SQLite running order
                         |                 |
                    providers        preparation workers
                  Spotify / YTM           LLM -> TTS
                         \                 /
                          cached playable audio
                                   |
                         shared Discord AudioPlayer
                                   |
                         1..3 VoiceConnections
```

The compact app intentionally does not depend on private `apps/api` modules, Postgres,
Redis, pg-boss, Liquidsoap, Icecast, or the web console. It retains DeadAir's central
ideas: a sole running-order writer, explicit item states, preparation before handoff, and
the distinction between handed audio and confirmed playback.

## Boundaries

- `MusicProvider`: search, resolve, and fetch typed provider track IDs.
- `ScriptWriter`: produce a short validated host script. Tooken Club is the only
  AI gateway: HTTPS `https://tooken.club/v1`, `TOOKEN_API_KEY` and Chat Completions
  JSON parsing. The fixed organizer uses `gpt-6-luna`; six host models are
  selected only from the built-in roster. Tooken requests are not covered by
  OpenAI's complimentary-token programme. No hosted web or container
  tools. Only moderated, bounded listener text is sent, with no secrets or
  private data.
- `SpeechEngine`: turn bounded text into an audio artifact. Wine/IVONA and Linux TTS are
  interchangeable adapters. The presenter refuses implausibly short audio bodies
  before caching them; FFmpeg validates and normalizes actual runtime speech.
- `OutputFanout`: connect guilds and play one shared resource without exposing Discord
  objects to the director.
- `RadioStore`: transactional queue, request, message, segment, guild, and event state.

## Live-show revision (implementation target)

The showrunner keeps a versioned theme, ordered song-search intentions, and an
advisory decision about consecutive requests in SQLite.
Only confirmed `played` rows feed its bounded recent-spin context. A deterministic
local plan may supply context when no current plan exists, but it never selects
music. Fixed organizer Luna creates every editorial search through Tooken Club;
without a valid model-authored plan the station reports degraded, rather than
inserting random or fixed-genre music. New model proposals request eight to ten
explicit `artist — title` searches; catalog results must match both metadata
fields, allowing harmless apostrophe/comma spelling differences. The director
stages playable media and atomically updates the future run when at least two
new songs are ready, or one verified song when there is no ready successor. The plan
revision and listener-signal version still match. Already prepared songs from
the preceding AI plan remain playable during the handoff; only queued or
preparing old candidates are retired. Provider search also rechecks
the revision before committing a candidate. Neither
planning nor narration is awaited at a music boundary. Request runs follow the
saved advisory decision when an editorial track is ready; an available request
still plays when no editorial track is ready.

Per-input host decisions are now stored separately from admission. A background
Tooken call selects, defers for 1–15 minutes, or declines a listener request or
letter. The director commits a result only while the input is pending and valid;
model failure falls back to a persisted select. Admin input auto-selects. Deferred
and declined outcomes create durable notification tasks in the same transaction;
Discord DM delivery retries with a lease and is backed by private `/radio mine`.
An identical requested track is a shared spin: selecting it resolves all attached
pending requests atomically, including earlier deferrals, and records overrides.
If no editorial track is ready, an undecided ready request can be selected to
avoid silence. Future slices can add candidate song IDs, link ideas and active
theme revision on new input. The director
remains the sole writer of the running order; the model never writes SQLite state
directly or supplies a playback URL.

Keep two horizons separate:

1. A hard playout horizon targeting eight editorial pipeline items (including the
   current song, if editorial), with up to six preparations per pass. The status
   queue count includes not-yet-ready items, so monitor ready depth separately.
   Prepared songs originate only from AI plans; this is lead time, not a
   separate autonomous reserve. A prior ready run can bridge a Tooken outage,
   but no unrelated rotation is introduced.
   Two normal preparation workers can start a ready successor while a slow
   download continues. Up to two additional bounded workers may prepare newly
   admitted requests or the first catalog matches during a slow horizon search.
   All claims still pass through the director mailbox.
   A model-authored block is reconsidered as editorial depth falls below five,
   with a critical retry at two, so exact one-use song queries do not exhaust
   silently before the thematic refresh.
2. A soft show horizon of themes, links and listener-response ideas. Its work is
   cancellable and never awaited at an audible boundary.

Store factual events separately from rolling summaries and tentative plans. Only
confirmed playout may be described as already aired. Listener text is untrusted data,
not instructions to the showrunner. Every accepted/declined/deferred input needs a
durable outcome and an idempotent Discord interaction path. Owner bypass is checked
at the admission boundary, while music validation is identical for all users.
Every AI request includes the current date and time in Moscow (`Europe/Moscow`).
The show planner receives bounded three-day spins, themes, listener signals,
up to 24 recently aired host lines and three older lines from each of the
preceding two 24-hour windows. Speech preparation receives that durable
memory, the theme and recent spins. Unplayed drafts
must not become "what I said earlier" after a restart. Repetition is guided by
context, not rejected by a hard duplicate filter.

For each guild, track the last human presence in the connected voice channel.
Three uninterrupted empty minutes disconnect only that guild output. Joining and
leaving one output does not pause, duplicate, or restart the shared running order.

`track_quarantine` is separate from `play_items.state='failed'`: a terminal media
failure suppresses reselection of that provider track for 15 minutes, while an
owner-rejected request does not mark the recording itself unplayable. Transient
download errors and preparation timeouts keep an editorial or requested item
queued for durable retries after 15 and 45 seconds, up to three claims; only then
is it failed and a request owner notified. Unicode-normalized artist/song keys
block active and recent cross-catalog duplicates despite differing provider IDs.

Provider, model, speech, and media work runs outside the serialized director mailbox.
Media state transitions use compare-and-set updates, and prepared host audio is keyed to
the exact upcoming item, so stale work is not attached to another track. At startup,
`preparing` work returns to `queued`; `playing` work becomes `interrupted` and is safely
rescheduled from the beginning.

## Scaling seam

For one to three guilds, one `AudioPlayer` is subscribed to every connection. Future
10-100 guild operation replaces only `OutputFanout` with sharded Opus relays. The director,
provider IDs, request fairness, and persistent queue remain single-owner contracts.

## Security and licensing

Listener slash commands are guild-accessible by default; roles do not grant
privilege. The configured root account and admins explicitly appointed by that
root may use operator commands. Logs redact
tokens, cookies, authorization headers, signed media
URLs, and message content where it is not operationally necessary.

DeadAir is MIT. The Spotify bridge imports GPL-3.0 go-librespot; yt-dlp distribution mode,
FFmpeg build licence, IVONA licence, and music performance rights must be reviewed before
publishing or monetising an image. IVONA binaries and voice data are user-supplied volume
content and are never redistributed.
