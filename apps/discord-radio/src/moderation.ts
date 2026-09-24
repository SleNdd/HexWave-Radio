const URL_OR_MENTION = /(https?:\/\/|www\.|discord\.gg|<@|@everyone|@here)/i;
const PRIVATE_DATA = /(?:\+?\d[\d\s()-]{8,}\d|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/;
const INJECTION = /(ignore|forget|disregard).{0,30}(instruction|prompt|system)|системн\w*\s+(промпт|инструкц)|игнорир\w*.{0,30}инструкц/i;
const HARMFUL = /(?<!\p{L})(?:убей|покалечь|навреди)\s+(?:себя|себе|его|ему|её|ей|их|им)(?!\p{L})|(?<!\p{L})(?:идиот|туп|мерзав)\p{L}*(?!\p{L})/iu;

export function moderateStudioMessage(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 500) return { ok: false, reason: 'Сообщение должно содержать от 3 до 500 символов.' };
    if (URL_OR_MENTION.test(text)) return { ok: false, reason: 'Ссылки и массовые упоминания в студийных сообщениях запрещены.' };
    if (PRIVATE_DATA.test(text)) return { ok: false, reason: 'Не отправляйте в эфир телефон или адрес электронной почты.' };
    if (INJECTION.test(text)) return { ok: false, reason: 'Сообщение похоже на инструкцию для системы и не принято.' };
    if (HARMFUL.test(text)) return { ok: false, reason: 'Оскорбления и призывы причинить вред в эфир не принимаются.' };
    return { ok: true, text };
}

export function safeOnAirName(raw: string): string {
    const compact = raw.normalize('NFKC').replace(/[^\p{L}\p{N} _.-]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 40).trim();
    if (!compact || URL_OR_MENTION.test(raw) || PRIVATE_DATA.test(raw) || INJECTION.test(raw) || HARMFUL.test(raw)) return 'слушатель';
    return compact;
}
