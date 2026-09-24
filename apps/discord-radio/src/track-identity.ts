import type { Track } from './contracts.js';

export function metadataKey(value: string): string {
    return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
}

const titleMatchKey = (value: string): string => metadataKey(value)
    .replace(/[\u2018\u2019\u02bc',]/gu, '')
    .replace(/\s+/gu, ' ');

export function songKey(track: Pick<Track, 'artist' | 'title'>): string {
    return `${metadataKey(track.artist)}\u001f${metadataKey(track.title)}`;
}

/** Generic discovery seeds remain broad; an explicit artist — title seed must resolve to that recording. */
export function matchesMusicQuery(track: Track, query: string): boolean {
    const separator = /\s+[—–-]\s+/u.exec(query);
    if (!separator || separator.index === undefined) return true;
    const artist = metadataKey(query.slice(0, separator.index));
    const title = metadataKey(query.slice(separator.index + separator[0].length));
    if (!artist || !title) return false;
    const candidateArtist = metadataKey(track.artist);
    const candidateTitle = metadataKey(track.title);
    const artistMatches = candidateArtist === artist || candidateArtist.startsWith(`${artist},`) ||
        candidateArtist.startsWith(`${artist} feat`);
    const titleMatches = titleMatchKey(candidateTitle) === titleMatchKey(title) ||
        (candidateTitle.startsWith(`${title} (`) &&
            /^\((?:remaster(?:ed)?(?: \d{4})?|feat\.? .+)\)$/u.test(candidateTitle.slice(title.length + 1)));
    return artistMatches && titleMatches;
}
