# Discord radio runbook

## Required configuration

Copy the example environment file beside the deployment and set Discord bot/application
credentials, exactly one root-owner user ID and provider endpoints. For the permanent Tooken Club
gateway set `OPENAI_BASE_URL=https://tooken.club/v1`, `OPENAI_MODEL=gpt-6-luna`
and a Tooken-issued `TOOKEN_API_KEY`. A direct OpenAI project key in
`OPENAI_API_KEY` is deliberately ignored for this URL and must never be forwarded
to Tooken. Without `TOOKEN_API_KEY`, no new editorial music is selected:
already prepared AI-plan tracks can finish, then the station reports degraded.
Narration may fall back to templates. The Tooken path uses OpenAI-compatible Chat Completions; verify
live JSON output and latency before relying on it. The root owner alone appoints persistent station administrators;
Discord roles do not grant station privileges. Other guild members may request
music, write to the studio and join/leave their voice output. Only the root owner
and appointed admins bypass listener cooldowns and quotas. The direct OpenAI
Responses path is disabled. Tooken is a separate paid
provider with its own balance and data handling; OpenAI's complimentary daily
tokens do not apply to Tooken requests.
Do not enable hosted container network or web-search tools for normal radio
operation. Set `RADIO_STATION_NAME` and
`RADIO_JINGLE_EVERY_MINUTES` to control the fixed station ident. Keep the file mode at `0600` on
Ubuntu and do not paste it into issue reports.

## Private live-audio URL

`RADIO_HTTP_STREAM_ENABLED=true` adds `GET /live.mp3` to the existing health
listener. Compose binds port 9380 to **host loopback only**, so
`http://127.0.0.1:9380/live.mp3` is usable on the server but is not a public
Internet URL. A player connecting in mid-song receives the current live moment;
it does not restart the track. One MP3 encoder serves up to 16 clients. The
HTTP output must never govern the station clock: disconnecting every browser
does not stop the Discord or internal programme. A direct Node run defaults
this setting to `false` and binds the listener to `127.0.0.1`. Compose sets
`RADIO_HEALTH_BIND_HOST=0.0.0.0` only inside its private network, while its
host port mapping stays on loopback. Do not change that mapping to `0.0.0.0`:
the endpoint has no built-in authentication. For remote private integrations,
put an authenticated HTTPS reverse proxy or private VPN in front of the
loopback endpoint. Public distribution needs a separate music-rights and
capacity review.

For an audio-transport soak on the server, run
`node scripts/monitor-live-stream.mjs 86400 var/log/live-stream-soak.jsonl`.
It records only timestamps, byte counts, stalls, reconnects and inter-packet
gaps over one day; it never saves audio or the URL. An interval over one second
is logged, and five seconds without MP3 bytes triggers a reconnect. Run it
alongside `scripts/soak-stats.ps1` and station event logs. Packet continuity
does not prove the music sounds correct or that MP3 frames decode cleanly;
listen to representative boundaries separately.

Start with Docker Compose and wait for the application healthcheck before using commands.
On Docker Desktop for Windows, add `-f deploy/discord-radio/docker-compose.windows.yml`
to every Compose command. This keeps SQLite and its WAL on one Linux named volume;
the ordinary bind mount to `var/data` is suitable for the Ubuntu VPS, but live
inspection of the Windows-mounted database may show stale state or fail while
the writer runs. Do not open/copy the live SQLite files from Windows to infer
current programme state. Stop the radio or use a SQLite online backup before
inspecting or migrating that database; preserve all pending requests and studio
messages. The named volume is persistent and must be included in backups.
This check proves only that the process and HTTP status endpoint respond; it does not prove
that Discord voice is connected or that listeners hear audio. Confirm `/radio status`,
`/radio health`, and a real voice playback in the test guild before unattended operation.
The owner joins the desired voice channel and runs `/radio join`; the bot stores that
guild/channel pairing in SQLite and reconnects after restart. Repeat in at most three
guilds. `/radio leave` disables the saved output for the current guild.
The bot disconnects an output after three continuous minutes without human listeners
and reconnects to the same saved channel when a human returns. A manual `/radio leave`
remains disabled until an owner explicitly joins again. An empty guild does not stop
the station in other guilds.
Provider readiness is independent: the radio reports a degraded provider while continuing
with any healthy source.
`RADIO_ROTATION_QUERIES` is retained only as context for a local show-plan
placeholder; it is never searched for music. All editorial playback candidates
must originate in a model-authored plan from the active host. This variable can be ignored in
normal operation.

## Routine checks

- `/radio status`: director mode, current track, and pending queue counts.
- `/radio health`: provider, TTS, and guild connection state, including pending guild-lookup
  recovery. It does not currently probe SQLite or cache directly.
- `/radio now`: current programme item.
- `/radio mine`: private receipt history for the caller on this server; use it
  when a Discord DM about a deferred or declined input cannot be delivered.
- Inspect `radio.track.started/completed/failed` and
  `radio.break.started/completed`, `radio.media.preparation_deferred` and
  `show.plan.applied/failed` in container JSON logs by item ID; these
  events omit scripts, user messages and media paths. Docker rotates logs at
  10 MiB × 3.
- Track both ready depth and total queued depth. The editorial pipeline targets
  eight AI-selected items, but `queued` in status includes unprepared songs. Repeated
  preparation failures are an incident even while other media prevents silence.

## Failure handling

- Discord disconnect: reconnect with bounded exponential backoff; other guilds continue.
- AI API error or optional call cap: use deterministic host copy and continue
  already prepared AI-selected music. If it exhausts, connected/empty health
  returns 503 and the operator must diagnose Tooken/catalog; no unrelated
  fallback music is inserted.
- TTS error: skip narration or use a pre-rendered fallback; never hold the track boundary.
- Spotify authorization 401/403: disable that provider, re-authorize it, and keep the other source.
- A YouTube Music audio-CDN 403 or transport break gets one immediate fresh
  resolve/download. If transient preparation still fails, the queued item is
  retried durably after 15 and 45 seconds before terminal failure; a listener
  request stays pending during these retries.
  A track that still fails is quarantined for 15 minutes, or six hours after a
  provider 403/404/410, so editorial rotation does not immediately select it again.
  A resolver 403 (`needs-account`) is not
  retried. Check the provider and choose another song; do not bypass music-only
  catalog validation or feed a direct URL into playout.
- FFmpeg failure: quarantine that cached object, retry once from a clean fetch, then fail
  the item and move on.
- SQLite error: stop mutations, keep the current already-buffered item if safe, and enter
  degraded health rather than busy-looping.

The ensemble maps six host profiles to six light RHVoice voices (Arina,
Pavel, Yuriy, Evgeniy-rus, Victoria, Mikhail). All six rendered valid WAVs
through the live bridge, but their sound and levels have not yet been accepted in
Discord. Do not mark the ensemble TTS ready or unattended on that basis alone:
check HTTP synthesis, ten consecutive Russian renders per chosen voice,
restart, latency, RAM and an audible handoff in the test guild. IVONA 2 Maxim
remains a preferred future upgrade but is not an ensemble blocker after the
failed Wine compatibility probes. The first Piper `dmitri-medium` live sample
was rejected as too natural; do not silently promote it as fallback.
The rendered speech cache defaults to 256 MiB (`TTS_CACHE_MAX_MB`). LRU pruning
preserves ready host segments and leaves a ten-minute grace period for freshly
prepared speech; a temporary overage is preferable to deleting on-air audio.
The speech-cache directory is private to the radio process (0700), and rendered
speech files use 0600, including while FFmpeg is writing its temporary output.
Compose mounts speech cache on its own named volume, including under Docker
Desktop, because Windows bind mounts do not preserve Linux ownership/mode bits.
The operator has also rejected the live eSpeak NG `ru+m3` sample as unintelligible;
do not use it as a fallback or reintroduce it through a default setting.
Three RHVoice 1.8.0 Russian male samples (`mikhail`, `pavel`, `yuriy`) were
previously compared; the operator chose Mikhail for the solo bot. The other
voices are now candidate character voices, not user-approved final choices.
The packaged engine is LGPL-2.1-or-later and Mikhail's dataset is
CC-BY-NC-ND-4.0. Recheck each voice's dataset license and any
distribution/public-use obligations before changing the current private
deployment.
Private installer intake belongs in operator-owned records outside Git. See
[licensing.md](../licensing.md) before any public music transmission.
