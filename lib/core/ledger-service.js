import fs from 'node:fs'

import {
    DATA_CANDIDATES,
} from '../config/paths.js'

import { createLogger } from '../utils/logger.js'

const logger = createLogger('ledger-service')

/**
 * 本地日期键
 *
 * @returns {string}
 */
function todayKey() {
    const date = new Date()

    const pad = (value) =>
        String(value).padStart(2, '0')

    return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate())
    )
}

/**
 * Ledger 服务
 */
export class LedgerService {
    /**
     * @returns {object}
     */
    createEmptyLedger() {
        return {
            date: todayKey(),
            lastBalance: null,
            todayUsage: 0,
            history: {},
        }
    }

    /**
     * 读取 usage ledger
     *
     * @returns {object}
     */
    readUsageLedger() {
        for (
            const filePath
            of DATA_CANDIDATES.usage
            ) {
            try {
                const content =
                    fs.readFileSync(
                        filePath,
                        'utf8',
                    )

                const parsed =
                    JSON.parse(content)

                if (
                    parsed &&
                    typeof parsed === 'object' &&
                    typeof parsed.date === 'string'
                ) {
                    return parsed
                }
            } catch (err) {
                // 保持原逻辑：
                // 当前路径读取失败时继续尝试下一路径
            }
        }

        return this.createEmptyLedger()
    }

    /**
     * 写入 usage ledger
     *
     * @param {object} ledger
     * @returns {boolean}
     */
    writeUsageLedger(ledger) {
        const body =
            JSON.stringify(ledger)

        for (
            const filePath
            of DATA_CANDIDATES.usage
            ) {
            try {
                fs.writeFileSync(
                    filePath,
                    body,
                    'utf8',
                )

                return true
            } catch (err) {
                // 保持原逻辑：
                // 当前路径写入失败时继续尝试下一路径
            }
        }

        return false
    }

    /**
     * 根据余额变化记录消费
     *
     * @param {number} currentBalance
     * @param {string} currency
     * @returns {object}
     */
    recordLedgerUsage(
        currentBalance,
        currency,
    ) {
        const currentDate =
            todayKey()

        const ledger =
            this.readUsageLedger()

        const currentCurrency =
            String(currency || '')

        const currencyChanged =
            typeof ledger.lastCurrency ===
            'string' &&
            ledger.lastCurrency !== '' &&
            currentCurrency !== '' &&
            ledger.lastCurrency !==
            currentCurrency

        /**
         * 跨天
         */
        if (ledger.date !== currentDate) {
            if (
                ledger.date &&
                typeof ledger.todayUsage ===
                'number'
            ) {
                ledger.history =
                    ledger.history || {}

                ledger.history[ledger.date] =
                    ledger.todayUsage
            }

            ledger.date =
                currentDate

            ledger.lastBalance =
                currentBalance

            ledger.lastCurrency =
                currentCurrency

            ledger.todayUsage = 0
        }

        /**
         * 同一天，但币种发生变化
         */
        else if (currencyChanged) {
            ledger.lastBalance =
                currentBalance

            ledger.lastCurrency =
                currentCurrency
        }

        /**
         * 同一天，正常记录余额下降
         */
        else {
            const previousBalance =
                typeof ledger.lastBalance ===
                'number'
                    ? ledger.lastBalance
                    : currentBalance

            if (
                typeof previousBalance ===
                'number' &&
                typeof currentBalance ===
                'number' &&
                currentBalance <
                previousBalance
            ) {
                ledger.todayUsage =
                    (
                        typeof ledger.todayUsage ===
                        'number'
                            ? ledger.todayUsage
                            : 0
                    ) +
                    (
                        previousBalance -
                        currentBalance
                    )
            }

            ledger.lastBalance =
                currentBalance

            ledger.lastCurrency =
                currentCurrency
        }

        /**
         * 最多保留 30 天历史
         */
        const historyKeys =
            Object.keys(
                ledger.history || {},
            ).sort()

        while (
            historyKeys.length > 30
            ) {
            const oldestKey =
                historyKeys.shift()

            delete ledger.history[
                oldestKey
                ]
        }

        this.writeUsageLedger(
            ledger,
        )

        return ledger
    }
}