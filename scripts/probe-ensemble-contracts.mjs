// Bounded, isolated Tooken contract smoke. Run after building discord-radio:
// node --env-file=deploy/discord-radio/.env scripts/probe-ensemble-contracts.mjs
// This does not boot the bot, touch its SQLite database, or print credentials.
import { OpenAiScriptWriter } from '../apps/discord-radio/dist/host.js';
import { HOST_IDS, HOST_PROFILES } from '../apps/discord-radio/dist/host-profiles.js';

const apiKey = process.env.TOOKEN_API_KEY;
if (!apiKey) throw new Error('TOOKEN_API_KEY is not configured');

const config = {
  apiKey,
  baseUrl: 'https://tooken.club/v1',
  apiFormat: 'chat',
  model: 'gpt-6-luna',
  timeoutMs: 65_000,
  hourlyLimit: 0,
  dailyLimit: 0,
};
// The real writer only needs reservation from storage. No production DB writes.
const reservation = { reserveAiCall: () => true };
const diagnostic = process.argv.includes('--diagnostic');
const hostArguments = process.argv.slice(2).filter(arg => arg !== '--diagnostic');
const requestedHosts = hostArguments.length ? hostArguments : undefined;
const hostIds = requestedHosts ?? Object.keys(HOST_PROFILES);
if (hostIds.length === 0 || hostIds.length > HOST_IDS.length ||
    new Set(hostIds).size !== hostIds.length || hostIds.some(id => !HOST_IDS.includes(id))) {
  throw new Error('Arguments must contain 1–6 unique known host IDs');
}
const lastResponses = new Map();
if (diagnostic) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    try {
      const body = await response.clone().json();
      const model = JSON.parse(init.body).model;
      const content = body?.choices?.[0]?.message?.content;
      lastResponses.set(model, typeof content === 'string'
        ? { length: content.length, preview: content.slice(0, 500) }
        : { type: typeof content, finishReason: body?.choices?.[0]?.finish_reason });
    } catch { /* Diagnostics never change the request result. */ }
    return response;
  };
}
const breakContext = {
  kind: 'station',
  previousTrack: {
    provider: 'ytmusic', id: 'radiohead-fake', title: 'Everything In Its Right Place',
    artist: 'Radiohead', durationMs: 251_000,
  },
  nextTrack: {
    provider: 'ytmusic', id: 'agnes-obel-fake', title: 'Familiar',
    artist: 'Agnes Obel', durationMs: 235_000,
  },
  recentLines: [
    'Ночь ещё не решила, кем ей быть. Давайте поможем ей музыкой.',
    'В студии спорят о жанрах. Пока побеждает тот, кто первым нажал play.',
  ],
};

async function probeHost(hostId) {
  const started = Date.now();
  try {
    const writer = new OpenAiScriptWriter(config, reservation);
    const line = await writer.writeBreak({ ...breakContext, hostId });
    return { hostId, ok: true, latencyMs: Date.now() - started, line };
  } catch (error) {
    return { hostId, ok: false, latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown failure',
      ...(diagnostic ? { response: lastResponses.get(HOST_PROFILES[hostId].model) } : {}) };
  }
}

// Two concurrent probes avoid a long serialized run without flooding the API.
const results = [];
for (let index = 0; index < hostIds.length; index += 2) {
  results.push(...await Promise.all(hostIds.slice(index, index + 2).map(probeHost)));
  for (const result of results.slice(-Math.min(2, hostIds.length - index))) console.log(JSON.stringify(result));
}

if (requestedHosts === undefined) {
  const shiftStarted = Date.now();
  try {
    const writer = new OpenAiScriptWriter(config, reservation);
    const shift = await writer.proposeHostShift({
      currentHostId: 'luna',
      recentShifts: hostIds.map(hostId => ({ hostId, minutes: 180 })),
      currentTheme: 'ночной электронный эфир',
    });
    console.log(JSON.stringify({ organizer: true, ok: true, latencyMs: Date.now() - shiftStarted, shift }));
  } catch (error) {
    console.log(JSON.stringify({ organizer: true, ok: false, latencyMs: Date.now() - shiftStarted,
      error: error instanceof Error ? error.message : 'unknown failure' }));
    process.exitCode = 1;
  }
}

if (results.some(result => !result.ok)) process.exitCode = 1;
