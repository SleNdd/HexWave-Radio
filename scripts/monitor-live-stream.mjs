import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const durationSeconds = Number(process.argv[2] ?? 300);
const outputPath = resolve(process.argv[3] ?? 'var/log/live-stream-soak.jsonl');
const gapThresholdMs = Number(process.argv[4] ?? 1000);
if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 72 * 3600 ||
    !Number.isSafeInteger(gapThresholdMs) || gapThresholdMs < 100) {
    throw new Error('Usage: node scripts/monitor-live-stream.mjs <seconds 1..259200> [output.jsonl] [gap-ms >= 100]');
}

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
if (existsSync(outputPath) && statSync(outputPath).size > 0) {
    throw new Error('Monitor log already has data; choose a fresh output path for a new run');
}
const record = (event, details = {}) => {
    appendFileSync(outputPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, { mode: 0o600 });
};

const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1000;
let bytes = 0;
let gaps = 0;
let reconnects = 0;
let stalls = 0;
let connected = false;
let maxGapMs = 0;
let lastPacketAt = 0;
let activeController;
let stopping = false;
const stop = () => { stopping = true; activeController?.abort(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
record('live_monitor.started', { durationSeconds, gapThresholdMs });
const heartbeat = setInterval(() => {
    record('live_monitor.heartbeat', { elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), bytes, gaps, reconnects, stalls });
}, 60_000);

while (!stopping && Date.now() < deadline) {
    const controller = new AbortController();
    activeController = controller;
    const remaining = deadline - Date.now();
    const deadlineTimer = setTimeout(() => controller.abort(), remaining);
    const connectTimer = setTimeout(() => controller.abort(), Math.min(10_000, remaining));
    let stallTimer;
    try {
        const response = await fetch('http://127.0.0.1:9380/live.mp3', { signal: controller.signal });
        clearTimeout(connectTimer);
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        connected = true;
        record('live_monitor.connected');
        const connectedAt = Date.now();
        stallTimer = setInterval(() => {
            const silentMs = Date.now() - (lastPacketAt || connectedAt);
            if (silentMs > 5000) {
                stalls++;
                record('live_monitor.stalled', { silentMs });
                controller.abort();
            }
        }, 1000);
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) throw new Error('stream ended');
            const now = Date.now();
            if (lastPacketAt) {
                const gapMs = now - lastPacketAt;
                maxGapMs = Math.max(maxGapMs, gapMs);
                if (gapMs > gapThresholdMs) {
                    gaps++;
                    record('live_monitor.gap', { gapMs });
                }
            }
            lastPacketAt = now;
            bytes += value.byteLength;
        }
    } catch (error) {
        if (!stopping && Date.now() < deadline) {
            reconnects++;
            record('live_monitor.disconnected', { reason: error instanceof Error ? error.name : 'unknown' });
            lastPacketAt = 0;
            await delay(Math.min(2000, deadline - Date.now()));
        }
    } finally {
        clearTimeout(deadlineTimer);
        clearTimeout(connectTimer);
        if (stallTimer) clearInterval(stallTimer);
        controller.abort();
    }
}

clearInterval(heartbeat);
const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
const completed = !stopping && Date.now() >= deadline;
record('live_monitor.finished', { elapsedSeconds, completed, connected, bytes, gaps, reconnects, stalls, maxGapMs, interrupted: stopping });
console.log(JSON.stringify({ completed, connected, bytes, gaps, reconnects, stalls, maxGapMs, outputPath }));
if (!completed || !connected || bytes === 0 || gaps || reconnects || stalls) process.exitCode = 1;
