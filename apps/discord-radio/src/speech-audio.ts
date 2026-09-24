import { spawn } from 'node:child_process';

// Narration is prepared ahead of playout. Normalize it here instead of adding
// gain to the shared Discord player, which would also affect music.
export const SPEECH_AUDIO_VERSION = 'voice-gain15-limiter-v2';

export async function normalizeSpeech(input: string, output: string, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', input,
            '-af', 'volume=15dB,alimiter=limit=0.89:level=0:attack=5:release=100',
            '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', output,
        ], { stdio: 'ignore', signal });
        child.once('error', reject);
        child.once('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Speech normalization failed (ffmpeg exit ${code ?? 'unknown'})`));
        });
    });
}
