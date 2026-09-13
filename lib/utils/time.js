/**
 * 时间工具
 *
 * 统一处理：
 * - Unix 时间戳
 * - 日期字符串
 * - 北京时间
 * - 日期键
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 获取当前 Unix 时间（秒）
 */
export function nowSec() {
    return Math.floor(Date.now() / 1000)
}

/**
 * 获取当前 Unix 时间（毫秒）
 */
export function nowMs() {
    return Date.now()
}

/**
 * 将 Unix 秒时间戳转换为 Date
 *
 * @param {number|string} value
 * @returns {Date|null}
 */
export function toDate(value) {
    const timestamp = Number(value)

    if (!Number.isFinite(timestamp)) {
        return null
    }

    return new Date(timestamp * 1000)
}

/**
 * 获取北京时间对应的 Date
 *
 * 返回的 Date 只是用于计算北京时间的日期字段
 * 不代表改变了系统时区
 *
 * @param {number|string} value Unix 秒时间戳
 */
export function toBeijingDate(value) {
    const date = toDate(value)

    if (!date) {
        return null
    }

    return new Date(
        date.getTime() + BEIJING_OFFSET_MS,
    )
}

/**
 * 获取北京时间日期字符串
 *
 * 格式：YYYY-MM-DD
 *
 * @param {number|string} value Unix 秒时间戳
 */
export function getBeijingDateKey(value = nowSec()) {
    const date = toBeijingDate(value)

    if (!date) {
        return ''
    }

    const year = date.getUTCFullYear()
    const month = String(
        date.getUTCMonth() + 1,
    ).padStart(2, '0')

    const day = String(
        date.getUTCDate(),
    ).padStart(2, '0')

    return `${year}-${month}-${day}`
}

/**
 * 获取北京时间小时
 *
 * @param {number|string} value Unix 秒时间戳
 */
export function getBeijingHour(value = nowSec()) {
    const date = toBeijingDate(value)

    if (!date) {
        return NaN
    }

    return date.getUTCHours()
}

/**
 * 获取北京时间星期
 *
 * 0 = 星期日
 * 1 = 星期一
 * ...
 * 6 = 星期六
 *
 * @param {number|string} value Unix 秒时间戳
 */
export function getBeijingDay(value = nowSec()) {
    const date = toBeijingDate(value)

    if (!date) {
        return NaN
    }

    return date.getUTCDay()
}

/**
 * 判断是否为周末
 *
 * @param {number|string} value Unix 秒时间戳
 */
export function isBeijingWeekend(value = nowSec()) {
    const day = getBeijingDay(value)

    return day === 0 || day === 6
}

/**
 * 获取当前日期向前/向后 N 天的日期键
 *
 * @param {string} dateKey YYYY-MM-DD
 * @param {number} offsetDays
 */
export function offsetDateKey(
    dateKey,
    offsetDays,
) {
    if (
        typeof dateKey !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)
    ) {
        return ''
    }

    const [year, month, day] =
        dateKey.split('-').map(Number)

    const date = new Date(
        Date.UTC(year, month - 1, day),
    )

    if (!Number.isFinite(date.getTime())) {
        return ''
    }

    date.setUTCDate(
        date.getUTCDate() +
        Number(offsetDays || 0),
    )

    const y = date.getUTCFullYear()
    const m = String(
        date.getUTCMonth() + 1,
    ).padStart(2, '0')
    const d = String(
        date.getUTCDate(),
    ).padStart(2, '0')

    return `${y}-${m}-${d}`
}

/**
 * 判断日期字符串是否有效
 */
export function isDateKey(value) {
    if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        return false
    }

    const [year, month, day] =
        value.split('-').map(Number)

    const date = new Date(
        Date.UTC(year, month - 1, day),
    )

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    )
}