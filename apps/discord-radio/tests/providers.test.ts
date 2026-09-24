import { afterEach, describe, expect, it, vi } from 'vitest';

import { YtMusicProvider } from '../src/providers.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('YtMusicProvider media boundary', () => {
    it('rejects a resolver URL outside the trusted Google media CDN', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    url: 'https://attacker.example/private-audio',
                    mimeType: 'audio/mp4',
                    expiresAt: Date.now() + 600_000,
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );
        vi.stubGlobal('fetch', fetchMock);
        const provider = new YtMusicProvider('http://ytaudio:8080');

        await expect(provider.fetch('abcdefghijk')).rejects.toThrow('untrusted media host');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not resolve a generic video that is absent from song results', async () => {
        const provider = new YtMusicProvider('http://ytaudio:8080');
        const fakeMusic = {
            getInfo: async () => ({ basic_info: { id: 'abcdefghijk', title: 'Talk show', author: 'Channel', duration: 300 } }),
            search: async () => ({ items: [] }),
        };
        (provider as unknown as { client: Promise<{ music: typeof fakeMusic }> }).client = Promise.resolve({ music: fakeMusic });

        await expect(provider.resolve('abcdefghijk')).resolves.toBeUndefined();
    });
});
