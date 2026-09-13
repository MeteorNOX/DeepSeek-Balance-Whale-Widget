const PREFIX = '[whale-balance-widget]'

function write(

    method,
    ...args

    ) {
    const fn = console[method] || console.log

    fn(PREFIX, ...args)
}

export const logger = {
    debug(...args) {
        write('debug', ...args)
    },

    info(...args) {
        write('info', ...args)
    },

    warn(...args) {
        write('warn', ...args)
    },

    error(...args) {
        write('error', ...args)
    },
}

/**
 * 创建带模块名称的 Logger
 */
export function createLogger(
    moduleName,
    ) {
    const prefix = moduleName ? `[${moduleName}]` : ''

    return {
        debug(...args) {
            write(
                'debug',
                prefix,
                ...args,
            )
        },

        info(...args) {
            write(
                'info',
                prefix,
                ...args,
            )
        },

        warn(...args) {
            write(
                'warn',
                prefix,
                ...args,
            )
        },

        error(...args) {
            write(
                'error',
                prefix,
                ...args,
            )
        },
    }
}