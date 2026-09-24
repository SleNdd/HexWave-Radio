import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

import { Innertube, Log } from 'youtubei.js';

import type { MediaFetch, MusicProvider, ProviderName, Track } from './contracts.js';

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const YTMUSIC_ID = /^[A-Za-z0-9_-]{11}$/;
const YTMUSIC_AUDIO_MIME_TYPES: string[] = ['audio/mp4', 'audio/m4a', 'audio/aac'];

interface CatalogTrack {
    id?: unknown;
    title?: unknown;
    artist?: unknown;
    durationMs?: unknown;
    type?: unknown;
}

function validTrack(provider: ProviderName, raw: CatalogTrack): Track | undefined {
    if (raw.type !== undefined && raw.type !== 'track' && raw.type !== 'song') return undefined;
    if (typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.artist !== 'string') return undefined;
    const durationMs = Number(raw.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 10_000 || durationMs > 30 * 60_000) return undefined;
    if (!(provider === 'spotify' ? SPOTIFY_ID : YTMUSIC_ID).test(raw.id)) return undefined;
    return { provider, id: raw.id, title: raw.title.trim().slice(0, 300), artist: raw.artist.trim().slice(0, 300), durationMs: Math.round(durationMs) };
}

function assertId(provider: ProviderName, id: string): void {
    if (!(provider === 'spotify' ? SPOTIFY_ID : YTMUSIC_ID).test(id)) throw new Error(`Invalid ${provider} track id`);
}

async function request(url: string, init: RequestInit, timeoutMs = 15_000, parentSignal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    return await fetch(url, { ...init, signal, redirect: 'error' });
}

interface SpotifyTrack {
    id?: string;
    name?: string;
    duration_ms?: number;
    type?: string;
    artists?: Array<{ name?: string }>;
}

const spotifyTrack = (row: SpotifyTrack): Track | undefined =>
    validTrack('spotify', {
        id: row.id,
        title: row.name,
        artist: row.artists?.map(artist => artist.name?.trim()).filter(Boolean).join(', '),
        durationMs: row.duration_ms,
        type: row.type,
    });

export class SpotifyProvider implements MusicProvider {
    readonly name = 'spotify' as const;
    private accessToken?: { value: string; expiresAt: number };

    constructor(
        private readonly clientId: string,
        private readonly clientSecret: string,
        private readonly shimBaseUrl: string,
        private readonly bridgeSecret: string,
    ) {
        if (!clientId || !clientSecret || !bridgeSecret) throw new Error('Spotify credentials cannot be empty');
    }

    async search(query: string, limit = 5, signal?: AbortSignal): Promise<Track[]> {
        const normalized = query.trim();
        if (!normalized || normalized.length > 300) return [];
        const url = new URL('https://api.spotify.com/v1/search');
        url.searchParams.set('q', normalized);
        url.searchParams.set('type', 'track');
        url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 5)));
        const response = await request(url.toString(), { headers: { authorization: `Bearer ${await this.token(signal)}` } }, 12_000, signal);
        if (!response.ok) throw new Error(`Spotify search failed (${response.status})`);
        const body = (await response.json()) as { tracks?: { items?: SpotifyTrack[] } };
        return (body.tracks?.items ?? []).map(spotifyTrack).filter((track): track is Track => track !== undefined);
    }

    async resolve(trackId: string, signal?: AbortSignal): Promise<Track | undefined> {
        assertId(this.name, trackId);
        const response = await request(
            `https://api.spotify.com/v1/tracks/${trackId}`,
            { headers: { authorization: `Bearer ${await this.token(signal)}` } },
            12_000,
            signal,
        );
        if (response.status === 404) return undefined;
        if (!response.ok) throw new Error(`Spotify track lookup failed (${response.status})`);
        return spotifyTrack((await response.json()) as SpotifyTrack);
    }

    async fetch(trackId: string, signal?: AbortSignal): Promise<MediaFetch> {
        assertId(this.name, trackId);
        const expiry = Math.floor(Date.now() / 1000) + 30 * 60;
        const exp = String(expiry);
        const input = `${trackId.length}:${trackId}:${exp.length}:${exp}`;
        const signature = createHmac('sha256', this.bridgeSecret).update(input).digest('base64url');
        const response = await request(`${this.shimBaseUrl}/track/${trackId}?t=${exp}.${signature}`, {}, 90_000, signal);
        if (!response.ok || !response.body) throw new Error(`Spotify audio fetch failed (${response.status})`);
        const mimeType = response.headers.get('content-type')?.split(';')[0] ?? '';
        if (mimeType !== 'audio/ogg' && mimeType !== 'application/ogg') throw new Error(`Spotify shim returned unsafe content type ${mimeType || 'unknown'}`);
        return { body: Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), mimeType };
    }

    async health(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
        try {
            await this.token(signal);
            const response = await request(`${this.shimBaseUrl}/health`, {}, 5_000, signal);
            return response.ok ? { ok: true, detail: 'catalog and shim reachable' } : { ok: false, detail: `Spotify shim HTTP ${response.status}` };
        } catch (error) {
            return { ok: false, detail: error instanceof Error ? error.message : 'Spotify unavailable' };
        }
    }

    private async token(signal?: AbortSignal): Promise<string> {
        if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
        const response = await request(
            'https://accounts.spotify.com/api/token',
            {
                method: 'POST',
                headers: {
                    authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
                    'content-type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
            },
            12_000,
            signal,
        );
        if (!response.ok) throw new Error(`Spotify authorization failed (${response.status})`);
        const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
        if (typeof body.access_token !== 'string') throw new Error('Spotify returned no access token');
        const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
        this.accessToken = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
        return body.access_token;
    }
}

interface YtResolveResponse {
    url?: unknown;
    mimeType?: unknown;
    expiresAt?: unknown;
}

interface YtMusicRow {
    id?: string;
    title?: string | { text?: string };
    duration?: { seconds?: number };
    artists?: Array<{ name?: string }>;
}

function ytRows(result: unknown, depth = 0): YtMusicRow[] {
    if (!result || typeof result !== 'object' || depth > 3) return [];
    const node = result as { items?: YtMusicRow[]; contents?: unknown };
    if (Array.isArray(node.items)) return node.items;
    if (Array.isArray(node.contents)) {
        const rows = node.contents as Array<YtMusicRow & { contents?: YtMusicRow[] }>;
        return rows.some(row => Array.isArray(row.contents)) ? rows.flatMap(row => row.contents ?? []) : rows;
    }
    return ytRows(node.contents, depth + 1);
}

const ytTrack = (row: YtMusicRow): Track | undefined =>
    validTrack('ytmusic', {
        id: row.id,
        title: typeof row.title === 'string' ? row.title : row.title?.text,
        artist: row.artists?.map(artist => artist.name?.trim()).filter(Boolean).join(', '),
        durationMs: typeof row.duration?.seconds === 'number' ? row.duration.seconds * 1000 : undefined,
        type: 'song',
    });

export class YtMusicProvider implements MusicProvider {
    readonly name = 'ytmusic' as const;
    private client?: Promise<Innertube>;

    constructor(private readonly resolverBaseUrl: string) {
        Log.setLevel();
    }

    async search(query: string, limit = 5): Promise<Track[]> {
        const normalized = query.trim();
        if (!normalized || normalized.length > 300) return [];
        const result = await (await this.clientInstance()).music.search(normalized, { type: 'song' });
        return ytRows(result)
            .map(ytTrack)
            .filter((track): track is Track => track !== undefined)
            .slice(0, Math.min(Math.max(limit, 1), 5));
    }

    async resolve(trackId: string): Promise<Track | undefined> {
        assertId(this.name, trackId);
        try {
            const info = await (await this.clientInstance()).music.getInfo(trackId);
            const basic = (info as { basic_info?: { id?: string; title?: string; duration?: number; author?: string } }).basic_info;
            if (!basic) return undefined;
            const candidate = validTrack(this.name, {
                id: basic.id ?? trackId,
                title: basic.title,
                artist: basic.author,
                durationMs: typeof basic.duration === 'number' ? basic.duration * 1000 : undefined,
                type: 'song',
            });
            if (!candidate || candidate.id !== trackId) return undefined;
            const songs = await this.search(`${candidate.artist} ${candidate.title}`, 5);
            return songs.find(song => song.id === trackId);
        } catch {
            return undefined;
        }
    }

    async fetch(trackId: string, signal?: AbortSignal): Promise<MediaFetch> {
        assertId(this.name, trackId);
        const resolved = await request(
            `${this.resolverBaseUrl}/resolve`,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ videoId: trackId }) },
            30_000,
            signal,
        );
        if (!resolved.ok) throw new Error(`YouTube Music resolve failed (${resolved.status})`);
        const body = (await resolved.json()) as YtResolveResponse;
        if (typeof body.url !== 'string') throw new Error('YouTube Music resolver returned no URL');
        const url = new URL(body.url);
        if (url.protocol !== 'https:') throw new Error('YouTube Music resolver returned a non-HTTPS URL');
        const hostname = url.hostname.toLowerCase();
        if (hostname !== 'googlevideo.com' && !hostname.endsWith('.googlevideo.com')) {
            throw new Error('YouTube Music resolver returned an untrusted media host');
        }
        if (typeof body.expiresAt === 'number' && body.expiresAt <= Date.now() + 60_000) throw new Error('YouTube Music resolver returned an expired URL');
        const response = await request(url.toString(), {}, 90_000, signal);
        if (!response.ok || !response.body) throw new Error(`YouTube Music audio fetch failed (${response.status})`);
        const mimeType = response.headers.get('content-type')?.split(';')[0] ?? (typeof body.mimeType === 'string' ? body.mimeType : '');
        if (!YTMUSIC_AUDIO_MIME_TYPES.includes(mimeType)) throw new Error(`YouTube Music returned unsafe content type ${mimeType || 'unknown'}`);
        return { body: Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), mimeType };
    }

    async health(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
        try {
            await this.clientInstance();
            const response = await request(`${this.resolverBaseUrl}/health`, {}, 5_000, signal);
            return response.ok ? { ok: true, detail: 'catalog and resolver reachable' } : { ok: false, detail: `ytaudio HTTP ${response.status}` };
        } catch (error) {
            return { ok: false, detail: error instanceof Error ? error.message : 'YouTube Music unavailable' };
        }
    }

    private clientInstance(): Promise<Innertube> {
        this.client ??= Innertube.create({ retrieve_player: false });
        return this.client;
    }
}

export function providerFor(providers: readonly MusicProvider[], name: ProviderName): MusicProvider {
    const provider = providers.find(candidate => candidate.name === name);
    if (!provider) throw new Error(`Provider ${name} is not configured`);
    return provider;
}
