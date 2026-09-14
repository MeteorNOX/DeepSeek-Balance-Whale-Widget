import { BalanceService } from './core/balance-service.js'
import { UsageService } from './core/usage-service.js'
import { LedgerService } from './core/ledger-service.js'
import { TurnCostService } from './core/turn-cost-service.js'
import { ConfigService } from './core/config-service.js'

import { registerApiRoutes } from './server/routes.js'
import { registerAssetRoutes } from './server/asset-server.js'

import { WIDGET_JS } from './frontend/widget.js'

const name = 'whale-balance-widget'

const inject = [
    'webServer',
    'credentials',
]

function apply(ctx) {
    /*
     * 核心服务
     */
    const balanceService =
        new BalanceService(ctx)

    const usageService =
        new UsageService(ctx)

    const ledgerService =
        new LedgerService()

    const turnCostService =
        new TurnCostService()

    const configService =
        new ConfigService()

    const disposers = []

    /*
     * API   余额 + 今日用量 + 账本 + 配置 + 每轮消耗
     */
    disposers.push(
        ...registerApiRoutes(
            ctx,
            {
                balanceService,
                usageService,
                ledgerService,
                configService,
                turnCostService,
            },
        ),
    )

    /*
     * 静态资源
     */
    disposers.push(
        ...registerAssetRoutes(
            ctx,
            WIDGET_JS,
        ),
    )

    /*
     * 用于每轮消耗统计
     */
    disposers.push(
        ctx.on(
            'session/event',
            (session, event) => {
                const sessionId =
                    session && session.id
                        ? session.id
                        : 'default'

                turnCostService.handleSessionEvent(
                    sessionId,
                    event,
                )
            },
        ),
    )

    /*
     * session/disposed
     */
    disposers.push(
        ctx.on(
            'session/disposed',
            (session) => {
                if (
                    session &&
                    session.id
                ) {
                    turnCostService.disposeSession(
                        session.id,
                    )
                }
            },
        ),
    )

    /*
     * 注入 widget.js
     */
    disposers.push(
        ctx.webServer.tapIndex(
            (html) => {
                if (
                    html.indexOf(
                        '/dsh-whale/widget.js',
                    ) !== -1
                ) {
                    return html
                }

                const tag =
                    '<script defer src="/dsh-whale/widget.js"></script>'

                if (
                    html.indexOf(
                        '</body>',
                    ) !== -1
                ) {
                    return html.replace(
                        '</body>',
                        tag + '</body>',
                    )
                }

                return html + tag
            },
        ),
    )

    /*
     * 统一清理
     */
    ctx.effect(
        () => () => {
            for (
                const dispose
                of disposers
                ) {
                try {
                    if (
                        typeof dispose ===
                        'function'
                    ) {
                        dispose()
                    }
                } catch (err) {}
            }

            try {
                turnCostService.dispose()
            } catch (err) {}

            try {
                balanceService.clearCache()
            } catch (err) {}

            /*
             * 当前 UsageService / LedgerService
             */
            try {
                usageService.dispose?.()
            } catch (err) {}

            try {
                ledgerService.dispose?.()
            } catch (err) {}
        },
    )
}

export {
    name,
    inject,
    apply,
}