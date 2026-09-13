import {
    PEAK_MODE,
    SOUND_SET,
    USAGE_MODE,
} from './constants.js'

export const DEFAULT_CONFIG = Object.freeze({
    version: 2,

    scale: 1.5,

    sound: true,
    vol: 0.9,
    soundSet: SOUND_SET.DUCK,

    usageMode: USAGE_MODE.LEDGER,

    peakMode: PEAK_MODE.DEFAULT,

    bubbleOn: true,

    turnCostOn: true,
    turnCostCloseMs: 5000,

    scrollGapOn: false,
    scrollGapPx: 17,
})