

const JST_TIME_ZONE = "Asia/Tokyo";
export const PROJECT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function formatJstDateTime(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new TypeError("A valid Date is required to format a JST timestamp.");
    }

    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: JST_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function parseJstTimestamp(value) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.getTime();
    }
    if (typeof value !== "string" || value.trim() === "") return null;

    const timestamp = value.trim();
    const localDateTime = timestamp.match(
        /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(\.\d+)?)?$/
    );
    const normalized = localDateTime
        ? `${localDateTime[1]}T${localDateTime[2]}:${localDateTime[3] ?? "00"}${localDateTime[4] ?? ""}+09:00`
        : timestamp;
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? null : parsed;
}

export function isProjectRegisteredWithinLast24Hours(value, now = Date.now()) {
    const registeredAt = parseJstTimestamp(value);
    return registeredAt !== null
        && registeredAt <= now
        && now - registeredAt <= PROJECT_MAX_AGE_MS;
}

export default function getFormatedLocalTime() {
    return formatJstDateTime();
}