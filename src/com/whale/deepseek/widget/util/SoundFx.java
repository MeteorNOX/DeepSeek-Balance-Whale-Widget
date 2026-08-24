package com.whale.deepseek.widget.util;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.SoundPool;

import com.whale.deepseek.widget.R;

/**
 * 音效：按压Q弹(d1/d2)、台词气泡(ya1/ya2)，支持音量调节
 */
public class SoundFx {

    private SoundPool pool;
    private int sD1, sD2, sYa1, sYa2;
    private boolean loaded;
    private float volume = 0.8f;

    public SoundFx(Context ctx) {
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        pool = new SoundPool.Builder().setMaxStreams(4).setAudioAttributes(attrs).build();
        pool.setOnLoadCompleteListener((sp, sampleId, status) -> loaded = true);
        sD1 = pool.load(ctx, R.raw.d1, 1);
        sD2 = pool.load(ctx, R.raw.d2, 1);
        sYa1 = pool.load(ctx, R.raw.ya1, 1);
        sYa2 = pool.load(ctx, R.raw.ya2, 1);
    }

    public void setVolume(float v) { this.volume = v; }

    public void playPress() {
        if (!loaded) return;
        pool.play(Math.random() < 0.5 ? sD1 : sD2, volume, volume, 1, 0, 1f);
    }

    public void playBubble() {
        if (!loaded) return;
        pool.play(Math.random() < 0.5 ? sYa1 : sYa2, volume, volume, 1, 0, 1f);
    }

    /** 释放/轻点音效（桌面版 duck = Ya1/Ya2） */
    public void playRelease() {
        if (!loaded) return;
        pool.play(Math.random() < 0.5 ? sYa1 : sYa2, volume, volume, 1, 0, 1f);
    }

    public void release() {
        if (pool != null) {
            pool.release();
            pool = null;
        }
    }
}
