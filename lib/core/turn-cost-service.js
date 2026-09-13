import {
    priceFor,
    isPeakTime,
} from '../config/pricing.js'

import { createLogger } from '../utils/logger.js'

const logger = createLogger('turn-cost-service')

/**
 * 单轮消耗统计服务
 */
export class TurnCostService {
    constructor() {
        /**
         * sessionId -> {
         *     turn,
         *     cost,
         *     tokens,
         *     lastTs
         * }
         */
        this.turnAggs = new Map()

        /**
         * 最近一次已经结算的 turn
         */
        this.lastTurn = null

        /**
         * 每次成功结算后递增
         */
        this.lastTurnSeq = 0
    }

    /**
     * 结算指定 session 当前正在统计的 turn
     *
     * @param {string} sessionId
     */
    finalizeTurn(sessionId) {
        const agg = this.turnAggs.get(sessionId)

        if (
            agg && agg.cost > 0
        ) {
            this.lastTurn = {
                turn: agg.turn,
                amount: agg.cost,
                tokens: agg.tokens,
                ts: agg.lastTs,
            }

            this.lastTurnSeq++
        }

        this.turnAggs.delete(
            sessionId,
        )
    }

    /**
     * 读取 Token 数值
     *
     * @param {*} value
     * @returns {number}
     */
    readTokenCount(value) {
        return Number(value) || 0
    }

    /**
     * 处理单个 session/event
     *
     * @param {string} sessionId
     * @param {object} event
     */
    handleSessionEvent(
        sessionId,
        event,
    ) {
        try {
            const type =
                event &&
                event.type

            const data =
                event &&
                event.data

            if (
                !data ||
                typeof data !== 'object'
            ) {
                return
            }

            /**
             * 结算当前 session 的聚合结果
             */
            if (
                type === 'turn/end'
            ) {
                this.finalizeTurn(
                    sessionId,
                )

                return
            }

            /**
             * 只统计 assistant/message
             */
            if (
                type !==
                'assistant/message'
            ) {
                return
            }

            const turn =
                Number(data.turn)

            const usage =
                data.usage

            if (
                !usage ||
                typeof usage !== 'object' ||
                !Number.isFinite(turn)
            ) {
                return
            }

            let agg =
                this.turnAggs.get(
                    sessionId,
                )


            if (
                !agg || agg.turn !== turn
            ) {
                if (agg) {
                    this.finalizeTurn(
                        sessionId,
                    )
                }

                agg = {
                    turn,
                    cost: 0,
                    tokens: 0,
                    lastTs: Date.now(),
                }

                this.turnAggs.set(
                    sessionId,
                    agg,
                )
            }

            const input = this.readTokenCount(
                usage.inputTokens,
            )

            const cache = this.readTokenCount(
                usage.cacheReadTokens,
            )

            const output = this.readTokenCount(
                usage.outputTokens,
            )

            const reasoning = this.readTokenCount(
                usage.reasoningTokens,
            )

            /**
             * 总 Token
             */
            agg.tokens += input + cache + output + reasoning

            /**
             * 根据消息来源模型选择价格
             */
            const model = data.message && data.message.source ? data.message.source.model : ''

            const pricing = priceFor(model)

            const nowSec = Math.floor(
                Date.now() / 1000,
            )

            const priceIndex =
                isPeakTime(nowSec)
                    ? 1
                    : 0

            /**
             * CNY / 1M tokens
             */
            agg.cost +=
                (cache / 1e6) *
                pricing.hit[
                    priceIndex
                    ] +
                (input / 1e6) *
                pricing.miss[
                    priceIndex
                    ] +
                (
                    (output +
                        reasoning) /
                    1e6
                ) *
                pricing.out[
                    priceIndex
                    ]

            agg.lastTs =
                Date.now()
        } catch (err) {
            /**
             * 原项目这里直接吞掉异常
             */
            logger.debug(
                'failed to handle session event:',
                err,
            )
        }
    }

    /**
     * 清理指定 session 的聚合数据
     *
     * @param {string} sessionId
     */
    disposeSession(sessionId) {
        if (!sessionId) {
            return
        }

        this.turnAggs.delete(
            sessionId,
        )
    }

    /**
     * 获取最近一次已经结算的 turn
     *
     * @returns {object|null}
     */
    getLastTurn() {
        if (!this.lastTurn) {
            return null
        }

        return {
            ...this.lastTurn,
        }
    }

    /**
     * 获取最近一次 turn 的序号
     *
     * @returns {number}
     */
    getLastTurnSeq() {
        return this.lastTurnSeq
    }

    /**
     * 获取最近一次 turn 以及序号
     *
     * @returns {object}
     */
    getLastTurnState() {
        return {
            lastTurn:
                this.getLastTurn(),

            lastTurnSeq:
            this.lastTurnSeq,
        }
    }

    /**
     * 清空全部 session 聚合状态
     */
    dispose() {
        this.turnAggs.clear()
    }
}