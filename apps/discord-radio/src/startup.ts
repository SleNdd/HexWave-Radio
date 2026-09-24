import type { Server } from 'node:http';

interface RadioStartup {
    bot: { start(): Promise<void>; stop(): Promise<void> };
    director: { start(): void; stop(): Promise<void> };
    store: { close(): void };
    listen: () => Promise<Server>;
}

export async function startRadioRuntime({ bot, director, store, listen }: RadioStartup): Promise<Server> {
    try {
        await bot.start();
        director.start();
        return await listen();
    } catch (error) {
        await Promise.allSettled([director.stop(), bot.stop()]);
        try {
            store.close();
        } catch {
            // Preserve the startup failure as the primary diagnostic.
        }
        throw error;
    }
}

export async function stopRadioRuntime({ bot, director, store, server }: Omit<RadioStartup, 'listen'> & { server: Server }): Promise<void> {
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
    const stoppingBot = bot.stop();
    void stoppingBot.catch(() => undefined);
    const server = await startup.catch(() => undefined);
    if (server) {
        await stopRadioRuntime({ bot, director, store, server });
    } else {
        await stoppingBot;
    }
}
