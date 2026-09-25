import { describe, expect, it } from 'vitest';

import { balanceHostShift, fallbackHostShift, jointShowAllowed, validateHostShiftProposal } from '../src/host-scheduler.js';

describe('host shift selection', () => {
    it('accepts only an allowlisted host and bounded shift length', () => {
        expect(validateHostShiftProposal({ hostId: 'glm', minutes: 180 })).toEqual({ hostId: 'glm', minutes: 180 });
        expect(() => validateHostShiftProposal({ hostId: 'outsider', minutes: 180 })).toThrow();
        expect(() => validateHostShiftProposal({ hostId: 'glm', minutes: 1_000 })).toThrow();
    });

    it('prefers lesser-heard hosts and does not repeat the current host on fallback', () => {
        const recentShifts = [
            { hostId: 'luna' as const, minutes: 300 },
            { hostId: 'sol' as const, minutes: 250 },
            { hostId: 'grok' as const, minutes: 200 },
            { hostId: 'deepseek' as const, minutes: 100 },
            { hostId: 'glm' as const, minutes: 90 },
            { hostId: 'claude' as const, minutes: 0 },
        ];
        expect(fallbackHostShift(recentShifts, 'claude', () => 0).hostId).toBe('glm');
        expect(fallbackHostShift(recentShifts, 'claude', () => 0.99).hostId).not.toBe('claude');
    });

    it('bounds organizer favoritism without forcing a cyclic order', () => {
        const history = [{ hostId: 'luna' as const, minutes: 600 }, { hostId: 'grok' as const, minutes: 80 }];
        expect(balanceHostShift({ hostId: 'luna', minutes: 180 }, history, 'luna', () => 0).hostId).not.toBe('luna');
        expect(balanceHostShift({ hostId: 'grok', minutes: 120 }, history, 'luna')).toEqual({ hostId: 'grok', minutes: 120 });
    });

    it('lets the organizer choose solo while bounding actually aired joint appearances', () => {
        expect(jointShowAllowed(1, { solo: 0, pair: 0, trio: 0 })).toBe(true);
        expect(jointShowAllowed(2, { solo: 0, pair: 0, trio: 0 })).toBe(true);
        expect(jointShowAllowed(2, { solo: 0, pair: 1, trio: 0 })).toBe(false);
        expect(jointShowAllowed(3, { solo: 90, pair: 9, trio: 1 })).toBe(true);
        expect(jointShowAllowed(3, { solo: 90, pair: 9, trio: 4 })).toBe(false);
    });
});
