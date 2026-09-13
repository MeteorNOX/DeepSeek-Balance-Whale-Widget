import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CURRENT_FILE = fileURLToPath(import.meta.url)

export const PACKAGE_ROOT = path.resolve(
    path.dirname(CURRENT_FILE),
    '../..',
)

export const DSH_HOME =
    process.env.DSH_HOME ||
    path.join(os.homedir(), '.dsh')

export const ASSETS_DIR =
    path.join(PACKAGE_ROOT, 'assets')

export const IMAGE_CANDIDATES = [
    path.join(ASSETS_DIR, 'DSniang1.png'),
    path.join(ASSETS_DIR, 'DSniang02.png'),

    'D:/TestBox/deepseek/DSniang1.png',
    'D:/TestBox/deepseek/DSniang02.png',
    'D:/TestBox/deepseek/skin/DSniang02.png',
]

export const GIF_CANDIDATES = [
    path.join(ASSETS_DIR, 'rua.gif'),

    'D:/TestBox/deepseek/skin/rua.gif',
    'D:/TestBox/deepseek/rua.gif',
]

export const SOUND_CANDIDATES = {
    duck: {
        press: [
            path.join(ASSETS_DIR, 'Ya1.mp3'),
            'D:/TestBox/deepseek/skin/Ya1.mp3',
        ],

        release: [
            path.join(ASSETS_DIR, 'Ya2.mp3'),
            'D:/TestBox/deepseek/skin/Ya2.mp3',
        ],
    },

    fx1: {
        press: [
            path.join(ASSETS_DIR, 'D1.mp3'),
            'D:/TestBox/deepseek/skin/D1.mp3',
        ],

        release: [
            path.join(ASSETS_DIR, 'D2.mp3'),
            'D:/TestBox/deepseek/skin/D2.mp3',
        ],
    },
}

export const DATA_CANDIDATES = {
    config: [
        path.join(DSH_HOME, '.dshw-config.json'),
        path.join(
            DSH_HOME,
            'profiles',
            'web',
            '.dshw-config.json',
        ),

        'D:/TestBox/deepseek/.dshw-config.json',
        'D:/TestBox/deepseek/skin/.dshw-config.json',
    ],

    usage: [
        path.join(DSH_HOME, '.dshw-usage.json'),
        path.join(
            DSH_HOME,
            'profiles',
            'web',
            '.dshw-usage.json',
        ),

        'D:/TestBox/deepseek/.dshw-usage.json',
        'D:/TestBox/deepseek/skin/.dshw-usage.json',
    ],
}