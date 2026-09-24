import type { RecentSpin, ShowPlanProposal } from './contracts.js';

export const SHOW_PLAN_TTL_MS = 60 * 60_000;

const themes: readonly ShowPlanProposal[] = [
    { theme: 'Ночной город', queries: ['ночная электроника', 'synthwave', 'trip hop', 'ambient electronic'], requestRun: 'alternate' },
    { theme: 'Гитарные маршруты', queries: ['русский инди рок', 'indie rock', 'alternative rock', 'post punk'], requestRun: 'alternate' },
    { theme: 'Тёплый грув', queries: ['современный фанк', 'neo soul', 'jazz funk', 'disco groove'], requestRun: 'alternate' },
    { theme: 'Спокойный горизонт', queries: ['спокойная музыка', 'dream pop', 'downtempo', 'chill electronic'], requestRun: 'alternate' },
    { theme: 'Быстрый пульс', queries: ['танцевальная электроника', 'drum and bass', 'house music', 'breakbeat'], requestRun: 'alternate' },
    { theme: 'Неожиданные голоса', queries: ['альтернативная поп музыка', 'art pop', 'indie pop', 'electropop'], requestRun: 'alternate' },
];

export function fallbackShowPlan(now: number, recentPlayed: readonly RecentSpin[], rotationQueries: readonly string[] = []): ShowPlanProposal {
    if (rotationQueries.length >= 3) {
        return { theme: 'Резервный эфир', queries: [...rotationQueries.slice(0, 6)], requestRun: 'alternate' };
    }
    const hour = Math.floor(now / SHOW_PLAN_TTL_MS);
    const last = recentPlayed[0];
    let hash = 0;
    for (const character of `${last?.artist ?? ''}:${last?.title ?? ''}`) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
    const choice = themes[((hour + (hash >>> 0)) % themes.length)]!;
    return { theme: choice.theme, queries: [...choice.queries], requestRun: choice.requestRun };
}

export function validateShowProposal(input: unknown): ShowPlanProposal {
    if (!input || typeof input !== 'object') throw new Error('Show plan is not an object');
    const proposal = input as Partial<ShowPlanProposal>;
    const theme = typeof proposal.theme === 'string' ? proposal.theme.trim() : '';
    if (theme.length < 3) throw new Error('Show plan has an invalid theme: short');
    if (theme.length > 100) throw new Error('Show plan has an invalid theme: long');
    if (/\b(?:https?|ftp):\/\/|www\./iu.test(theme)) throw new Error('Show plan has an invalid theme: url');
    if (!Array.isArray(proposal.queries) || proposal.queries.length < 3 || proposal.queries.length > 10) {
        throw new Error('Show plan must have 3-10 search queries');
    }
    const queries = proposal.queries.map(query => typeof query === 'string' ? query.trim() : '');
    if (queries.some(query => query.length < 2 || query.length > 80 || /\b(?:https?|ftp):\/\/|www\./iu.test(query)) ||
        new Set(queries.map(query => query.toLocaleLowerCase('ru'))).size !== queries.length) {
        throw new Error('Show plan needs distinct bounded search seeds');
    }
    if (proposal.requestRun !== 'continue' && proposal.requestRun !== 'alternate') throw new Error('Show plan has invalid request-run decision');
    return { theme, queries, requestRun: proposal.requestRun };
}
