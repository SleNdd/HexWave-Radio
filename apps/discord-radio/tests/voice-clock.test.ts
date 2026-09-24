import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { AudioPlayerStatus, NoSubscriberBehavior, StreamType, createAudioPlayer, createAudioResource } from '@discordjs/voice';
import { expect, it } from 'vitest';

it('drains a live audio resource without any Discord subscriber', async () => {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const resource = createAudioResource(Readable.from([Buffer.alloc(20), Buffer.alloc(20)]), { inputType: StreamType.Opus });
    const timeout = new AbortController();
    try {
        const completed = once(player, AudioPlayerStatus.Idle);
        player.play(resource);
        await expect(Promise.race([
            completed,
            delay(1_500, undefined, { signal: timeout.signal }).then(() => { throw new Error('station clock stalled without listeners'); }),
        ])).resolves.toBeDefined();
    } finally {
        timeout.abort();
        player.stop(true);
    }
});
