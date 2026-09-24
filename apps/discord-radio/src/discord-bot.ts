import { ActionRowBuilder, Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, StringSelectMenuBuilder, type ChatInputCommandInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { commandData } from './commands.js';
import type { RadioConfig } from './config.js';
import type { MusicProvider, SpeechEngine, Track } from './contracts.js';
import type { RadioDirector } from './director.js';
import type { DiscordOutputFanout } from './discord-fanout.js';
import type { RadioStore } from './storage.js';

const CHOICE_LIFETIME_MS = 120_000;
const CHOICE_PREFIX = 'radio-request:';

type PendingChoice = { guildId: string; userId: string; userName: string; dedication?: string; tracks: Track[]; expiresAt: number };

export class DiscordRadioBot {
    private readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    private readonly activeInteractions = new Set<Promise<void>>();
    private readonly pendingChoices = new Map<string, PendingChoice>();
    private readonly choicesInFlight = new Set<string>();
    private readonly voiceChannels = new Map<string, string>();
    private readonly idleVoiceChannels = new Map<string, string>();
    private readonly autoRejoins = new Map<string, Promise<void>>();
    private readonly voiceCommandTails = new Map<string, Promise<void>>();
    private readonly emptyVoiceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly restoreAbort = new AbortController();
    private readonly initialRestores = new Map<string, { abort: AbortController; task: Promise<void> }>();
    private readonly restoreRetries = new Map<string, { abort: AbortController; task: Promise<void> }>();
    private acceptingInteractions = true;
    private stopTask?: Promise<void>;

    constructor(
        private readonly config: RadioConfig,
        private readonly director: RadioDirector,
        private readonly output: DiscordOutputFanout,
        private readonly store: RadioStore,
        private readonly providers: readonly MusicProvider[],
        private readonly speech: SpeechEngine,
        private readonly restoreWaits: readonly number[] = [1_000, 2_000, 4_000, 8_000, 30_000],
        private readonly interactionGraceMs = 5_000,
    ) {
        this.client.on(Events.InteractionCreate, interaction => {
            if (!this.acceptingInteractions) return;
            const operation = interaction.isChatInputCommand()
                ? this.handle(interaction)
                : interaction.isStringSelectMenu() && interaction.customId.startsWith(CHOICE_PREFIX)
                  ? this.selectRequest(interaction)
                  : undefined;
            if (!operation) return;
            this.activeInteractions.add(operation);
            void operation.then(
                () => this.activeInteractions.delete(operation),
                () => this.activeInteractions.delete(operation),
            );
        });
        this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
            const guildId = newState.guild.id;
            const channelId = this.voiceChannels.get(guildId);
            if (channelId && (oldState.channelId === channelId || newState.channelId === channelId)) {
                this.updateEmptyVoiceTimer(guildId, channelId, newState.guild);
            }
            const idleChannelId = this.idleVoiceChannels.get(guildId);
            if (idleChannelId && newState.channelId === idleChannelId && newState.id !== this.client.user?.id) {
                if (newState.member?.user.bot === false) {
                    this.rejoinForHuman(guildId, idleChannelId, newState.guild, newState.id);
                } else if (!newState.member) {
                    void newState.guild.members.fetch(newState.id).then(member => {
                        if (!member.user.bot && this.idleVoiceChannels.get(guildId) === idleChannelId &&
                            newState.guild.voiceStates.cache.get(newState.id)?.channelId === idleChannelId) {
                            this.rejoinForHuman(guildId, idleChannelId, newState.guild, newState.id);
                        }
                    }).catch(() => undefined);
                }
            }
        });
        this.client.once(Events.ClientReady, ready => {
            console.log(JSON.stringify({ level: 'info', event: 'discord.ready', user: ready.user.id }));
        });
        this.client.on(Events.Error, () => console.error(JSON.stringify({ level: 'error', event: 'discord.error' })));
    }

    async start(): Promise<void> {
        this.restoreAbort.signal.throwIfAborted();
        const rest = new REST({ version: '10' }).setToken(this.config.discord.token);
        await this.awaitStartup(rest.put(Routes.applicationCommands(this.config.discord.clientId), { body: commandData }));
        this.restoreAbort.signal.throwIfAborted();
        const login = this.client.login(this.config.discord.token);
        // Discord's login cannot be cancelled. If it settles after stop(), close its late gateway.
        void login.then(() => { if (this.restoreAbort.signal.aborted) this.client.destroy(); }, () => undefined);
        await this.awaitStartup(login);
        if (!this.client.isReady()) {
            await once(this.client, Events.ClientReady, { signal: AbortSignal.any([this.restoreAbort.signal, AbortSignal.timeout(20_000)]) });
        }
        this.restoreAbort.signal.throwIfAborted();
        await this.awaitStartup(this.restoreOutputs());
    }

    private async awaitStartup<T>(operation: Promise<T>): Promise<T> {
        this.restoreAbort.signal.throwIfAborted();
        return Promise.race([
            operation,
            once(this.restoreAbort.signal, 'abort').then(() => { throw new Error('Discord bot stopped during startup'); }),
        ]);
    }

    stop(): Promise<void> {
        this.stopTask ??= this.stopNow();
        return this.stopTask;
    }

    private async stopNow(): Promise<void> {
        this.acceptingInteractions = false;
        this.pendingChoices.clear();
        this.choicesInFlight.clear();
        for (const timer of this.emptyVoiceTimers.values()) clearTimeout(timer);
        this.emptyVoiceTimers.clear();
        this.voiceChannels.clear();
        this.idleVoiceChannels.clear();
        this.restoreAbort.abort();
        for (const restore of this.initialRestores.values()) restore.abort.abort();
        for (const retry of this.restoreRetries.values()) retry.abort.abort();
        const failures: unknown[] = [];
        try { this.output.stopAll(); } catch (error) { failures.push(error); }
        try { this.client.destroy(); } catch (error) { failures.push(error); }
        const pending = [
            ...this.activeInteractions,
            ...this.autoRejoins.values(),
            ...[...this.initialRestores.values()].map(restore => restore.task),
            ...[...this.restoreRetries.values()].map(retry => retry.task),
        ];
        if (pending.length > 0) {
            const timer = new AbortController();
            try {
                await Promise.race([
                    Promise.allSettled(pending),
                    delay(this.interactionGraceMs, undefined, { signal: timer.signal }),
                ]);
            } finally {
                timer.abort();
            }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Discord bot shutdown failed');
    }

    private async handle(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            if (!interaction.inGuild() || !interaction.guildId) {
                await interaction.reply({ content: 'Радио работает только на сервере.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (interaction.commandName === 'request') await this.request(interaction);
            else if (interaction.commandName === 'studio') await this.studio(interaction);
            else if (interaction.commandName === 'radio') await this.radio(interaction);
        } catch (error) {
            const command = ['request', 'studio', 'radio'].includes(interaction.commandName)
                ? interaction.commandName : 'unknown';
            const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
                && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
            const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,50}$/u.test(error.name) ? error.name : undefined;
            console.error(JSON.stringify({ level: 'error', event: 'discord.command_failed', command,
                ...(status ? { status } : {}), ...(errorName ? { errorName } : {}) }));
            const payload = { content: command === 'studio' || command === 'request'
                ? 'Discord не подтвердил действие. Проверьте /radio mine: если обращение там есть, повторять его не нужно.'
                : 'Операция не выполнена из-за внутренней ошибки. Попробуйте позже или сообщите владельцу станции.',
                flags: MessageFlags.Ephemeral } as const;
            if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: payload.content, components: [] }).catch(() => undefined);
            else if (interaction.replied) await interaction.followUp(payload).catch(() => undefined);
            else await interaction.reply(payload).catch(() => undefined);
        }
    }

    private async request(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await this.director.submitRequest({
            guildId: interaction.guildId!,
            userId: interaction.user.id,
            userName: interaction.user.globalName ?? interaction.user.username,
            isOwner: this.isOwner(interaction),
            query: interaction.options.getString('query', true),
            ...(interaction.options.getString('dedication') ? { dedication: interaction.options.getString('dedication')! } : {}),
        });
        if (result.kind === 'accepted') {
            await interaction.editReply(
                `Заявка #${result.decision.requestId} ${result.decision.duplicateSubmission ? 'уже принята' : 'принята'}: **${result.track.artist} — ${result.track.title}**${result.decision.merged ? ' (объединена с уже ожидающей)' : ''}.`,
            );
        } else if (result.kind === 'choices') {
            const token = randomUUID();
            for (const [key, choice] of this.pendingChoices) if (choice.expiresAt <= Date.now()) this.pendingChoices.delete(key);
            this.pendingChoices.set(token, {
                guildId: interaction.guildId!, userId: interaction.user.id,
                userName: interaction.user.globalName ?? interaction.user.username,
                ...(interaction.options.getString('dedication') ? { dedication: interaction.options.getString('dedication')! } : {}),
                tracks: result.tracks.slice(0, 25), expiresAt: Date.now() + CHOICE_LIFETIME_MS,
            });
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`${CHOICE_PREFIX}${token}`)
                .setPlaceholder('Выберите трек')
                .addOptions(result.tracks.slice(0, 25).map((track, index) => ({
                    label: `${track.artist} — ${track.title}`.slice(0, 100), value: String(index),
                })));
            try {
                await interaction.editReply({ content: 'Найдено несколько треков. Выберите один из списка в течение двух минут.', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
            } catch (error) {
                this.pendingChoices.delete(token);
                throw error;
            }
        } else {
            await interaction.editReply(result.reason);
        }
    }

    private async selectRequest(interaction: StringSelectMenuInteraction): Promise<void> {
        const token = interaction.customId.slice(CHOICE_PREFIX.length);
        try {
            const choice = this.pendingChoices.get(token);
            if (!choice) {
                await interaction.reply({ content: 'Время выбора истекло или заявка уже обработана. Повторите /request.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (choice.expiresAt <= Date.now()) {
                this.pendingChoices.delete(token);
                await interaction.update({ content: 'Время выбора истекло. Повторите /request.', components: [] });
                return;
            }
            if (this.choicesInFlight.has(token)) {
                await interaction.reply({ content: 'Заявка уже обрабатывается.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (choice.userId !== interaction.user.id || choice.guildId !== interaction.guildId) {
                await interaction.reply({ content: 'Этот выбор доступен только автору заявки.', flags: MessageFlags.Ephemeral });
                return;
            }
            const index = Number(interaction.values[0]);
            const track = Number.isInteger(index) ? choice.tracks[index] : undefined;
            if (!track) {
                await interaction.reply({ content: 'Трек не найден в списке. Повторите /request.', flags: MessageFlags.Ephemeral });
                return;
            }
            this.choicesInFlight.add(token);
            await interaction.deferUpdate();
            this.pendingChoices.delete(token);
            const result = await this.director.submitTrackRequest({
                guildId: choice.guildId, userId: choice.userId, userName: choice.userName,
                isOwner: this.isOwner(interaction), track, ...(choice.dedication ? { dedication: choice.dedication } : {}), now: Date.now(),
            });
            await interaction.editReply({
                content: result.kind === 'accepted'
                    ? `Заявка #${result.decision.requestId} ${result.decision.duplicateSubmission ? 'уже принята' : 'принята'}: **${result.track.artist} — ${result.track.title}**${result.decision.merged ? ' (объединена с уже ожидающей)' : ''}.`
                    : result.kind === 'rejected' ? result.reason : 'Не удалось выбрать трек. Повторите /request.',
                components: [],
                allowedMentions: { parse: [] },
            });
        } catch {
            console.error(JSON.stringify({ level: 'error', event: 'discord.command_failed', command: 'request-select' }));
            if (interaction.deferred) await interaction.editReply({ content: 'Не удалось оформить заявку. Попробуйте позже.', components: [] }).catch(() => undefined);
            else if (!interaction.replied) await interaction.reply({ content: 'Не удалось оформить заявку. Попробуйте позже.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
        } finally {
            this.choicesInFlight.delete(token);
        }
    }

    async notifyRequestFailure(recipient: { userId: string }, message: string): Promise<void> {
        const user = await this.client.users.fetch(recipient.userId);
        await user.send(message);
    }

    async notifyHostDecision(recipient: { userId: string }, message: string): Promise<void> {
        await this.notifyRequestFailure(recipient, message);
    }

    private async studio(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const decision = await this.director.submitStudio({
            guildId: interaction.guildId!,
            userId: interaction.user.id,
            userName: interaction.user.globalName ?? interaction.user.username,
            isOwner: this.isOwner(interaction),
            message: interaction.options.getString('message', true),
        });
        await interaction.editReply(decision.accepted
            ? `Письмо #${decision.messageId} ${decision.duplicateSubmission ? 'уже получено студией' : 'принято в студию'}.`
            : decision.reason);
    }

    private async radio(interaction: ChatInputCommandInteraction): Promise<void> {
        const command = interaction.options.getSubcommand(true);
        if (command === 'join' || command === 'leave') {
            if (!this.isOwner(interaction) && this.voiceCommandTails.has(interaction.guildId!)) {
                await interaction.reply({ content: 'Подключение или отключение уже выполняется. Повторите команду через несколько секунд.', flags: MessageFlags.Ephemeral });
                return;
            }
            const acknowledged = interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await this.withGuildVoiceLock(interaction.guildId!, async () => {
                await acknowledged;
                await this.radioAction(interaction, command, true);
            });
            return;
        }
        await this.radioAction(interaction, command, false);
    }

    private async radioAction(interaction: ChatInputCommandInteraction, command: string, alreadyDeferred: boolean): Promise<void> {
        if (command === 'mine') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const entries = this.store.listenerInputs(interaction.user.id, interaction.guildId!, 5);
            const status = (entry: typeof entries[number]): string => {
                if (entry.status === 'fulfilled' || entry.status === 'aired') return 'в эфире';
                if (entry.status === 'rejected') return 'отклонено';
                if (entry.status === 'expired') return 'срок истёк';
                if (entry.hostDecision === 'pending') return 'ведущий решает';
                if (entry.hostDecision === 'defer') return entry.kind === 'request' ? 'запланировано позже (может прозвучать раньше)' : 'отложено';
                return 'ожидает эфира';
            };
            await interaction.editReply(entries.length
                ? `Ваши обращения:\n${entries.map(entry => `${entry.kind === 'request' ? 'Заявка' : 'Письмо'} #${entry.id} — ${status(entry)}`).join('\n')}`
                : 'У вас пока нет заявок или писем на этом сервере.');
            return;
        }
        if (command === 'now' || command === 'status') {
            await interaction.deferReply();
            const status = await this.director.status();
            const current = status.current?.track ? `${status.current.track.artist} — ${status.current.track.title}` : 'тишина';
            const mode = { starting: 'запуск', playing: 'в эфире', paused: 'пауза', degraded: 'сбои', stopped: 'остановлено' }[status.mode];
            await interaction.editReply({
                content: command === 'now'
                        ? `Сейчас в эфире: **${current}**. Ведущий: **${status.host?.id ?? 'назначается'}**.`
                        : `Режим: **${mode}**. Ведущий: **${status.host?.id ?? 'назначается'}**. Сейчас: **${current}**. Программа: **${status.showPlan?.theme ?? 'формируется'}** (${status.showPlan?.source === 'model' ? 'организатор' : 'резерв'}). Готово к эфиру: ${status.readyTracks}, всего ожидают: ${status.queued}; заявок: ${status.pendingRequests}, писем: ${status.pendingStudioMessages}.`,
                allowedMentions: { parse: [] },
            });
            return;
        }
        if (command === 'admin-add' || command === 'admin-remove' || command === 'admins') {
            if (!this.isRootOwner(interaction)) {
                await interaction.reply({ content: 'Назначать администраторов может только владелец станции.', flags: MessageFlags.Ephemeral });
                return;
            }
            if (!alreadyDeferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (command === 'admins') {
                const admins = this.store.listStationAdmins();
                await interaction.editReply(admins.length ? `Администраторы: ${admins.join(', ')}` : 'Назначенных администраторов нет.');
                return;
            }
            const user = interaction.options.getUser('user', true);
            if (this.config.discord.ownerIds.has(user.id)) {
                await interaction.editReply('Владелец уже имеет постоянный полный доступ.');
                return;
            }
            if (user.bot) {
                await interaction.editReply('Нельзя назначить бот-аккаунт администратором станции.');
                return;
            }
            const changed = command === 'admin-add'
                ? this.store.grantStationAdmin(user.id, interaction.user.id)
                : this.store.revokeStationAdmin(user.id);
            await interaction.editReply(changed
                ? `${command === 'admin-add' ? 'Администратор назначен' : 'Администратор снят'}: ${user.id}.`
                : `${command === 'admin-add' ? 'Уже назначен администратором' : 'Не был администратором'}: ${user.id}.`);
            return;
        }
        if (command !== 'join' && command !== 'leave' && !this.isOwner(interaction)) {
            await interaction.reply({ content: 'Эта команда доступна только администратору станции.', flags: MessageFlags.Ephemeral });
            return;
        }
        if (!alreadyDeferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (command !== 'join' && command !== 'leave' && !this.isOwner(interaction)) {
            await interaction.editReply('Доступ администратора был отозван.');
            return;
        }
        if (command === 'join') {
            const guildId = interaction.guildId!;
            const member = await interaction.guild!.members.fetch(interaction.user.id);
            if (this.restoreAbort.signal.aborted) return;
            const channel = member.voice.channel;
            if (!channel) {
                await interaction.editReply('Сначала войдите в голосовой канал.');
                return;
            }
            const activeChannel = this.voiceChannels.get(guildId);
            if (!this.isOwner(interaction) && activeChannel && activeChannel !== channel.id) {
                await interaction.editReply('Радио уже играет в другом канале этого сервера. Переключить его может администратор.');
                return;
            }
            const idleChannel = this.idleVoiceChannels.get(guildId);
            const savedChannel = this.store.guildOutputs?.().find(item => item.guildId === guildId)?.channelId;
            let connected = false;
            let committed = false;
            try {
                await this.cancelAutoRejoin(guildId);
                if (this.restoreAbort.signal.aborted) return;
                await this.cancelRestoreRetry(guildId);
                if (this.restoreAbort.signal.aborted) return;
                const currentMember = await interaction.guild!.members.fetch(interaction.user.id);
                if (currentMember.voice.channelId !== channel.id ||
                    (!this.isOwner(interaction) && activeChannel && activeChannel !== channel.id)) {
                    await interaction.editReply('Голосовой канал или права изменились; повторите команду.');
                    return;
                }
                connected = true;
                await this.output.connectGuild(guildId, channel.id, interaction.guild!.voiceAdapterCreator);
                if (this.restoreAbort.signal.aborted) return;
                const afterConnect = await interaction.guild!.members.fetch(interaction.user.id);
                if (afterConnect.voice.channelId !== channel.id ||
                    (!this.isOwner(interaction) && activeChannel && activeChannel !== channel.id)) {
                    await interaction.editReply('Голосовой канал или права изменились во время подключения; повторите команду.');
                    return;
                }
                this.store.saveGuildOutput(guildId, channel.id, true);
                this.voiceChannels.set(guildId, channel.id);
                this.updateEmptyVoiceTimer(guildId, channel.id, interaction.guild!);
                committed = true;
                await interaction.editReply(`Радио подключено к ${channel.name}.`);
            } finally {
                if (!committed) {
                    if (connected) {
                        this.clearEmptyVoiceTimer(guildId);
                        this.voiceChannels.delete(guildId);
                        if (!activeChannel) this.output.stopGuild(guildId);
                    }
                    if (!this.restoreAbort.signal.aborted) {
                        if (idleChannel) this.idleVoiceChannels.set(guildId, idleChannel);
                        if (connected && activeChannel) {
                            try {
                                await this.output.connectGuild(guildId, activeChannel, interaction.guild!.voiceAdapterCreator);
                                this.store.saveGuildOutput(guildId, activeChannel, true);
                                this.voiceChannels.set(guildId, activeChannel);
                                this.updateEmptyVoiceTimer(guildId, activeChannel, interaction.guild!);
                            } catch {
                                this.output.stopGuild(guildId);
                                this.store.saveGuildOutput(guildId, activeChannel, false);
                                this.scheduleRestoreRetry({ guildId, channelId: activeChannel });
                            }
                        } else if (savedChannel && !idleChannel && !this.voiceChannels.has(guildId)) {
                            this.store.saveGuildOutput(guildId, savedChannel, false);
                            this.scheduleRestoreRetry({ guildId, channelId: savedChannel });
                        }
                    }
                }
            }
        } else if (command === 'leave') {
            const guildId = interaction.guildId!;
            if (!this.isOwner(interaction)) {
                const member = await interaction.guild!.members.fetch(interaction.user.id);
                const channelId = this.voiceChannels.get(guildId) ?? this.idleVoiceChannels.get(guildId);
                if (!channelId || member.voice.channelId !== channelId) {
                    await interaction.editReply('Отключить радио может слушатель из его голосового канала или администратор.');
                    return;
                }
            }
            const previousIdle = this.idleVoiceChannels.get(guildId);
            const savedChannel = this.store.guildOutputs?.().find(item => item.guildId === guildId)?.channelId;
            let committed = false;
            try {
                await this.cancelAutoRejoin(guildId);
                await this.cancelRestoreRetry(guildId);
                if (this.restoreAbort.signal.aborted) return;
                if (!this.isOwner(interaction)) {
                    const member = await interaction.guild!.members.fetch(interaction.user.id);
                    const channelId = this.voiceChannels.get(guildId) ?? previousIdle;
                    if (!channelId || member.voice.channelId !== channelId) {
                        await interaction.editReply('Голосовой канал или права изменились; повторите команду из канала радио.');
                        return;
                    }
                }
                this.output.stopGuild(guildId);
                this.clearEmptyVoiceTimer(guildId);
                this.voiceChannels.delete(guildId);
                this.store.saveGuildOutput(guildId, 'disabled', false);
                committed = true;
                await interaction.editReply('Радио отключено от этого сервера.');
            } finally {
                if (!committed && !this.restoreAbort.signal.aborted) {
                    if (previousIdle) this.idleVoiceChannels.set(guildId, previousIdle);
                    if (savedChannel && !previousIdle && !this.voiceChannels.has(guildId)) {
                        this.scheduleRestoreRetry({ guildId, channelId: savedChannel });
                    }
                }
            }
        } else if (command === 'pause') {
            await interaction.editReply(this.director.pause() ? 'Эфир приостановлен.' : 'Сейчас нечего приостанавливать.');
        } else if (command === 'resume') {
            await interaction.editReply(this.director.resume() ? 'Эфир продолжен.' : 'Эфир не был на паузе.');
        } else if (command === 'skip') {
            const result = await this.director.skip(interaction.options.getBoolean('force') === true);
            await interaction.editReply(result === 'skipped' ? 'Текущий элемент пропущен.'
                : result === 'preparing' ? 'Следующий трек ещё готовится. Оставляю текущий в эфире, чтобы не было тишины. Для немедленного пропуска используйте force.'
                  : 'Сейчас нечего пропускать.');
        } else if (command === 'reject') {
            const id = interaction.options.getInteger('id', true);
            await interaction.editReply((await this.director.rejectRequest(id)) ? `Заявка #${id} отклонена.` : `Активная заявка #${id} не найдена.`);
        } else if (command === 'reject-studio') {
            const id = interaction.options.getInteger('id', true);
            await interaction.editReply((await this.director.rejectStudioMessage(id)) ? `Письмо #${id} отклонено.` : `Письмо #${id} уже звучит, обработано или не найдено.`);
        } else if (command === 'health' || command === 'reload') {
            const providerHealth = await Promise.all(this.providers.map(async provider => ({ name: provider.name, ...(await provider.health()) })));
            const speech = await this.speech.health();
            const outputs = this.output.health();
            const pendingRestores = new Set([...this.initialRestores.keys(), ...this.restoreRetries.keys()]);
            const lines = [
                ...providerHealth.map(item => `${item.name}: ${item.ok ? 'ok' : 'degraded'} (${item.detail})`),
                `tts: ${speech.ok ? 'ok' : 'degraded'} (${speech.detail})`,
                ...outputs.map(item => `discord:${item.guildId}: ${item.connected ? 'ok' : 'reconnecting'} (${item.detail ?? 'unknown'})`),
                ...[...pendingRestores].filter(guildId => !outputs.some(item => item.guildId === guildId))
                    .map(guildId => `discord:${guildId}: reconnecting (guild lookup)`),
            ];
            await interaction.editReply(lines.length ? lines.join('\n') : 'Внешние сервисы не настроены; станция работает с ограничениями.');
        }
    }

    private isRootOwner(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction): boolean {
        return this.config.discord.ownerIds.has(interaction.user.id);
    }

    private isOwner(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction): boolean {
        return this.isRootOwner(interaction) || this.store.isStationAdmin?.(interaction.user.id) === true;
    }

    private async withGuildVoiceLock(guildId: string, work: () => Promise<void>): Promise<void> {
        const previous = this.voiceCommandTails.get(guildId) ?? Promise.resolve();
        let release!: () => void;
        const tail = new Promise<void>(resolve => { release = resolve; });
        this.voiceCommandTails.set(guildId, tail);
        await previous;
        try {
            await work();
        } finally {
            release();
            if (this.voiceCommandTails.get(guildId) === tail) this.voiceCommandTails.delete(guildId);
        }
    }

    private clearEmptyVoiceTimer(guildId: string): void {
        const timer = this.emptyVoiceTimers.get(guildId);
        if (timer) clearTimeout(timer);
        this.emptyVoiceTimers.delete(guildId);
    }

    private async cancelAutoRejoin(guildId: string): Promise<void> {
        this.idleVoiceChannels.delete(guildId);
        const task = this.autoRejoins.get(guildId);
        if (task) await task;
    }

    private rejoinForHuman(guildId: string, channelId: string, guild: NonNullable<ChatInputCommandInteraction['guild']>, humanId: string): void {
        if (this.restoreAbort.signal.aborted || this.autoRejoins.has(guildId)) return;
        if (guild.voiceStates.cache.get(humanId)?.channelId !== channelId) return;
        const task = (async () => {
            try {
                await this.output.connectGuild(guildId, channelId, guild.voiceAdapterCreator);
                const hasHuman = await this.hasHumanVoiceState(guild, channelId);
                if (this.restoreAbort.signal.aborted || this.idleVoiceChannels.get(guildId) !== channelId ||
                    hasHuman === false) {
                    this.output.stopGuild(guildId);
                    return;
                }
                this.store.saveGuildOutput(guildId, channelId, true);
                this.idleVoiceChannels.delete(guildId);
                this.voiceChannels.set(guildId, channelId);
                this.updateEmptyVoiceTimer(guildId, channelId, guild);
            } catch {
                console.error(JSON.stringify({ level: 'warn', event: 'discord.auto_rejoin_failed', guildId }));
            }
        })();
        this.autoRejoins.set(guildId, task);
        void task.finally(() => {
            if (this.autoRejoins.get(guildId) === task) this.autoRejoins.delete(guildId);
        });
    }

    private async hasHumanVoiceState(guild: NonNullable<ChatInputCommandInteraction['guild']>, channelId: string): Promise<boolean | undefined> {
        const states = guild.voiceStates?.cache;
        if (!states) return undefined;
        const botId = this.client.user?.id;
        for (const state of states.values()) {
            if (state.channelId !== channelId || state.id === botId) continue;
            if (state.member?.user.bot === false) return true;
            if (state.member?.user.bot === true) continue;
            try {
                const member = await Promise.race([
                    guild.members.fetch(state.id),
                    delay(5_000).then(() => { throw new Error('voice member lookup timeout'); }),
                ]);
                if (!member.user.bot && states.get(state.id)?.channelId === channelId) return true;
            } catch {
                return undefined;
            }
        }
        return false;
    }

    private updateEmptyVoiceTimer(guildId: string, channelId: string, guild: NonNullable<ChatInputCommandInteraction['guild']>): void {
        this.clearEmptyVoiceTimer(guildId);
        if (this.restoreAbort.signal.aborted || this.voiceChannels.get(guildId) !== channelId) return;
        const botId = this.client.user?.id;
        const hasKnownHuman = guild.voiceStates?.cache?.some(state =>
            state.channelId === channelId && state.id !== botId && state.member?.user.bot === false) ?? false;
        if (hasKnownHuman) return;
        const timer = setTimeout(() => {
            void (async () => {
                if (this.restoreAbort.signal.aborted || this.voiceChannels.get(guildId) !== channelId || this.emptyVoiceTimers.get(guildId) !== timer) return;
                try {
                    const channel = await guild.channels.fetch(channelId);
                    if (this.restoreAbort.signal.aborted || this.voiceChannels.get(guildId) !== channelId || this.emptyVoiceTimers.get(guildId) !== timer) return;
                    const botId = this.client.user?.id;
                    const states = guild.voiceStates?.cache;
                    const knownHuman = states?.some(state =>
                        state.channelId === channelId && state.id !== botId && state.member?.user.bot === false) ?? false;
                    if (knownHuman || (channel?.isVoiceBased() && channel.members.some(member => !member.user.bot))) {
                        this.clearEmptyVoiceTimer(guildId);
                        return;
                    }
                    // A cached empty member list alone is not proof that the gateway has synced voice states.
                    // Our own voice state must be visible before retiring a guild output.
                    const botPresent = botId && states?.get(botId)?.channelId === channelId;
                    if (!channel?.isVoiceBased() || !botPresent) {
                        this.clearEmptyVoiceTimer(guildId);
                        this.updateEmptyVoiceTimer(guildId, channelId, guild);
                        return;
                    }
                    const unknownStates = [...states.values()].filter(state =>
                        state.channelId === channelId && state.id !== botId && !state.member);
                    for (const state of unknownStates) {
                        const member = await Promise.race([
                            guild.members.fetch(state.id),
                            delay(5_000).then(() => { throw new Error('voice member lookup timeout'); }),
                        ]);
                        if (member.user.bot) continue;
                        this.clearEmptyVoiceTimer(guildId);
                        return;
                    }
                    if (this.restoreAbort.signal.aborted || this.voiceChannels.get(guildId) !== channelId || this.emptyVoiceTimers.get(guildId) !== timer) return;
                    this.clearEmptyVoiceTimer(guildId);
                    this.voiceChannels.delete(guildId);
                    this.output.stopGuild(guildId);
                    this.idleVoiceChannels.set(guildId, channelId);
                    this.store.saveGuildOutput(guildId, channelId, false);
                } catch {
                    this.clearEmptyVoiceTimer(guildId);
                    console.error(JSON.stringify({ level: 'warn', event: 'discord.empty_voice_check_failed', guildId }));
                    if (!this.restoreAbort.signal.aborted && this.voiceChannels.get(guildId) === channelId) {
                        this.updateEmptyVoiceTimer(guildId, channelId, guild);
                    }
                }
            })();
        }, 180_000);
        timer.unref();
        this.emptyVoiceTimers.set(guildId, timer);
    }

    private async restoreOutputs(): Promise<void> {
        await Promise.all(this.store.guildOutputs().slice(0, this.config.discord.maxGuilds).map(async saved => {
            const abort = new AbortController();
            const task = (async () => {
                if (!(await this.restoreOutput(saved, abort.signal))) this.scheduleRestoreRetry(saved);
            })();
            const restore = { abort, task };
            this.initialRestores.set(saved.guildId, restore);
            try {
                await task;
            } finally {
                if (this.initialRestores.get(saved.guildId) === restore) this.initialRestores.delete(saved.guildId);
            }
        }));
    }

    private async restoreOutput(saved: { guildId: string; channelId: string }, signal: AbortSignal): Promise<boolean> {
        let guild;
        try {
            const timer = new AbortController();
            try {
                guild = await Promise.race([
                    this.client.guilds.fetch(saved.guildId),
                    delay(10_000, undefined, { signal: AbortSignal.any([signal, timer.signal]) }).then(() => { throw new Error('guild lookup timeout'); }),
                ]);
            } finally {
                timer.abort();
            }
        } catch (error) {
            if (signal.aborted) return true;
            this.store.saveGuildOutput(saved.guildId, saved.channelId, false);
            this.logRestoreFailure(saved.guildId, 'lookup', error);
            return false;
        }
        if (signal.aborted) return true;
        try {
            await this.output.connectGuild(saved.guildId, saved.channelId, guild.voiceAdapterCreator);
        } catch (error) {
            if (signal.aborted) return true;
            this.store.saveGuildOutput(saved.guildId, saved.channelId, false);
            this.logRestoreFailure(saved.guildId, 'voice', error);
            // Admission may fail before fanout registers a desired output (for example, at maxGuilds).
            return this.output.health().some(item => item.guildId === saved.guildId);
        }
        if (signal.aborted) {
            this.output.stopGuild(saved.guildId);
            return true;
        }
        this.store.saveGuildOutput(saved.guildId, saved.channelId, true);
        this.idleVoiceChannels.delete(saved.guildId);
        this.voiceChannels.set(saved.guildId, saved.channelId);
        this.updateEmptyVoiceTimer(saved.guildId, saved.channelId, guild);
        return true;
    }

    private scheduleRestoreRetry(saved: { guildId: string; channelId: string }): void {
        if (this.restoreAbort.signal.aborted || this.restoreRetries.has(saved.guildId)) return;
        const abort = new AbortController();
        const task = (async () => {
            for (let attempt = 0; !abort.signal.aborted; attempt++) {
                try {
                    await delay(this.restoreWaits[Math.min(attempt, this.restoreWaits.length - 1)]!, undefined, { signal: abort.signal });
                } catch {
                    return;
                }
                if (abort.signal.aborted || await this.restoreOutput(saved, abort.signal)) return;
            }
        })();
        const retry = { abort, task };
        this.restoreRetries.set(saved.guildId, retry);
        void task.then(
            () => { if (this.restoreRetries.get(saved.guildId) === retry) this.restoreRetries.delete(saved.guildId); },
            error => {
                if (this.restoreRetries.get(saved.guildId) === retry) this.restoreRetries.delete(saved.guildId);
                this.logRestoreFailure(saved.guildId, 'retry', error);
            },
        );
    }

    private async cancelRestoreRetry(guildId: string): Promise<void> {
        const initial = this.initialRestores.get(guildId);
        if (initial) initial.abort.abort();
        const retry = this.restoreRetries.get(guildId);
        if (retry) retry.abort.abort();
        await Promise.allSettled([initial?.task, retry?.task].filter((task): task is Promise<void> => Boolean(task)));
    }

    private logRestoreFailure(guildId: string, phase: string, error: unknown): void {
        const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
        console.error(JSON.stringify({ level: 'warn', event: 'discord.restore_failed', guildId, phase, ...(status ? { status } : {}) }));
    }
}
