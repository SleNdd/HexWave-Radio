# HexWave Radio — runtime

Compact, single-station Discord runtime. It uses Node's built-in SQLite, a single serialized `RadioDirector`, local media caching and one shared Discord `AudioPlayer` subscribed to at most three guild connections.

Copy `../../deploy/discord-radio/.env.example` to `../../deploy/discord-radio/.env`, fill the Discord values and configure a provider. Spotify catalog search uses the official Web API while Premium playback remains separately authorized in the bundled Spotify shim. YouTube Music catalog search uses `youtubei.js` and `ytaudio`. Provider URLs are downloaded to the bounded local cache before playout; Discord never receives an arbitrary remote URL.

Set `DISCORD_OWNER_IDS` to exactly one root-owner user ID. Only that account can
appoint or remove station administrators with `/radio admin-add` and
`/radio admin-remove`; administrator grants persist in SQLite. The root owner and
appointed administrators bypass listener cooldowns and queue quotas. Guild roles
and Discord's Administrator permission grant nothing here. All other guild
members may use `/request`, `/studio`, `/radio now`, `/radio status`, and join or
leave the voice output from its channel; emergency controls remain admin-only.

```bash
pnpm --filter @hexwave/radio typecheck
pnpm --filter @hexwave/radio test
pnpm --filter @hexwave/radio build
pnpm --filter @hexwave/radio start
```

IVONA/Wine and voice/licence files are deliberately not bundled. The current
Linux ensemble uses six RHVoice voices behind the `POST /synthesize` HTTP contract
(`{ text, voice }` → audio response). IVONA Maxim remains a future adapter if a
reliable isolated runtime is proven. If Tooken Club or TTS is unavailable, music
continues; presenter text falls back to local templates.

AI is optional. Tooken Club is the sole AI gateway, using its OpenAI-compatible
endpoint and `TOOKEN_API_KEY`. Luna is the fixed organizer; the six host profiles
use the corresponding models through that same gateway. The old direct
`OPENAI_API_KEY` is ignored. Without a Tooken key, already prepared music can finish,
but no new editorial tracks are selected. Presenter templates remain available.
Optional local call limits can be configured;
hosted web-search and container tools are not enabled. Listener input is
filtered before it reaches any AI endpoint. Tooken balance/usage is separate
from OpenAI's complimentary-token programme.

The production image uses Node 26, FFmpeg and one `opusscript` encoder shared by every
guild output. Build and validate the stack with:

```bash
docker compose -f deploy/discord-radio/docker-compose.yml \
  --env-file deploy/discord-radio/.env build radio ytaudio
docker compose -f deploy/discord-radio/docker-compose.yml \
  --env-file deploy/discord-radio/.env up -d
```
