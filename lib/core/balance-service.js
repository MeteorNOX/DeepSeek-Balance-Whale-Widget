import { BALANCE_URL, BALANCE_TTL_MS } from '../config/constants.js'
import { toFiniteNumber } from '../utils/validation.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('balance-service')

/**
 * DeepSeek 余额服务
 */
export class BalanceService {
    /**
     * @param {object} ctx DSH plugin context
     */
    constructor(ctx) {
        this.ctx = ctx

        this.cache = null
        this.inFlight = null
    }

    /**
     * 选择最合适的余额信息。
     *
     * 1. 优先选择 CNY 且余额 > 0
     * 2. 否则选择任意余额 > 0
     * 3. 否则选择 CNY
     * 4. 最后取第一项
     *
     * @param {Array} infos
     * @returns {object|null}
     */
    pickBalanceInfo(infos) {
        if (!Array.isArray(infos) || infos.length === 0) {
            return null
        }

        const getBalance = (item) => {
            if (!item || item.total_balance === undefined) {
                return NaN
            }

            return Number(item.total_balance)
        }

        return (
            infos.find(
                (item) =>
                    item &&
                    item.currency === 'CNY' &&
                    getBalance(item) > 0,
            ) ||
            infos.find(
                (item) =>
                    getBalance(item) > 0,
            ) ||
            infos.find(
                (item) =>
                    item &&
                    item.currency === 'CNY',
            ) ||
            infos[0]
        )
    }

    /**
     * 读取 DeepSeek API Key。
     *
     * @returns {Promise<object>}
     */
    async resolveApiKey() {
        let credential

        try {
            credential = await this.ctx.credentials.resolve(
                'DEEPSEEK_API_KEY',
            )
        } catch (err) {
            return {
                ok: false,
                code: 'NO_KEY',
                error:
                    '凭据读取失败: ' +
                    String((err && err.message) || err).slice(0, 160),
            }
        }

        if (!credential) {
            return {
                ok: false,
                code: 'NO_KEY',
                error: '未配置 DEEPSEEK_API_KEY',
            }
        }

        return {
            ok: true,
            value: credential.value,
        }
    }

    /**
     * 真正请求 DeepSeek 余额接口
     *
     * @returns {Promise<object>}
     */
    async fetchBalance() {
        const credential = await this.resolveApiKey()

        if (!credential.ok) {
            return credential
        }

        let lastError = null

        // 原项目：最多请求 2 次
        for (let attempt = 0; attempt < 2; attempt++) {
            let response

            try {
                response = await fetch(BALANCE_URL, {
                    headers: {
                        Authorization: 'Bearer ' + credential.value,
                    },

                    signal: AbortSignal.timeout(20_000),
                })
            } catch (err) {
                lastError = err

                // 第一次失败后等待 500ms 再重试
                if (attempt === 0) {
                    await this.sleep(500)
                }

                continue
            }

            if (!response.ok) {
                lastError = new Error(
                    'HTTP ' + response.status,
                )

                // 4xx 不重试
                if (response.status < 500) {
                    break
                }

                // 5xx 第一次失败，500ms 后重试
                if (attempt === 0) {
                    await this.sleep(500)
                }

                continue
            }

            let data

            try {
                data = await response.json()
            } catch {
                return {
                    ok: false,
                    code: 'PARSE',
                    error: '余额接口返回不是合法 JSON',
                }
            }

            const info = this.pickBalanceInfo(
                data && data.balance_infos,
            )

            if (
                !info ||
                info.total_balance === undefined
            ) {
                return {
                    ok: false,
                    code: 'SHAPE',
                    error: '余额接口返回结构异常',
                }
            }

            const totalBalance = toFiniteNumber(
                info.total_balance,
            )

            if (totalBalance === null) {
                return {
                    ok: false,
                    code: 'SHAPE',
                    error: '余额接口返回余额数值异常',
                }
            }

            return {
                ok: true,
                totalBalance,
                currency: String(
                    info.currency || 'CNY',
                ),
                updatedAt: new Date().toISOString(),
            }
        }

        const transient = !(
            lastError &&
            /^HTTP 4\d\d/.test(lastError.message)
        )

        return {
            ok: false,
            code: 'HTTP',
            transient,
            error:
                '余额接口请求失败: ' +
                String(
                    (lastError && lastError.message) ||
                    lastError,
                ).slice(0, 200),
        }
    }

    /**
     * 获取余额
     *
     * 包含：
     * - TTL 缓存
     * - in-flight 请求复用
     * - 临时错误使用旧缓存
     *
     * @returns {Promise<object>}
     */
    async getBalance() {
        const now = Date.now()

        // 25 秒内直接使用缓存
        if (
            this.cache &&
            now - this.cache.at < BALANCE_TTL_MS
        ) {
            return this.cache.payload
        }

        // 已经有人正在刷新余额，直接复用这个 Promise
        if (this.inFlight) {
            return this.inFlight
        }

        this.inFlight = this.fetchBalance()
            .then((payload) => {
                if (payload.ok) {
                    this.cache = {
                        at: Date.now(),
                        payload,
                    }

                    return payload
                }

                // 网络/API 临时异常：保留最后一次成功的余额
                if (
                    payload.transient &&
                    this.cache
                ) {
                    return {
                        ...this.cache.payload,
                        stale: true,
                        error: payload.error,
                    }
                }

                // 非临时错误，例如 401/403
                if (!payload.transient) {
                    logger.error(
                        payload.code,
                        payload.error,
                    )
                }

                return payload
            })
            .catch((err) => {
                logger.error(
                    '余额服务异常',
                    err,
                )

                return {
                    ok: false,
                    code: 'ERROR',
                    error:
                        '余额服务异常: ' +
                        String(
                            (err && err.message) || err,
                        ).slice(0, 200),
                }
            })
            .finally(() => {
                this.inFlight = null
            })

        return this.inFlight
    }

    /**
     * 清除余额缓存
     */
    clearCache() {
        this.cache = null
    }

    /**
     * 返回当前缓存
     */
    getCachedBalance() {
        return this.cache
            ? this.cache.payload
            : null
    }

    /**
     * 简单 sleep
     *
     * @param {number} ms
     * @returns {Promise<void>}
     */
    sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms)
        })
    }
}