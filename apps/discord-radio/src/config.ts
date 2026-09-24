import { resolve } from 'node:path';

export interface RadioConfig {
    discord: {
        token: string;
        clientId: string;
        ownerIds: Set<string>;
        maxGuilds: number;
    };
    storage: {
        databasePath: string;
        cacheDirectory: string;
        cacheMaxBytes: number;
    };
    openai?: {
        apiKey: string;
        baseUrl: string;
        apiFormat: 'responses' | 'chat';
        model: string;
        timeoutMs: number;
        hourlyLimit: number;
        dailyLimit: number;
    };
    aiMissingKey: boolean;
    tts?: {
        baseUrl: string;
        token?: string;
        voice: string;
        timeoutMs: number;
        cacheMaxBytes: number;
    };
    spotify?: {
        clientId: string;
        clientSecret: string;
        shimBaseUrl: string;
        bridgeSecret: string;
    };
    ytmusic?: {
        resolverBaseUrl: string;
    };
    rotationQueries: string[];
    stationName: string;
    jingleEveryMinutes: number;
    healthPort: number;
    policy: {
        requestCooldownMs: number;
        requestTtlMs: number;
        studioCooldownMs: number;
        studioTtlMs: number;
        trackCooldownMs: number;
        artistCooldownMs: number;
    };
}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing required environment variable ${key}`);
    return value;
};

const list = (value: string | undefined): Set<string> => new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean));

const integer = (env: NodeJS.ProcessEnv, key: string, fallback: number, minimum = 1): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${key} must be an integer >= ${minimum}`);
    return value;
};

const httpUrl = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
    const raw = env[key]?.trim();
    if (!raw) return undefined;
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${key} must use http or https`);
    return url.toString().replace(/\/$/, '');
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RadioConfig {
    const ownerIds = list(required(env, 'DISCORD_OWNER_IDS'));
    if (ownerIds.size !== 1) throw new Error('DISCORD_OWNER_IDS must contain exactly one root owner user ID');
    const aiBaseUrl = (env.OPENAI_BASE_URL?.trim() || 'https://tooken.club/v1').replace(/\/$/, '');
    if (aiBaseUrl !== 'https://tooken.club/v1') {
        throw new Error('OPENAI_BASE_URL must be https://tooken.club/v1; direct OpenAI API is disabled');
    }
    // A direct OpenAI project key is never used by the station, even if present
    // in an older environment file.
    const tookenKey = env.TOOKEN_API_KEY?.trim();
    const organizerModel = env.OPENAI_MODEL?.trim() || 'gpt-6-luna';
    if (organizerModel !== 'gpt-6-luna') {
        throw new Error('OPENAI_MODEL must be gpt-6-luna for the fixed organizer');
    }

    const ttsBaseUrl = httpUrl(env, 'TTS_BASE_URL');
    const spotifyClientId = env.SPOTIFY_CLIENT_ID?.trim();
    const spotifyClientSecret = env.SPOTIFY_CLIENT_SECRET?.trim();
    const spotifyShim = httpUrl(env, 'SPOTIFY_SHIM_BASE_URL');
    const spotifySecret = env.PLAYOUT_BRIDGE_SECRET?.trim();
    const spotifyParts = [spotifyClientId, spotifyClientSecret, spotifyShim, spotifySecret].filter(Boolean).length;
    if (spotifyParts !== 0 && spotifyParts !== 4) {
        throw new Error('SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_SHIM_BASE_URL and PLAYOUT_BRIDGE_SECRET must be set together');
    }

    const ytResolver = httpUrl(env, 'YTAUDIO_BASE_URL');
    if (!spotifyShim && !ytResolver) throw new Error('Configure Spotify or YTAUDIO_BASE_URL so the station has a music source');

    const maxGuilds = integer(env, 'RADIO_MAX_GUILDS', 3);
    if (maxGuilds > 3) throw new Error('RADIO_MAX_GUILDS cannot exceed 3 in this release');

    return {
        discord: {
            token: required(env, 'DISCORD_TOKEN'),
            clientId: required(env, 'DISCORD_CLIENT_ID'),
            ownerIds,
            maxGuilds,
        },
        storage: {
            databasePath: resolve(env.RADIO_DB_PATH?.trim() || 'var/data/discord-radio.sqlite'),
            cacheDirectory: resolve(env.RADIO_CACHE_DIR?.trim() || 'var/cache/media'),
            cacheMaxBytes: integer(env, 'RADIO_CACHE_MAX_MB', 1024) * 1024 * 1024,
        },
        ...(tookenKey
            ? {
                  openai: {
                      apiKey: tookenKey,
                      baseUrl: aiBaseUrl,
                      apiFormat: 'chat' as const,
                      model: organizerModel,
                      timeoutMs: integer(env, 'OPENAI_TIMEOUT_MS', 20_000),
                      hourlyLimit: integer(env, 'OPENAI_HOURLY_LIMIT', 0, 0),
                      dailyLimit: integer(env, 'OPENAI_DAILY_LIMIT', 0, 0),
                  },
              }
            : {}),
        aiMissingKey: !tookenKey,
        ...(ttsBaseUrl
            ? {
                  tts: {
                      baseUrl: ttsBaseUrl,
                      ...(env.TTS_TOKEN?.trim() ? { token: env.TTS_TOKEN.trim() } : {}),
                      voice: env.TTS_VOICE?.trim() || 'mikhail',
                      timeoutMs: integer(env, 'TTS_TIMEOUT_MS', 12_000),
                      cacheMaxBytes: integer(env, 'TTS_CACHE_MAX_MB', 256) * 1024 * 1024,
                  },
              }
            : {}),
        ...(spotifyClientId && spotifyClientSecret && spotifyShim && spotifySecret
            ? { spotify: { clientId: spotifyClientId, clientSecret: spotifyClientSecret, shimBaseUrl: spotifyShim, bridgeSecret: spotifySecret } }
            : {}),
        ...(ytResolver ? { ytmusic: { resolverBaseUrl: ytResolver } } : {}),
        rotationQueries: (env.RADIO_ROTATION_QUERIES ?? 'drum n bass,phonk,metal,techno,electronic')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
            .slice(0, 20),
        stationName: (env.RADIO_STATION_NAME?.trim() || 'HexWave Radio').slice(0, 60),
        jingleEveryMinutes: integer(env, 'RADIO_JINGLE_EVERY_MINUTES', 30, 0),
        healthPort: integer(env, 'RADIO_HEALTH_PORT', 9380),
        policy: {
            requestCooldownMs: integer(env, 'REQUEST_COOLDOWN_MINUTES', 15) * 60_000,
            requestTtlMs: integer(env, 'REQUEST_TTL_MINUTES', 120) * 60_000,
            studioCooldownMs: integer(env, 'STUDIO_COOLDOWN_MINUTES', 15) * 60_000,
            studioTtlMs: integer(env, 'STUDIO_TTL_MINUTES', 120) * 60_000,
            trackCooldownMs: integer(env, 'TRACK_COOLDOWN_MINUTES', 360) * 60_000,
            artistCooldownMs: integer(env, 'ARTIST_COOLDOWN_MINUTES', 45) * 60_000,
        },
    };
}
