import { describe, expect, it } from 'vitest';

import type { Track } from '../src/contracts.js';
import { matchesMusicQuery, songKey } from '../src/track-identity.js';

const song: Track = { provider: 'ytmusic', id: 'abcdefghijk', artist: 'КИНО', title: 'Группа крови (Remaster)', durationMs: 270_000 };

describe('music identity', () => {
    it('normalizes Cyrillic case and whitespace across catalog IDs', () => {
        expect(songKey(song)).toBe(songKey({ artist: ' кино ', title: '  группа  крови (remaster) ' }));
    });

    it('accepts a matching artist — title but rejects a misleading catalog result', () => {
        expect(matchesMusicQuery(song, 'Кино — Группа крови')).toBe(true);
        expect(matchesMusicQuery({ ...song, artist: 'Другой исполнитель' }, 'Кино — Группа крови')).toBe(false);
        expect(matchesMusicQuery({ ...song, artist: 'Кинолента' }, 'Кино — Группа крови')).toBe(false);
        expect(matchesMusicQuery({ ...song, title: 'Группа крови live' }, 'Кино - Группа крови')).toBe(false);
        expect(matchesMusicQuery({ ...song, artist: 'Enter Shikari', title: "Sorry You're Not a Winner" },
            'Enter Shikari — Sorry, You’re Not a Winner')).toBe(true);
        expect(matchesMusicQuery({ ...song, artist: 'The Prodigy', title: 'Omen (Extended Mix)' },
            'The Prodigy — Omen')).toBe(false);
        expect(matchesMusicQuery({ ...song, artist: 'Artist', title: 'Another Song' },
            'Artist — Song - Live')).toBe(false);
        expect(matchesMusicQuery({ ...song, artist: 'Artist', title: 'Song - Live' },
            'Artist — Song - Live')).toBe(true);
        expect(matchesMusicQuery(song, 'русский рок')).toBe(true);
    });
});
