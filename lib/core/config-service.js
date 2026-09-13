import fs from 'node:fs'

import {
    DATA_CANDIDATES,
} from '../config/paths.js'

import { createLogger } from '../utils/logger.js'

const logger = createLogger('config-service')

/**
 * 配置服务
 * 文件：.dshw-size.json
 */
export class ConfigService {
    /**
     * 规范化用量统计模式
     *
     * @param {*} value
     * @returns {'token'|'ledger'}
     */
    normalizeUsageMode(value) {
        return value === 'token'
            ? 'token'
            : 'ledger'
    }

    /**
     * 规范化峰谷价格模式
     *
     * @param {*} value
     * @returns {'default'|'liangwen'|'qiangqiang'}
     */
    normalizePeakMode(value) {
        return (
            value === 'liangwen' ||
            value === 'qiangqiang'
        )
            ? value
            : 'default'
    }

    /**
     * 读取配置文件
     *
     * @returns {object|null}
     */
    readConfig() {
        for (
            const filePath
            of DATA_CANDIDATES.config
            ) {
            try {
                const parsed =
                    JSON.parse(
                        fs.readFileSync(
                            filePath,
                            'utf8',
                        ),
                    )

                if (
                    parsed &&
                    typeof parsed === 'object' &&
                    typeof parsed.scale ===
                    'number'
                ) {
                    return {
                        scale: parsed.scale,

                        sound:
                            parsed.sound !== false,

                        vol:
                            typeof parsed.vol ===
                            'number'
                                ? parsed.vol
                                : 0.9,

                        soundSet:
                            parsed.soundSet ===
                            'fx1'
                                ? 'fx1'
                                : 'duck',

                        usageMode:
                            this.normalizeUsageMode(
                                parsed.usageMode,
                            ),

                        peakMode:
                            this.normalizePeakMode(
                                parsed.peakMode,
                            ),

                        bubbleOn:
                            parsed.bubbleOn !==
                            false,

                        turnCostOn:
                            parsed.turnCostOn !==
                            false,

                        turnCostCloseMs:
                            typeof parsed.turnCostCloseMs ===
                            'number'
                                ? parsed.turnCostCloseMs
                                : 5000,

                        scrollGapOn:
                            parsed.scrollGapOn ===
                            true,

                        scrollGapPx:
                            typeof parsed.scrollGapPx ===
                            'number'
                                ? Math.round(
                                    parsed.scrollGapPx,
                                )
                                : 17,
                    }
                }
            } catch (err) {
                // 当前路径读取失败时继续尝试下一路径
            }
        }

        return null
    }

    /**
     * 写入配置文件
     *
     * @param {number} scale
     * @param {boolean} sound
     * @param {number} vol
     * @param {string} soundSet
     * @param {string} usageMode
     * @param {string} peakMode
     * @param {boolean} bubbleOn
     * @param {boolean} turnCostOn
     * @param {number} turnCostCloseMs
     * @param {boolean} scrollGapOn
     * @param {number} scrollGapPx
     * @returns {object}
     */
    writeConfig(
        scale,
        sound,
        vol,
        soundSet,
        usageMode,
        peakMode,
        bubbleOn,
        turnCostOn,
        turnCostCloseMs,
        scrollGapOn,
        scrollGapPx,
    ) {
        const normalizedUsageMode =
            this.normalizeUsageMode(
                usageMode,
            )

        const normalizedPeakMode =
            this.normalizePeakMode(
                peakMode,
            )

        const normalizedBubbleOn =
            bubbleOn !== false

        const normalizedTurnCostOn =
            turnCostOn !== false

        const normalizedTurnCostCloseMs =
            typeof turnCostCloseMs ===
            'number'
                ? turnCostCloseMs > 0
                    ? turnCostCloseMs
                    : 0
                : 5000

        const normalizedScrollGapOn =
            scrollGapOn === true

        const normalizedScrollGapPx =
            typeof scrollGapPx ===
            'number' &&
            scrollGapPx > 0
                ? Math.round(scrollGapPx)
                : 0

        const normalizedSound =
            sound !== false

        const normalizedVol =
            typeof vol === 'number'
                ? vol
                : 0.9

        const normalizedSoundSet =
            soundSet === 'fx1'
                ? 'fx1'
                : 'duck'

        const body =
            JSON.stringify({
                scale,

                sound:
                normalizedSound,

                vol:
                normalizedVol,

                soundSet:
                normalizedSoundSet,

                usageMode:
                normalizedUsageMode,

                peakMode:
                normalizedPeakMode,

                bubbleOn:
                normalizedBubbleOn,

                turnCostOn:
                normalizedTurnCostOn,

                turnCostCloseMs:
                normalizedTurnCostCloseMs,

                scrollGapOn:
                normalizedScrollGapOn,

                scrollGapPx:
                normalizedScrollGapPx,

                updatedAt:
                    new Date().toISOString(),
            })

        for (
            const filePath
            of DATA_CANDIDATES.config
            ) {
            try {
                fs.writeFileSync(
                    filePath,
                    body,
                    'utf8',
                )

                return {
                    ok: true,

                    scale,

                    sound:
                    normalizedSound,

                    vol:
                    normalizedVol,

                    soundSet:
                    normalizedSoundSet,

                    usageMode:
                    normalizedUsageMode,

                    peakMode:
                    normalizedPeakMode,

                    bubbleOn:
                    normalizedBubbleOn,

                    turnCostOn:
                    normalizedTurnCostOn,

                    turnCostCloseMs:
                    normalizedTurnCostCloseMs,

                    scrollGapOn:
                    normalizedScrollGapOn,

                    scrollGapPx:
                    normalizedScrollGapPx,
                }
            } catch (err) {
                // 当前路径写入失败时继续尝试下一路径。
            }
        }

        logger.warn(
            'failed to persist widget config',
        )

        return {
            ok: false,
            error: '无法持久化挂件尺寸',
        }
    }
}