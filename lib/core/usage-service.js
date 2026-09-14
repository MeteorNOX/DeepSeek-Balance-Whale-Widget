import {
    PLATFORM_USAGE_URL,
    PLATFORM_USAGE_TIMEOUT_MS,
} from '../config/constants.js'

import {
    priceFor,
    isPeakTime,
} from '../config/pricing.js'

import { createLogger } from '../utils/logger.js'

const logger = createLogger('usage-service')

function getLocalDayStartSec(date) {
    return Math.floor(
        new Date(
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
        ).getTime() / 1000,
    )
}

/**
 * DeepSeek Platform 用量服务
 */
export class UsageService {
    /**
     * @param {object} ctx DSH plugin context
     */
    constructor(ctx) {
        this.ctx = ctx
    }

    /**
     * 获取 Platform Token
     *
     * @returns {Promise<string|null>}
     */
    async resolveToken() {
        let cred

        try {
            cred = await this.ctx.credentials.resolve(
                'DEEPSEEK_PLATFORM_TOKEN',
            )
        } catch (err) {
            logger.warn(
                'platform credential resolve failed:',
                err,
            )

            return null
        }

        if (!cred || cred.value == null) {
            return null
        }

        const token = String(cred.value)
            .replace(/^Bearer\s+/i, '')
            .trim()

        return token || null
    }

    /**
     * 获取今天的时间范围
     *
     * @returns {{ start: number, end: number, tz: number }}
     */
    getTodayRange() {
        const now = new Date()

        const tz = -now.getTimezoneOffset() * 60

        const start = getLocalDayStartSec(now)

        const end = start + 86400

        return {
            start,
            end,
            tz,
        }
    }

    /**
     * 构造 Platform usage API URL
     *
     * @returns {string}
     */
    buildUsageUrl() {
        const {
            start,
            end,
            tz,
        } = this.getTodayRange()

        return (
            PLATFORM_USAGE_URL +
            '?start=' +
            start +
            '&end=' +
            end +
            '&tz=' +
            tz
        )
    }

    /**
     * 请求平台 usage 数据
     *
     * @returns {Promise<object>}
     */
    async fetchUsageData() {
        const token = await this.resolveToken()

        if (!token) {
            return {
                ok: false,
                code: 'NO_TOKEN',
                error: '未配置 DEEPSEEK_PLATFORM_TOKEN',
            }
        }

        const url = this.buildUsageUrl()

        try {
            const response = await fetch(url, {
                headers: {
                    Authorization: 'Bearer ' + token,
                },

                signal: AbortSignal.timeout(
                    PLATFORM_USAGE_TIMEOUT_MS,
                ),
            })

            if (!response.ok) {
                return {
                    ok: false,
                    code: 'HTTP',
                    error: 'http ' + response.status,
                }
            }

            let data

            try {
                data = await response.json()
            } catch {
                return {
                    ok: false,
                    code: 'PARSE',
                    error: 'usage 接口返回不是合法 JSON',
                }
            }

            return {
                ok: true,
                data,
            }
        } catch (err) {
            return {
                ok: false,
                code: 'NETWORK',
                error: String(
                    (err && err.message) || err,
                ),
            }
        }
    }

    /**
     * 从 DeepSeek usage API 返回结构中找到 series
     *
     * @param {object} data
     * @returns {Array|null}
     */
    extractSeries(data) {
        let root = data

        if (
            root &&
            root.data &&
            root.data.biz_data &&
            Array.isArray(
                root.data.biz_data.series,
            )
        ) {
            root = root.data.biz_data
        } else if (
            root &&
            root.data &&
            Array.isArray(root.data.series)
        ) {
            root = root.data
        }

        if (
            !root ||
            !Array.isArray(root.series) ||
            root.series.length === 0
        ) {
            return null
        }

        return root.series
    }

    /**
     * 安全读取 Token 数
     *
     * @param {object} usage
     * @param {string} key
     * @returns {number}
     */
    readTokenCount(usage, key) {
        if (
            !usage ||
            typeof usage !== 'object'
        ) {
            return 0
        }

        const value = Number(usage[key])

        return Number.isFinite(value)
            ? value
            : 0
    }

    /**
     * 计算 usage API 返回的今日消费
     *
     * hit  / 1e6 * hit price
     * miss / 1e6 * miss price
     * out  / 1e6 * output price
     *
     * 同时根据 bucket.time 判断峰谷价格
     *
     * @param {object} data
     * @returns {{amount:number,tokens:number}|null}
     */
    computeTodayUsage(data) {
        const series = this.extractSeries(data)

        if (!series) {
            return null
        }

        let cost = 0
        let tokens = 0
        let found = false

        for (const seriesItem of series) {
            if (
                !seriesItem ||
                typeof seriesItem !== 'object'
            ) {
                continue
            }

            const pricing = priceFor(
                seriesItem.model,
            )

            const buckets = Array.isArray(
                seriesItem.buckets,
            )
                ? seriesItem.buckets
                : []

            for (const bucket of buckets) {
                if (
                    !bucket ||
                    typeof bucket !== 'object'
                ) {
                    continue
                }

                const usage = bucket.usage

                if (
                    !usage ||
                    typeof usage !== 'object'
                ) {
                    continue
                }

                const hit =
                    this.readTokenCount(
                        usage,
                        'PROMPT_CACHE_HIT_TOKEN',
                    )

                const miss =
                    this.readTokenCount(
                        usage,
                        'PROMPT_CACHE_MISS_TOKEN',
                    )

                const output =
                    this.readTokenCount(
                        usage,
                        'RESPONSE_TOKEN',
                    )

                if (
                    hit + miss + output === 0
                ) {
                    continue
                }

                found = true

                tokens +=
                    hit +
                    miss +
                    output

                const peak =
                    isPeakTime(bucket.time)

                const priceIndex = peak ? 1 : 0

                cost +=
                    (hit / 1e6) *
                    pricing.hit[priceIndex] +
                    (miss / 1e6) *
                    pricing.miss[priceIndex] +
                    (output / 1e6) *
                    pricing.out[priceIndex]
            }
        }

        if (!found) {
            return null
        }

        return {
            amount: cost,
            tokens,
        }
    }

    /**
     * 获取今日平台消费
     *
     * @returns {Promise<object>}
     */
    async getTodayUsage() {
        const result =
            await this.fetchUsageData()

        if (!result.ok) {
            return result
        }

        const usage =
            this.computeTodayUsage(
                result.data,
            )

        if (!usage) {
            return {
                ok: false,
                code: 'NO_USAGE',
                error: 'no usage',
            }
        }

        return {
            ok: true,
            amount: usage.amount,
            tokens: usage.tokens,
        }
    }
}