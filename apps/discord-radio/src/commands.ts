import { SlashCommandBuilder } from 'discord.js';

export const commandData = [
    new SlashCommandBuilder()
        .setName('radio')
        .setDescription('Состояние и управление радиостанцией')
        .addSubcommand(command => command.setName('now').setDescription('Что сейчас в эфире'))
        .addSubcommand(command => command.setName('status').setDescription('Состояние очереди'))
        .addSubcommand(command => command.setName('mine').setDescription('Мои последние заявки и письма'))
        .addSubcommand(command => command.setName('join').setDescription('Подключить радио к вашему голосовому каналу'))
        .addSubcommand(command => command.setName('leave').setDescription('Отключить радио от вашего голосового канала'))
        .addSubcommand(command => command.setName('pause').setDescription('Поставить эфир на паузу'))
        .addSubcommand(command => command.setName('resume').setDescription('Продолжить эфир'))
        .addSubcommand(command => command.setName('skip').setDescription('Пропустить текущий элемент без тишины')
            .addBooleanOption(option => option.setName('force').setDescription('Пропустить немедленно, даже если следующий трек ещё готовится')))
        .addSubcommand(command => command.setName('health').setDescription('Проверить выходы и провайдеры'))
        .addSubcommand(command => command.setName('reload').setDescription('Перепроверить внешние сервисы'))
        .addSubcommand(command =>
            command
                .setName('reject')
                .setDescription('Отклонить заявку')
                .addIntegerOption(option => option.setName('id').setDescription('Номер заявки').setRequired(true).setMinValue(1)),
        )
        .addSubcommand(command =>
            command
                .setName('reject-studio')
                .setDescription('Отклонить ожидающее письмо в студию')
                .addIntegerOption(option => option.setName('id').setDescription('Номер письма').setRequired(true).setMinValue(1)),
        )
        .addSubcommand(command => command.setName('admins').setDescription('Показать назначенных администраторов'))
        .addSubcommand(command => command.setName('admin-add').setDescription('Назначить администратора станции')
            .addUserOption(option => option.setName('user').setDescription('Пользователь Discord').setRequired(true)))
        .addSubcommand(command => command.setName('admin-remove').setDescription('Снять администратора станции')
            .addUserOption(option => option.setName('user').setDescription('Пользователь Discord').setRequired(true))),
    new SlashCommandBuilder()
        .setName('request')
        .setDescription('Заказать музыкальный трек')
        .addStringOption(option => option.setName('query').setDescription('Название, исполнитель или описание').setRequired(true).setMaxLength(300))
        .addStringOption(option => option.setName('dedication').setDescription('Короткое посвящение').setMaxLength(200)),
    new SlashCommandBuilder()
        .setName('studio')
        .setDescription('Передать сообщение в студию')
        .addStringOption(option => option.setName('message').setDescription('Сообщение ведущему').setRequired(true).setMaxLength(500)),
].map(command => command.toJSON());
