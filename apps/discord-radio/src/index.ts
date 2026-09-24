import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from './config.js';
import { RadioDirector } from './director.js';
import { DiscordRadioBot } from './discord-bot.js';
import { DiscordOutputFanout } from './discord-fanout.js';
import { DisabledSpeechEngine, FallbackScriptWriter, HostPresenter, HttpSpeechEngine, OpenAiScriptWriter, TemplateScriptWriter } from './host.js';
import { startHealthServer } from './health-server.js';
import { MediaCache } from './media-cache.js';
import { SpotifyProvider, YtMusicProvider } from './providers.js';
import { RadioStore } from './storage.js';
import { startRadioRuntime, stopRadioRuntimeDuringStartup } from './startup.js';
import { normalizeSpeech, SPEECH_AUDIO_VERSION } from './speech-audio.js';

async function main(): Promise<void> {
    const config = loadConfig();
    const store = new RadioStore(config.storage.databasePath, config.policy);
    const cache = new MediaCache(config.storage.cacheDirectory, config.storage.cacheMaxBytes);
    const providers = [
        ...(config.spotify ? [new SpotifyProvider(config.spotify.clientId, config.spotify.clientSecret, config.spotify.shimBaseUrl, config.spotify.bridgeSecret)] : []),
        ...(config.ytmusic ? [new YtMusicProvider(config.ytmusic.resolverBaseUrl)] : []),
    ];
    const output = new DiscordOutputFanout(config.discord.maxGuilds);
    const speech = config.tts
        ? new HttpSpeechEngine(config.tts.baseUrl, config.tts.token, config.tts.timeoutMs)
        : new DisabledSpeechEngine();
    const openAi = config.openai ? new OpenAiScriptWriter(config.openai, store) : undefined;
    if (config.aiMissingKey) {
        console.warn(JSON.stringify({ level: 'warn', event: 'ai.disabled', reason: 'TOOKEN_API_KEY is not configured' }));
    }
    const templates = new TemplateScriptWriter(config.stationName);
    const scriptWriter = openAi
        ? new FallbackScriptWriter(openAi, templates)
        : templates;
    const speechCacheDirectory = join(config.storage.cacheDirectory, '..', 'tts');
    if (config.tts) {
        await mkdir(speechCacheDirectory, { recursive: true, mode: 0o700 });
        await chmod(speechCacheDirectory, 0o700);
    }
    const presenter = config.tts ? new HostPresenter(scriptWriter, speech, speechCacheDirectory, config.tts.voice,
        { version: SPEECH_AUDIO_VERSION, normalize: normalizeSpeech }, config.tts.cacheMaxBytes,
        () => store.protectedHostPaths()) : undefined;
    const director = new RadioDirector(store, providers, cache, output, presenter, config.rotationQueries, openAi, config.jingleEveryMinutes * 60_000,
        { ...(openAi ? { planner: openAi, inputDecisionPlanner: openAi, shiftPlanner: openAi } : {}),
            isPrivileged: userId => config.discord.ownerIds.has(userId) || store.isStationAdmin(userId) });
    const bot = new DiscordRadioBot(config, director, output, store, providers, speech);
    director.setRequestFailureNotifier(async (recipient, message) => await bot.notifyRequestFailure(recipient, message));
    director.setHostNotificationSender(async (recipient, message) => await bot.notifyHostDecision(recipient, message));
    let shuttingDown = false;
    const startup = startRadioRuntime({ bot, director, store, listen: () => startHealthServer(director, config.healthPort) });
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
        await stopRadioRuntimeDuringStartup({ bot, director, store }, startup);
        if (process.exitCode !== 1) process.exitCode = 0;
    };
    const handleSignal = (signal: string): void => {
        void shutdown(signal).catch(error => {
            console.error(JSON.stringify({ level: 'error', event: 'shutdown.failed', message: error instanceof Error ? error.message : String(error) }));
            process.exitCode = 1;
        });
    };
    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
    try {
        await startup;
    } catch (error) {
        if (!shuttingDown) throw error;
    }
}

main().catch(error => {
    console.error(JSON.stringify({ level: 'fatal', event: 'startup.failed', message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
});
