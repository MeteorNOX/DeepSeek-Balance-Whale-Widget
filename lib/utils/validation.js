/**
 * 转换为有限数字
 *
 * @param {*} value
 * @param {number} fallback
 */
export function toFiniteNumber(

    value,
    fallback = 0,

    ) {
    const number = Number(value)

    return Number.isFinite(number)
        ? number
        : fallback
}

/**
 * 转换为非负数字
 */
export function toNonNegativeNumber(

    value,
    fallback = 0,

    ) {
    const number = toFiniteNumber(
        value,
        fallback,
    )

    return number >= 0
        ? number
        : fallback
}

/**
 * 转换为正整数
 */
export function toPositiveInteger(

    value,
    fallback = 0,

    ) {
    const number = Number(value)

    if (
        !Number.isFinite(number) ||
        number <= 0
    ) {
        return fallback
    }

    return Math.floor(number)
}

/**
 * 限制数字范围
 */
export function clamp(

    value,
    min,
    max,

    ) {
    const number = toFiniteNumber(
        value,
        min,
    )

    return Math.min(
        max,
        Math.max(min, number),
    )
}

/**
 * 判断是否为普通对象
 */
export function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    )
}

/**
 * 安全解析 JSON
 *
 * @param {string} value
 * @param {*} fallback
 */
export function safeJsonParse(

    value,
    fallback = null,

    ) {
    if (typeof value !== 'string') {
        return fallback
    }

    try {
        return JSON.parse(value)
    } catch {
        return fallback
    }
}

/**
 * 安全转换为字符串
 */
export function toString(
    value,
    fallback = '',
) {
    if (
        value === null || value === undefined
    ) {
        return fallback
    }

    return String(value)
}

/**
 * 判断字符串是否非空
 */
export function isNonEmptyString(value) {
    return (
        typeof value === 'string' &&
        value.trim().length > 0
    )
}

/**
 * 安全限制字符串长度
 */
export function truncateString(
    value,
    maxLength,
) {
    const text = toString(value)

    if (text.length <= maxLength) {
        return text
    }

    return text.slice(
        0,
        Math.max(0, maxLength),
    )
}

/**
 * 深度复制普通 JSON 数据用于配置对象等简单数据
 */
export function cloneJson(value) {
    if (value === undefined) {
        return undefined
    }

    try {
        return JSON.parse(
            JSON.stringify(value),
        )
    } catch {
        return null
    }
}