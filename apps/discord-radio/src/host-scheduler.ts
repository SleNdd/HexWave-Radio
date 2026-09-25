import { HOST_IDS, type HostId } from './host-profiles.js';
import type { HostShiftProposal } from './contracts.js';

export function validateHostShiftProposal(value: unknown): HostShiftProposal {
    if (!value || typeof value !== 'object') throw new Error('Invalid host shift proposal');
    const proposal = value as Record<string, unknown>;
    if (!HOST_IDS.includes(proposal.hostId as HostId) ||
        !Number.isInteger(proposal.minutes) || Number(proposal.minutes) < 60 || Number(proposal.minutes) > 300) {
        throw new Error('Invalid host shift proposal');
    }
    return { hostId: proposal.hostId as HostId, minutes: Number(proposal.minutes) };
}

// Deterministic safety floor for a failed organizer call. One draw among the
// least-aired half gives variety without allowing a model outage to starve a host.
export function fallbackHostShift(
    recentShifts: ReadonlyArray<{ hostId: HostId; minutes: number }>,
    currentHostId?: HostId,
    random: () => number = Math.random,
): HostShiftProposal {
    const airtime = new Map<HostId, number>(HOST_IDS.map(id => [id, 0]));
    for (const shift of recentShifts) airtime.set(shift.hostId, airtime.get(shift.hostId)! + Math.max(0, shift.minutes));
    const eligible = HOST_IDS.filter(id => id !== currentHostId).sort((a, b) => airtime.get(a)! - airtime.get(b)!);
    const pool = eligible.slice(0, Math.min(3, eligible.length));
    const sample = random();
    const draw = Number.isFinite(sample) ? Math.min(0.999999, Math.max(0, sample)) : 0;
    return { hostId: pool[Math.floor(draw * pool.length)]!, minutes: 150 + Math.floor(draw * 61) };
}

export function balanceHostShift(
    proposal: HostShiftProposal,
    recentShifts: ReadonlyArray<{ hostId: HostId; minutes: number }>,
    currentHostId?: HostId,
    random: () => number = Math.random,
): HostShiftProposal {
    const valid = validateHostShiftProposal(proposal);
    const airtime = new Map<HostId, number>(HOST_IDS.map(id => [id, 0]));
    for (const shift of recentShifts) airtime.set(shift.hostId, airtime.get(shift.hostId)! + Math.max(0, shift.minutes));
    const least = Math.min(...airtime.values());
    const selected = airtime.get(valid.hostId)!;
    if (selected > least + 240 || (valid.hostId === currentHostId && selected > least + 60)) {
        return fallbackHostShift(recentShifts, currentHostId, random);
    }
    return valid;
}

// The organizer decides whether to invite colleagues. This is only a ceiling
// on actually aired joint breaks, never a rule that forces a dialogue.
export function jointShowAllowed(size: 1 | 2 | 3,
    counts: { solo: number; pair: number; trio: number }): boolean {
    if (size === 1) return true;
    const total = counts.solo + counts.pair + counts.trio + 1;
    return size === 2 ? counts.pair + 1 <= Math.max(1, Math.ceil(total * 0.17))
        : counts.trio + 1 <= Math.max(1, Math.ceil(total * 0.03));
}
