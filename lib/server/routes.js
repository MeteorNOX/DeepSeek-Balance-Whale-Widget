import { readBody } from './body-parser.js'

const JSON_HEADERS = {
    'Content-Type':
        'application/json; charset=utf-8',

    'Access-Control-Allow-Origin':
        '*',

    'Cache-Control':
        'no-store',
}

/**
 * 注册 JSON API 路由
 *
 * @param {object} ctx
 * @param {object} services
 * @param {import('../core/balance-service.js').BalanceService} services.balanceService
 * @param {import('../core/config-service.js').ConfigService} services.configService
 * @param {import('../core/turn-cost-service.js').TurnCostService} services.turnCostService
 * @returns {Function[]}
 */
export function registerApiRoutes(
    ctx,
    {
        balanceService,
        configService,
        turnCostService,
    },
) {
    const disposers = []

    /**
     * GET /dsh-whale/balance.json
     */
    disposers.push(
        ctx.webServer.register({
            kind: 'exact',

            path:
                '/dsh-whale/balance.json',

            handler: async (
                req,
                res,
            ) => {
                try {
                    const payload =
                        await balanceService.getBalance()

                    res.writeHead(
                        200,
                        JSON_HEADERS,
                    )

                    res.end(
                        JSON.stringify(
                            payload,
                        ),
                    )
                } catch (err) {
                    res.writeHead(
                        200,
                        JSON_HEADERS,
                    )

                    res.end(
                        JSON.stringify({
                            ok: false,
                            code: 'ERROR',
                            error: String(
                                (err &&
                                    err.message) ||
                                err,
                            ).slice(
                                0,
                                200,
                            ),
                        }),
                    )
                }
            },
        }),
    )

    /**
     * GET /dsh-whale/last-turn.json
     */
    disposers.push(
        ctx.webServer.register({
            kind: 'exact',

            path:
                '/dsh-whale/last-turn.json',

            handler: (
                req,
                res,
            ) => {
                const state =
                    turnCostService.getLastTurnState()

                const lastTurn =
                    state.lastTurn

                const lastTurnSeq =
                    state.lastTurnSeq

                const payload =
                    lastTurn
                        ? {
                            ok: true,
                            seq: lastTurnSeq,
                            turn:
                            lastTurn.turn,
                            amount:
                            lastTurn.amount,
                            tokens:
                            lastTurn.tokens,
                            ts: lastTurn.ts,
                        }
                        : {
                            ok: true,
                            seq: 0,
                            turn: null,
                            amount: null,
                            tokens: null,
                            ts: null,
                        }

                res.writeHead(
                    200,
                    JSON_HEADERS,
                )

                res.end(
                    JSON.stringify(
                        payload,
                    ),
                )
            },
        }),
    )

    /**
     * GET /dsh-whale/size.json
     * POST /dsh-whale/size.json
     * PUT  /dsh-whale/size.json
     */
    disposers.push(
        ctx.webServer.register({
            kind: 'exact',

            path:
                '/dsh-whale/size.json',

            handler: async (
                req,
                res,
            ) => {
                if (
                    req.method === 'PUT' ||
                    req.method === 'POST'
                ) {
                    try {
                        const body =
                            await readBody(req)

                        const parsed =
                            JSON.parse(body)

                        const scale =
                            typeof parsed.scale ===
                            'number'
                                ? parsed.scale
                                : null

                        if (scale === null) {
                            res.writeHead(
                                400,
                                JSON_HEADERS,
                            )

                            res.end(
                                JSON.stringify({
                                    ok: false,
                                    error:
                                        'missing scale',
                                }),
                            )

                            return
                        }

                        /**
                         * usageMode 改变时，让余额缓存失效
                         *
                         * 下一次 balance 请求会立即按照新的模式计算
                         */
                        if (
                            typeof parsed.usageMode ===
                            'string'
                        ) {
                            const old =
                                configService.readConfig()

                            if (
                                !old ||
                                configService.normalizeUsageMode(
                                    old.usageMode,
                                ) !==
                                configService.normalizeUsageMode(
                                    parsed.usageMode,
                                )
                            ) {
                                balanceService.clearCache()
                            }
                        }

                        const result =
                            configService.writeConfig(
                                scale,
                                parsed.sound !==
                                false,
                                parsed.vol,
                                parsed.soundSet,
                                parsed.usageMode,
                                parsed.peakMode,
                                parsed.bubbleOn,
                                parsed.turnCostOn,
                                parsed.turnCostCloseMs,
                                parsed.scrollGapOn,
                                parsed.scrollGapPx,
                            )

                        res.writeHead(
                            result.ok
                                ? 200
                                : 500,
                            JSON_HEADERS,
                        )

                        res.end(
                            JSON.stringify(
                                result,
                            ),
                        )
                    } catch (err) {
                        res.writeHead(
                            400,
                            JSON_HEADERS,
                        )

                        res.end(
                            JSON.stringify({
                                ok: false,
                                error: String(
                                    (err &&
                                        err.message) ||
                                    err,
                                ),
                            }),
                        )
                    }

                    return
                }

                res.writeHead(
                    200,
                    JSON_HEADERS,
                )

                res.end(
                    JSON.stringify(
                        configService.readConfig() ||
                        {},
                    ),
                )
            },
        }),
    )

    return disposers
}