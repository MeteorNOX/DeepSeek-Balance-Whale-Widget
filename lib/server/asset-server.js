import fs from 'node:fs'

import {
    IMAGE_CANDIDATES,
    GIF_CANDIDATES,
    SOUND_CANDIDATES,
} from '../config/paths.js'

let imageBytes = null
let gifBytes = null

/**
 * 从候选路径中读取小鲸鱼图片
 */
function loadImage() {
    if (imageBytes) {
        return imageBytes
    }

    for (const filePath of IMAGE_CANDIDATES) {
        try {
            const bytes =
                fs.readFileSync(filePath)

            if (
                bytes &&
                bytes.length > 0
            ) {
                imageBytes = bytes
                return bytes
            }
        } catch (err) {}
    }

    throw new Error(
        'whale image not found',
    )
}

/**
 * 从候选路径中读取 rua.gif
 */
function loadGif() {
    if (gifBytes) {
        return gifBytes
    }

    for (const filePath of GIF_CANDIDATES) {
        try {
            const bytes =
                fs.readFileSync(filePath)

            if (
                bytes &&
                bytes.length > 0
            ) {
                gifBytes = bytes
                return bytes
            }
        } catch (err) {}
    }

    throw new Error(
        'rua gif not found',
    )
}

/**
 * 从候选路径中读取音效
 *
 * @param {string[]} candidates
 * @returns {Buffer|null}
 */
function loadSound(candidates) {
    for (const filePath of candidates) {
        try {
            const bytes =
                fs.readFileSync(filePath)

            if (
                bytes &&
                bytes.length > 0
            ) {
                return bytes
            }
        } catch (err) {}
    }

    return null
}

/**
 * 从 URL 查询参数中读取音效组
 */
function soundSetFromUrl(url) {
    try {
        const query = String(url || '')
            .split('?')[1] || ''

        const match =
            /(?:^|&)set=([^&]+)/.exec(
                query,
            )

        return match
            ? decodeURIComponent(
                match[1],
            )
            : ''
    } catch (err) {
        return ''
    }
}

/**
 * 返回音效资源
 */
function serveSound(
    req,
    res,
    candidates,
) {
    const bytes = loadSound(candidates)

    if (!bytes) {
        res.writeHead(404, {
            'Content-Type':
                'text/plain; charset=utf-8',
        })

        res.end(
            'sound unavailable',
        )

        return
    }

    res.writeHead(200, {
        'Content-Type':
            'audio/mpeg',
        'Cache-Control':
            'no-store',
        'Content-Length':
            String(bytes.length),
    })

    res.end(bytes)
}

/**
 * 注册所有静态资源路由
 *
 * @param {object} ctx
 * @param {string} widgetJs
 * @returns {Function[]}
 */
export function registerAssetRoutes(
    ctx,
    widgetJs,
) {
    const disposers = []

    disposers.push(
        ctx.webServer.register({
            kind: 'exact',

            path:
                '/dsh-whale/image.png',

            handler: (req, res) => {
                try {
                    const bytes =
                        loadImage()

                    res.writeHead(200, {
                        'Content-Type':
                            'image/png',
                        'Cache-Control':
                            'no-store',
                        'Content-Length':
                            String(
                                bytes.length,
                            ),
                    })

                    res.end(bytes)
                } catch (err) {
                    res.writeHead(404, {
                        'Content-Type':
                            'text/plain; charset=utf-8',
                    })

                    res.end(
                        'whale image unavailable: ' +
                        String(
                            (err &&
                                err.message) ||
                            err,
                        ),
                    )
                }
            },
        }),
    )

    disposers.push(
        ctx.webServer.register({
            kind: 'exact',

            path:
                '/dsh-whale/rua.gif',

            handler: (req, res) => {
                try {
                    const bytes =
                        loadGif()

                    res.writeHead(200, {
                        'Content-Type':
                            'image/gif',
                        'Cache-Control':
                            'no-store',
                        'Content-Length':
                            String(
                                bytes.length,
                            ),
                    })

                    res.end(bytes)
                } catch (err) {
                    res.writeHead(404, {
                        'Content-Type':
                            'text/plain; charset=utf-8',
                    })

                    res.end(
                        'rua gif unavailable: ' +
                        String(
                            (err &&
                                err.message) ||
                            err,
                        ),
                    )
                }
            },
        }),
    )

    disposers.push(
        ctx.webServer.register({
            kind: 'exact',

            path:
                '/dsh-whale/sound/press.mp3',

            handler: (req, res) => {
                const set =
                    SOUND_CANDIDATES[
                        soundSetFromUrl(
                            req.url,
                        )
                        ] ||
                    SOUND_CANDIDATES.duck

                serveSound(
                    req,
                    res,
                    set.press,
                )
            },
        }),
    )

    disposers.push(
        ctx.webServer.register({
            kind: 'exact',

            path:
                '/dsh-whale/sound/release.mp3',

            handler: (req, res) => {
                const set =
                    SOUND_CANDIDATES[
                        soundSetFromUrl(
                            req.url,
                        )
                        ] ||
                    SOUND_CANDIDATES.duck

                serveSound(
                    req,
                    res,
                    set.release,
                )
            },
        }),
    )

    disposers.push(
        ctx.webServer.register({
            kind: 'exact',

            path:
                '/dsh-whale/widget.js',

            handler: (req, res) => {
                res.writeHead(200, {
                    'Content-Type':
                        'application/javascript; charset=utf-8',
                    'Cache-Control':
                        'no-store',
                })

                res.end(widgetJs)
            },
        }),
    )

    return disposers
}

/**
 * 清理静态资源缓存
 */
export function clearAssetCache() {
    imageBytes = null
    gifBytes = null
}