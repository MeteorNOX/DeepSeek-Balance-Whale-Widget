package com.whale.deepseek.widget.store;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 应用设置 + 余额缓存（非敏感信息，明文即可）
 * API Key 经 SecretStore 加密存取。
 */
public class Prefs {

    private static final String NAME = "whale_prefs";
    private final SharedPreferences sp;
    private final Context app;

    public Prefs(Context ctx) {
        this.app = ctx.getApplicationContext();
        sp = app.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    /** 供外部注册配置变更监听（实时同步到悬浮窗） */
    public android.content.SharedPreferences getSp() { return sp; }

    // ===== 设置 =====
    public boolean isSoundEnabled() { return sp.getBoolean("sound_enabled", true); }
    public void setSoundEnabled(boolean v) { sp.edit().putBoolean("sound_enabled", v).apply(); }

    public boolean isTeaseEnabled() { return sp.getBoolean("tease_enabled", true); }
    public void setTeaseEnabled(boolean v) { sp.edit().putBoolean("tease_enabled", v).apply(); }

    /** 常驻模式（前台服务） or 轻量模式 */
    public boolean isForegroundMode() { return sp.getBoolean("foreground_mode", false); }
    public void setForegroundMode(boolean v) { sp.edit().putBoolean("foreground_mode", v).apply(); }

    public boolean isAutoStart() { return sp.getBoolean("auto_start", false); }
    public void setAutoStart(boolean v) { sp.edit().putBoolean("auto_start", v).apply(); }

    // ===== 余额缓存 =====
    public double getCachedBalance() { return Double.longBitsToDouble(sp.getLong("cached_balance", Double.doubleToLongBits(-1))); }
    public void setCachedBalance(double v) { sp.edit().putLong("cached_balance", Double.doubleToLongBits(v)).apply(); }

    public long getLastUpdateTime() { return sp.getLong("last_update_time", 0); }
    public void setLastUpdateTime(long v) { sp.edit().putLong("last_update_time", v).apply(); }


    // ===== 悬浮窗内置设置（参照原版） =====
    /** 缩放系数 0.6-2.5（原版 size slider） */
    public float getFloatScale() { return sp.getFloat("float_scale", 1.5f); }
    public void setFloatScale(float v) { sp.edit().putFloat("float_scale", v).apply(); }

    /** 音量 0-1（原版 volume slider） */
    public float getVolume() { return sp.getFloat("volume", 0.8f); }
    public void setVolume(float v) { sp.edit().putFloat("volume", v).apply(); }

    /** 每轮对话消耗弹泡开关（原版 turnCostOn） */
    public boolean isTurnCostEnabled() { return sp.getBoolean("turn_cost_on", true); }
    public void setTurnCostEnabled(boolean v) { sp.edit().putBoolean("turn_cost_on", v).apply(); }

    /** 台词气泡开关（原版 bubbleOn） */
    public boolean isBubbleEnabled() { return sp.getBoolean("bubble_on", true); }
    public void setBubbleEnabled(boolean v) { sp.edit().putBoolean("bubble_on", v).apply(); }

    /** 今日已用显示开关 */
    public boolean isShowToday() { return sp.getBoolean("show_today", true); }
    public void setShowToday(boolean v) { sp.edit().putBoolean("show_today", v).apply(); }

    /** 今日已用（估算耗时消耗，跨天自动重置） */
    public double getTodayCost() {
        long day = (System.currentTimeMillis() / 86400000L);
        if (sp.getLong("today_day", -1) != day) return 0.0;
        return Double.longBitsToDouble(sp.getLong("today_cost", Double.doubleToLongBits(0.0)));
    }
    public void addTodayCost(double cost) {
        long day = (System.currentTimeMillis() / 86400000L);
        double cur = sp.getLong("today_day", -1) == day
                ? Double.longBitsToDouble(sp.getLong("today_cost", Double.doubleToLongBits(0.0)))
                : 0.0;
        sp.edit().putLong("today_day", day).putLong("today_cost", Double.doubleToLongBits(cur + cost)).apply();
    }
    // ===== 真实今日用量：余额差值法（每日首次刷新记录基线，跨天自动重置） =====
    public double getTodayBase() {
        long day = System.currentTimeMillis() / 86400000L;
        if (sp.getLong("base_day", -1) != day) return 0.0;
        return Double.longBitsToDouble(sp.getLong("today_base", Double.doubleToLongBits(0.0)));
    }
    public void setTodayBase(double v) {
        sp.edit().putLong("base_day", System.currentTimeMillis() / 86400000L)
                .putLong("today_base", Double.doubleToLongBits(v)).apply();
    }
    public double getTodayUsed() {
        long day = System.currentTimeMillis() / 86400000L;
        if (sp.getLong("used_day", -1) != day) return 0.0;
        return Double.longBitsToDouble(sp.getLong("today_used", Double.doubleToLongBits(0.0)));
    }
    public void setTodayUsed(double v) {
        sp.edit().putLong("used_day", System.currentTimeMillis() / 86400000L)
                .putLong("today_used", Double.doubleToLongBits(v)).apply();
    }

    // ===== 自定义台词（对齐桌面版 widget-config.js dialogue lines） =====
    private static final String[] DEFAULT_DIALOGUE_LINES = {
            "好模型……好女孩……", "本鱼超棒的！", "今天也要一起加油哦～",
            "压力一只蓝色大肥鱼？！", "坏了……用户彻底怒了！", "DeepSleep……",
            "我去吃饭啦，测完叫我", "哦鲸鲸……", "咕噜咕噜……本鱼在摸鱼",
    };

    public String[] getDialogueLines() {
        String joined = sp.getString("dialogue_lines", null);
        if (joined == null || joined.isEmpty()) return DEFAULT_DIALOGUE_LINES;
        return joined.split("\n");
    }

    public void setDialogueLines(String[] lines) {
        if (lines == null || lines.length == 0) {
            sp.edit().remove("dialogue_lines").apply();
            return;
        }
        StringBuilder sb = new StringBuilder();
        for (String l : lines) sb.append(l).append('\n');
        sp.edit().putString("dialogue_lines", sb.toString()).apply();
    }

    // ===== 眨眼频率（桌面版 blinkIntervalMinSec/MaxSec，默认4~6秒） =====
    public int getBlinkMinSec() { return sp.getInt("blink_min_sec", 4); }
    public void setBlinkMinSec(int v) { sp.edit().putInt("blink_min_sec", Math.max(1, v)).apply(); }
    public int getBlinkMaxSec() { return sp.getInt("blink_max_sec", 6); }
    public void setBlinkMaxSec(int v) { sp.edit().putInt("blink_max_sec", Math.max(1, v)).apply(); }

    // ===== 疲惫模式（桌面版 exhaustedModeEnabled / exhaustedBalanceThreshold） =====
    public boolean isExhaustedEnabled() { return sp.getBoolean("exhausted_enabled", true); }
    public void setExhaustedEnabled(boolean v) { sp.edit().putBoolean("exhausted_enabled", v).apply(); }
    public double getExhaustedThreshold() { return sp.getFloat("exhausted_threshold", 5f); }
    public void setExhaustedThreshold(double v) { sp.edit().putFloat("exhausted_threshold", (float) Math.max(0, v)).apply(); }

    // ===== 台词播放（桌面版 dialogue mode/interval/jitter） =====
    public String getDialogueMode() { return sp.getString("dialogue_mode", "carousel"); }
    public void setDialogueMode(String m) { sp.edit().putString("dialogue_mode", "carousel".equals(m) ? "carousel" : "random").apply(); }
    public int getDialogueIntervalMin() { return sp.getInt("dialogue_interval_min", 5); }
    public void setDialogueIntervalMin(int v) { sp.edit().putInt("dialogue_interval_min", Math.max(1, v)).apply(); }
    public int getDialogueJitterPct() { return sp.getInt("dialogue_jitter_pct", 0); }
    public void setDialogueJitterPct(int v) { sp.edit().putInt("dialogue_jitter_pct", Math.max(0, Math.min(100, v))).apply(); }

    // ===== 颜色（桌面版全局颜色/气泡颜色，0-360色相；默认实为 #536ba9/#203170） =====
    public int getGlobalHue() { return sp.getInt("global_hue", 223); }
    public void setGlobalHue(int v) { sp.edit().putInt("global_hue", ((v % 360) + 360) % 360).apply(); }
    public int getBubbleHue() { return sp.getInt("bubble_hue", 227); }
    public void setBubbleHue(int v) { sp.edit().putInt("bubble_hue", ((v % 360) + 360) % 360).apply(); }
    public void resetColors() { sp.edit().remove("global_hue").remove("bubble_hue").apply(); }

    // ===== API Key（加密） =====
    public boolean hasApiKey() { return SecretStore.has(app, "api_key"); }
    public String getApiKey() { return SecretStore.load(app, "api_key"); }
    public void setApiKey(String key) { SecretStore.save(app, "api_key", key); }
}