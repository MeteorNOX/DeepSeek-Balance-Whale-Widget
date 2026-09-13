const BASE_PRICE = Object.freeze({
    hit: [0.05, 0.1],
    miss: [1.5, 3.0],
    out: [4.5, 9.0],
})

const PRO_PRICE = Object.freeze({
    hit: [0.15, 0.3],
    miss: [4.5, 9.0],
    out: [13.5, 27.0],
})

export const PRICING = Object.freeze({
    'deepseek-v4-flash-vision-exp': BASE_PRICE,

    'deepseek-v4-flash': BASE_PRICE,

    'deepseek-v4-pro': PRO_PRICE,

    'deepseek-chat': BASE_PRICE,

    'deepseek-reasoner': BASE_PRICE,

    _default: BASE_PRICE,
})

export const PEAK_HOURS = Object.freeze([
    [9, 12],
    [14, 18],
])

/*
 * 北京时间：
 *
 * 工作日：
 *   09:00 - 12:00
 *   14:00 - 18:00
 *
 * 2026-08-23 起：
 *   周六、周日全天谷价
 */
export const WEEKEND_VALLEY_FROM_SEC =
    Math.floor(
        Date.UTC(
            2026,
            7,
            22,
            16,
            0,
            0,
        ) / 1000,
    )

export function priceFor(model) {
    const name = String(model || '').toLowerCase()

    for (const key of Object.keys(PRICING)) {
        if (key === '_default') continue

        if (name.includes(key)) {
            return PRICING[key]
        }
    }

    return PRICING._default
}

export function isPeakTime(timeSec) {
    if (!Number.isFinite(Number(timeSec))) {
        return false
    }

    const timestamp = Number(timeSec)

    const beijingDate = new Date(
        timestamp * 1000 +
        8 * 60 * 60 * 1000,
    )

    if (timestamp >= WEEKEND_VALLEY_FROM_SEC) {
        const day = beijingDate.getUTCDay()

        if (day === 0 || day === 6) {
            return false
        }
    }

    const hour = beijingDate.getUTCHours()

    for (const [start, end] of PEAK_HOURS) {
        if (hour >= start && hour < end) {
            return true
        }
    }

    return false
}

export function calculateTokenCost({
                                       model,
                                       inputTokens = 0,
                                       cacheReadTokens = 0,
                                       outputTokens = 0,
                                       reasoningTokens = 0,
                                       timeSec = Math.floor(Date.now() / 1000),
                                   }) {
    const price = priceFor(model)

    const peakIndex = isPeakTime(timeSec) ? 1 : 0

    const input = Number(inputTokens) || 0
    const cache = Number(cacheReadTokens) || 0
    const output = Number(outputTokens) || 0
    const reasoning = Number(reasoningTokens) || 0

    const cacheCost =
        (cache / 1_000_000) *
        price.hit[peakIndex]

    const inputCost =
        (input / 1_000_000) *
        price.miss[peakIndex]

    const outputCost =
        ((output + reasoning) / 1_000_000) *
        price.out[peakIndex]

    return cacheCost + inputCost + outputCost
}