import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

interface RadioStartup {
    bot: { start(): Promise<void>; stop(): Promise<void> };
    director: { start(): void; stop(): Promise<void> };
    store: { close(): void };
    listen: () => Promise<Server>;
}

interface BotStartupTask {
    abort: AbortController;
    task: Promise<void>;
}

const botStartupTasks = new WeakMap<RadioStartup['bot'], BotStartupTask>();
const stoppingBots = new WeakSet<RadioStartup['bot']>();

function startDiscordInBackground(bot: RadioStartup['bot']): void {
    const abort = new AbortController();
    const task = (async () => {
        for (let attempt = 0; !abort.signal.aborted; attempt++) {
            try {
                await bot.start();
                return;
            } catch (error) {
                if (abort.signal.aborted) return;
                const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
                if (status === 401) {
                    console.error(JSON.stringify({ level: 'error', event: 'discord.start.failed', reason: 'unauthorized' }));
                    return;
                }
                const waitMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
                console.warn(JSON.stringify({ level: 'warn', event: 'discord.start.retry', waitMs }));
                try { await delay(waitMs, undefined, { signal: abort.signal }); } catch { return; }
            }
        }
    })();
    botStartupTasks.set(bot, { abort, task });
}

function cancelDiscordStartup(bot: RadioStartup['bot']): Promise<void> {
    const startup = botStartupTasks.get(bot);
    startup?.abort.abort();
    botStartupTasks.delete(bot);
    return startup?.task ?? Promise.resolve();
}

export async function startRadioRuntime({ bot, director, store, listen }: RadioStartup): Promise<Server> {
    try {
        director.start();
        const server = await listen();
        if (!stoppingBots.has(bot)) startDiscordInBackground(bot);
        return server;
    } catch (error) {
        stoppingBots.add(bot);
        const botStartup = cancelDiscordStartup(bot);
        await Promise.allSettled([director.stop(), bot.stop()]);
        await botStartup;
        try {
            store.close();
        } catch {
            // Preserve the startup failure as the primary diagnostic.
        }
        throw error;
    }
}

export async function stopRadioRuntime({ bot, director, store, server }: Omit<RadioStartup, 'listen'> & { server: Server }): Promise<void> {
    stoppingBots.add(bot);
    const botStartup = cancelDiscordStartup(bot);
    const failures: unknown[] = [];
    const failedSteps: string[] = [];
    const steps: Array<{ name: string; stop: () => Promise<void> | void }> = [
        { name: 'director', stop: () => director.stop() },
        { name: 'discord', stop: () => bot.stop() },
        { name: 'health', stop: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))) },
        { name: 'sqlite', stop: () => store.close() },
    ];
    const recordFailure = (step: { name: string }, error: unknown): void => {
        failures.push(error);
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        failedSteps.push(typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/u.test(code) ? `${step.name}[${code}]` : step.name);
    };
    const teardown = await Promise.allSettled(steps.slice(0, 2).map(step => Promise.resolve().then(step.stop)));
    await botStartup;
    teardown.forEach((result, index) => {
        if (result.status === 'rejected') recordFailure(steps[index]!, result.reason);
    });
    for (const step of steps.slice(2)) {
        try { await step.stop(); } catch (error) { recordFailure(step, error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Radio shutdown failed: ${failedSteps.join(', ')}`);
}

export async function stopRadioRuntimeDuringStartup(
    { bot, director, store }: Omit<RadioStartup, 'listen'>,
    startup: Promise<Server>,
): Promise<void> {
    // Release startup's REST/login wait immediately; rollback or regular shutdown closes the rest.
    stoppingBots.add(bot);
    const botStartup = cancelDiscordStartup(bot);
    const stoppingBot = bot.stop();
    void stoppingBot.catch(() => undefined);
    const server = await startup.catch(() => undefined);
    if (server) {
        await stopRadioRuntime({ bot, director, store, server });
    } else {
        await stoppingBot;
    }
    await botStartup;
}
