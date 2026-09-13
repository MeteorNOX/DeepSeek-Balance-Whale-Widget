import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_DIR =
    path.dirname(
        fileURLToPath(import.meta.url),
    )

const RUNTIME_FILE = path.join(
    FRONTEND_DIR,
    'widget-runtime.js',
)

const STYLES_FILE = path.join(
    FRONTEND_DIR,
    'styles.css',
)

const runtime = fs.readFileSync(
    RUNTIME_FILE,
    'utf8',
)

const styles = fs.readFileSync(
    STYLES_FILE,
    'utf8',
)

const escapedStyles = JSON.stringify(styles)

export const WIDGET_JS =
    `(function () {
    if (window.__dshWhaleWidget) return
    window.__dshWhaleWidget = true

    var styleEl = document.createElement('style')
    styleEl.textContent = ${escapedStyles}
    document.head.appendChild(styleEl)

    ${runtime}

})()`