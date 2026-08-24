package com.whale.deepseek.widget;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

import com.whale.deepseek.widget.api.DeepSeekApi;
import com.whale.deepseek.widget.api.DeepSeekApi.BalanceInfo;
import com.whale.deepseek.widget.store.Prefs;
import com.whale.deepseek.widget.util.SoundFx;

import java.util.Random;

/**
 * 悬浮窗服务（对齐原版）: 默认右下角 / 1/4磁吸 / 整窗镜像 / 60s刷新 / 提示语
 */
public class WhaleFloatService extends Service {

    private static final String TAG = "WhaleFloatService";
    private static final String CHANNEL_ID = "whale_float";
    private static final int NOTIFY_ID = 1001;
    private static final long REFRESH_INTERVAL = 60_000L;

    private WindowManager wm;
    private WhaleFloatView floatView;
    private WindowManager.LayoutParams lp;
    private Runnable positionLock;
    private Prefs prefs;
    private android.content.SharedPreferences.OnSharedPreferenceChangeListener prefsListener;
    private SoundFx sound;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Random random = new Random();

    private double lastBalance = -1;
    private boolean refreshing = false;
    private boolean dragging = false;

        // ===== 桌面版表情状态机字段 =====
    private String mood = "normal"; // normal|angry|disappointed|shy|exhausted
    private long lastInteractTime = 0;
    private final java.util.ArrayList<Long> clickLog = new java.util.ArrayList<>();
    private int whaleClickStep = 0;
    private long lastWhaleClickAt = 0;

    private static final long ANGRY_MS = 5000;            // 生气持续
    private static final long IDLE_TO_DISAPPOINTED_MS = 3 * 60 * 1000; // 3分钟无交互→失落
    private static final long LONELY_CAROUSEL_MS = 30000; // 失落语录轮播
    private static final long HOVER_TO_SHY_MS = 1500;     // 按住1.5s→害羞
    private static final long SHY_MS = 10000;             // 害羞持续
    private static final double EXHAUSTED_THRESHOLD = 5;  // 余额<5→疲惫
    private static final int HIGH_FREQ_WARN = 5, HIGH_FREQ_COUNT = 18;
    private static final long HIGH_FREQ_WINDOW_MS = 10000, HIGH_FREQ_GAP_MS = 500;

    private static final String[] LONELY_LINES = {
            "主人不理我，好寂寞…", "喵…都不看本鲸一眼…", "等了你好久好久…",
            "尾巴都垂下来了…", "罐头不香了吗…", "你忘了本鲸在这里了吗…",
            "太阳落山了，你还没来…", "连呼噜都没力气…", "本鲸趴门口等了好久…",
            "你鼠标路过也不摸我…", "喵…本鲸心里空空的…", "窗台好冷，主人不在…",
            "我给空气翻肚皮…", "本鲸叫了三声，没人应…", "你的影子都走了…",
            "本鲸的人生突然好灰暗…", "你连本鲸尾巴尖都没碰过…", "主人…本鲸还在等你回家呢。",
    };
    private static final String[] EXHAUSTED_LINES = {
            "额度快见底了，省着点花喵…", "本鲸已经有点转不动了…", "余额薄得像尾巴尖了…",
            "再这样下去要喝西北风啦…", "我闻到贫穷的海风了喵。", "今天先克制一点点，好吗？",
            "钱包在打喷嚏，是真的。", "余额快瘦成一条线了…", "本鲸的工作餐要保不住了。",
            "别再连点了，额度会哭的。", "这个数额，看着有点心慌…", "再冲动消费，本鲸就躺平了。",
            "现在适合精打细算模式。", "我已经自动切到省电表情了。", "先缓一缓，明天再战也行。",
            "余额这么低，本鲸都不敢翻身。", "这点额度，只够我眨两次眼…", "理智一点，别让账单追上来。",
            "本鲸建议你先补充一点预算。", "再不回点血，就真要疲惫了喵。",
    };
    private static final String[] DIALOGUE_LINES = {
            "好模型……好女孩……", "本鱼超棒的！", "今天也要一起加油哦～",
            "压力一只蓝色大肥鱼？！", "坏了……用户彻底怒了！", "DeepSleep……",
            "我去吃饭啦，测完叫我", "哦鲸鲸……", "咕噜咕噜……本鱼在摸鱼",
    };
    private int lonelyIndex = 0, exhaustedIndex = 0;

    private final Runnable idleToDisappointed = this::enterDisappointed;
    private final Runnable lonelyCarousel = this::nextLonelyLine;
    private final Runnable shyTimeout = this::enterShyFromHold;
    private final Runnable shyRelease = () -> {
        if ("shy".equals(mood)) exitShy(false);
    };
    private final Runnable angryRelease = () -> {
        if ("angry".equals(mood)) exitAngry();
    };

    private static final String[][] LINES = {
            {"今天也要一起加油哦～", "1.0"},
            {"余额还够呢，放心聊！", "1.0"},
            {"咕噜咕噜……本鱼在摸鱼", "0.8"},
            {"饿饿，想吃小饼干", "0.6"},
            {"最新余额已刷新～", "0.5"},
            {"今天花了多少呀？", "0.5"},
    };

    private static final String[] TEASE = {
            "呜哇！余额少了！谁花的！",
            "你花钱好快……本鱼心疼",
            "叮——余额-¥%s，月光预警！",
            "省着点花呀，不然本鱼要饿死了",
    };

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = new Prefs(this);
        sound = new SoundFx(this);
        sound.setVolume(prefs.getVolume());
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        if (prefs.isForegroundMode()) {
            startForeground(NOTIFY_ID, buildNotification());
        }
        createFloatWindow();
        refreshBalance(true);
        handler.postDelayed(refreshTask, REFRESH_INTERVAL);
        scheduleNextDialogue();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getStringExtra("action"))) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(positionLock);
        handler.removeCallbacks(refreshTask);
        handler.removeCallbacks(dialogueAuto);
        if (prefsListener != null && prefs != null) prefs.getSp().unregisterOnSharedPreferenceChangeListener(prefsListener);
        if (floatView != null && wm != null) {
            try { wm.removeView(floatView); } catch (Exception ignored) {}
        }
        if (sound != null) sound.release();
        super.onDestroy();
        Log.i(TAG, "service destroyed");
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ========== 悬浮窗 ==========

    /** 桌面版公式: 窗口逻辑边长 = (250 × scale).clamp(122, 625) -> px */
    private int computeBasePx() {
        float dm = getResources().getDisplayMetrics().density;
        float scale = prefs.getFloatScale();
        float logic = Math.max(122f, Math.min(250f * scale, 625f));
        return (int) (logic * dm + 0.5f);
    }

    private void createFloatWindow() {
        try { if (floatView != null && floatView.isAttachedToWindow()) return; } catch (Exception ignored) {}
        floatView = new WhaleFloatView(this);
        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        int base = computeBasePx();
        lp = new WindowManager.LayoutParams(
                base, base,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        // 原版默认位置：right:0;bottom:0（右下角）
        Point sz = new Point();
        wm.getDefaultDisplay().getSize(sz);
        lp.x = Math.max(0, sz.x - base - dp(8));
        lp.y = Math.max(0, sz.y - base - dp(24));
        floatView.setBasePx(base);
        // 桌面版 widget-config：眨眼频率 + 颜色配置
        floatView.setBlinkInterval(prefs.getBlinkMinSec(), prefs.getBlinkMaxSec());
        floatView.setColorHue(prefs.getGlobalHue(), prefs.getBubbleHue());

        floatView.setOnTouchListener(touchListener);
        floatView.setMenuListener(new WhaleFloatView.MenuListener() {
            @Override public void onRefresh() { refreshBalance(true); floatView.showBubble("刷新中……"); }
            @Override public void onChat() { startActivity(new Intent(WhaleFloatService.this, ChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            @Override public void onSettings() { startActivity(new Intent(WhaleFloatService.this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            @Override public void onHide() { stopSelf(); }
        });
        floatView.setSettingListener(new WhaleFloatView.SettingListener() {
            @Override public void onScaleChanged(float s) {
                prefs.setFloatScale(s);
                rebaseWindow();
            }
            @Override public void onVolumeChanged(float v) {
                prefs.setVolume(v);
                if (sound != null) sound.setVolume(v);
            }
            @Override public void onSoundChanged(boolean on) { prefs.setSoundEnabled(on); }
            @Override public void onTeaseChanged(boolean on) { prefs.setTeaseEnabled(on); }
            @Override public void onCostChanged(boolean on) { prefs.setTurnCostEnabled(on); }
            @Override public void onBubbleChanged(boolean on) { prefs.setBubbleEnabled(on); }
            @Override public void onKeySaved(String key) {
                if (key != null && key.startsWith("sk-")) {
                    prefs.setApiKey(key);
                    refreshBalance(true);
                    floatView.showBubble("Key 已保存～");
                } else if (key != null && !key.isEmpty()) {
                    floatView.showBubble("Key 应以 sk- 开头");
                }
            }
            @Override public void onModeChanged(boolean foreground) {
                prefs.setForegroundMode(foreground);
                if (foreground) {
                    stopSelf();
                    startForegroundService(new Intent(WhaleFloatService.this, WhaleFloatService.class));
                }
            }
        });

        floatView.setBubbleStateListener(open -> {
            // 气泡已内嵌主窗口，无需独立窗口（原版一体布局）
        });

        try {
            wm.addView(floatView, lp);
            Log.i(TAG, "float window added base=" + base);
            positionLock = new Runnable() {
                @Override public void run() {
                    if (dragging) { handler.postDelayed(this, 600); return; }
                    try { if (floatView != null && floatView.isAttachedToWindow()) wm.updateViewLayout(floatView, lp); } catch (Exception ignored) {}
                    handler.postDelayed(this, 600);
                }
            };
            handler.postDelayed(positionLock, 300);
        } catch (Exception e) {
            Log.e(TAG, "addView failed", e);
        }

        // 配置实时监听
        prefsListener = (sp, key) -> {
            if ("float_scale".equals(key)) {
                handler.post(() -> rebaseWindow());
            } else if ("volume".equals(key)) {
                handler.post(() -> { if (sound != null) sound.setVolume(prefs.getVolume()); });
            } else if ("dialogue_interval_min".equals(key) || "dialogue_jitter_pct".equals(key)
                    || "dialogue_mode".equals(key) || "dialogue_lines".equals(key)) {
                handler.post(() -> { handler.removeCallbacks(dialogueAuto); scheduleNextDialogue(); });
            } else if ("blink_min_sec".equals(key) || "blink_max_sec".equals(key)) {
                handler.post(() -> { if (floatView != null) floatView.setBlinkInterval(prefs.getBlinkMinSec(), prefs.getBlinkMaxSec()); });
            } else if ("global_hue".equals(key) || "bubble_hue".equals(key)) {
                handler.post(() -> { if (floatView != null) floatView.setColorHue(prefs.getGlobalHue(), prefs.getBubbleHue()); });
            }
        };
        prefs.getSp().registerOnSharedPreferenceChangeListener(prefsListener);
        double cached = prefs.getCachedBalance();
        if (cached > 0) lastBalance = cached;
    }

    /** scale 变更 -> 重新计算 base 并更新窗口尺寸（保持锚定边距不变，对齐原版 settle()） */
    private void rebaseWindow() {
        if (floatView == null || lp == null) return;
        try {
            int base = computeBasePx();
            Point sz = new Point();
            wm.getDefaultDisplay().getSize(sz);
            int oldW = lp.width, oldH = lp.height;
            // 原版 settle(): 右锚 -> 保持右缘距不变; 左锚 -> 保持左缘; 均 clamp 进屏
            if (lp.x + oldW >= sz.x - lp.x) {
                // 更靠右：保持右缘距
                lp.x = Math.max(0, sz.x - base - (sz.x - lp.x - oldW));
            } else {
                // 更靠左：保持左缘
                lp.x = Math.max(0, Math.min(sz.x - base, lp.x));
            }
            if (lp.y + oldH >= sz.y - lp.y) {
                lp.y = Math.max(0, sz.y - base - (sz.y - lp.y - oldH));
            } else {
                lp.y = Math.max(0, Math.min(sz.y - base, lp.y));
            }
            lp.width = base;
            lp.height = base;
            floatView.setBasePx(base);
            wm.updateViewLayout(floatView, lp);
        } catch (Exception ignored) {}
    }

    private final View.OnTouchListener touchListener = new View.OnTouchListener() {
        private int startX, startY;
        private float touchX, touchY;
        private boolean moving = false;
        private long downTime = 0;

        @Override
        public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: {
                    // 气泡区域不响应（桌面版 bubble 不响应点击）
                    float y = e.getY();
                    boolean inBubble = floatView.isBubbleOpen() && y <= floatView.getBubbleHeightPx();
                    if (inBubble) return true;
                    if (!floatView.isTouchingWhale(e.getX(), e.getY())) return false;
                    startX = lp.x;
                    startY = lp.y;
                    touchX = e.getRawX();
                    touchY = e.getRawY();
                    moving = false;
                    downTime = System.currentTimeMillis();
                    // 桌面版: 按下 -> 按压图 + Q弹 + 音效；按住1.5s转害羞
                    floatView.startPress();
                    floatView.pressAnim();
                    if (prefs.isSoundEnabled()) sound.playPress();
                    handler.removeCallbacks(shyTimeout);
                    handler.postDelayed(shyTimeout, HOVER_TO_SHY_MS);
                    resetIdle();
                    return true;
                }
                case MotionEvent.ACTION_MOVE: {
                    int dx = (int) (e.getRawX() - touchX);
                    int dy = (int) (e.getRawY() - touchY);
                    if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) {
                        moving = true;
                        handler.removeCallbacks(shyTimeout);
                    }
                    if (moving) {
                        dragging = true;
                        Point sz = new Point();
                        wm.getDefaultDisplay().getSize(sz);
                        int maxX = Math.max(0, sz.x - lp.width);
                        int maxY = Math.max(0, sz.y - lp.height);
                        lp.x = Math.max(0, Math.min(maxX, startX + dx));
                        lp.y = Math.max(0, Math.min(maxY, startY + dy));
                        try { wm.updateViewLayout(floatView, lp); } catch (Exception ignored) {}
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP: {
                    handler.removeCallbacks(shyTimeout);
                    floatView.endPress();
                    if (prefs.isSoundEnabled()) sound.playRelease();
                    if (moving) {
                        dragging = false;
                        snapToEdge();
                    } else if (System.currentTimeMillis() - downTime < 800) {
                        whaleTap();
                    }
                    resetIdle();
                    return true;
                }
                case MotionEvent.ACTION_CANCEL: {
                    handler.removeCallbacks(shyTimeout);
                    floatView.endPress();
                    if (moving) { dragging = false; snapToEdge(); }
                    resetIdle();
                    return true;
                }
            }
            return false;
        }
    };

    private void snapToEdge() {
        Point size = new Point();
        wm.getDefaultDisplay().getSize(size);
        int screenW = size.x;
        int screenH = size.y;
        int cx = lp.x + lp.width / 2;
        int cy = lp.y + lp.height / 2;
        if (cx <= screenW / 4) {
            lp.x = 0;
            floatView.setMirrored(true);
        } else if (cx >= screenW * 3 / 4) {
            lp.x = screenW - lp.width;
            floatView.setMirrored(false);
        }
        if (cy <= screenH / 4) {
            lp.y = 0;
        } else if (cy >= screenH * 3 / 4) {
            lp.y = screenH - lp.height;
        }
        try { wm.updateViewLayout(floatView, lp); } catch (Exception ignored) {}
    }

    // ========== 桌面版点击序列（step0余额 / step1台词或时间 / step2时间） ==========
    private void whaleTap() {
        if (!"normal".equals(mood)) {
            // 非主状态轻点：退出表情 + 余额气泡
            if ("shy".equals(mood)) { handler.removeCallbacks(shyRelease); exitShy(true); }
            else if ("angry".equals(mood)) { handler.removeCallbacks(angryRelease); exitAngry(); }
            else if ("disappointed".equals(mood)) exitDisappointed(true);
            else if ("exhausted".equals(mood)) { floatView.showBubble("…"); return; }
            whaleClickStep = 0;
            lastWhaleClickAt = 0;
            showBalanceBubble();
            return;
        }
        // 高频连点检测（桌面版：≥5警告 / ≥18生气）
        long now = System.currentTimeMillis();
        if (!clickLog.isEmpty() && now - clickLog.get(clickLog.size() - 1) > HIGH_FREQ_GAP_MS) clickLog.clear();
        clickLog.add(now);
        while (!clickLog.isEmpty() && now - clickLog.get(0) > HIGH_FREQ_WINDOW_MS) clickLog.remove(0);
        if (clickLog.size() >= HIGH_FREQ_COUNT) { clickLog.clear(); enterAngry(); return; }
        if (clickLog.size() >= HIGH_FREQ_WARN) { floatView.showBubble("你再摸人家就生气了喵 (╬ Ò﹏Ó)"); return; }

        if (whaleClickStep == 0) {
            showBalanceBubble();
            whaleClickStep = 1;
            lastWhaleClickAt = now;
            return;
        }
        if (whaleClickStep == 1) {
            if (Math.random() < 0.5 || pickNonEmpty(prefs.getDialogueLines()).length == 0) {
                // 时间气泡（高峰/空闲）
                floatView.showTimeBubble(isPeakTime());
            } else {
                String[] lines = pickNonEmpty(prefs.getDialogueLines());
                floatView.showBubble(lines[random.nextInt(lines.length)]);
            }
            whaleClickStep = 2;
            lastWhaleClickAt = now;
            return;
        }
        floatView.showTimeBubble(isPeakTime());
        whaleClickStep = 0;
        lastWhaleClickAt = 0;
    }

    /** 桌面版 is_peak_time：北京时间 9-12 与 14-18 为高峰 */
    private boolean isPeakTime() {
        java.util.Calendar cal = java.util.Calendar.getInstance();
        int h = cal.get(java.util.Calendar.HOUR_OF_DAY);
        return (h >= 9 && h < 12) || (h >= 14 && h < 18);
    }

    // ========== 表情状态机 ==========

    private void resetIdle() {
        if ("disappointed".equals(mood) || "exhausted".equals(mood)) return;
        lastInteractTime = System.currentTimeMillis();
        handler.removeCallbacks(idleToDisappointed);
        handler.postDelayed(idleToDisappointed, IDLE_TO_DISAPPOINTED_MS);
    }

    private void enterDisappointed() {
        if ("disappointed".equals(mood) || "exhausted".equals(mood)) return;
        mood = "disappointed";
        floatView.setMood(mood);
        floatView.showBubble("鲸鲸没人要了喵 (╥﹏╥)");
        lonelyIndex = 0;
        handler.removeCallbacks(lonelyCarousel);
        handler.postDelayed(lonelyCarousel, LONELY_CAROUSEL_MS);
    }

    private void nextLonelyLine() {
        if (!"disappointed".equals(mood)) { handler.removeCallbacks(lonelyCarousel); return; }
        floatView.showBubble(LONELY_LINES[lonelyIndex % LONELY_LINES.length]);
        lonelyIndex++;
        handler.postDelayed(lonelyCarousel, LONELY_CAROUSEL_MS);
    }

    private void exitDisappointed(boolean interrupted) {
        if (!"disappointed".equals(mood)) return;
        mood = "normal";
        handler.removeCallbacks(lonelyCarousel);
        floatView.setMood(mood);
        floatView.showBubble("你终于想起本鲸了喵 (=￣ω￣=)");
        clickLog.clear(); whaleClickStep = 0; lastWhaleClickAt = 0;
        // 短暂按压图标后恢复
        floatView.startPress();
        handler.postDelayed(() -> { if (!floatView.isPressing()) return; floatView.endPress(); }, 300);
        resetIdle();
    }

    private void enterAngry() {
        if ("exhausted".equals(mood)) return;
        mood = "angry";
        floatView.setMood(mood);
        floatView.showBubble("你再摸人家就生气了喵 (╬ Ò﹏Ó)");
        clickLog.clear(); whaleClickStep = 0; lastWhaleClickAt = 0;
        handler.removeCallbacks(angryRelease);
        handler.postDelayed(angryRelease, ANGRY_MS);
    }

    private void exitAngry() {
        if (!"angry".equals(mood)) return;
        mood = "normal";
        floatView.setMood(mood);
        clickLog.clear(); whaleClickStep = 0; lastWhaleClickAt = 0;
        resetIdle();
    }

    /** 按压1.5s（触屏版"悬停"）→ 害羞 */
    private void enterShyFromHold() {
        if (!"normal".equals(mood)) return;
        mood = "shy";
        floatView.setMood(mood);
        floatView.showBubble("主人摸本鲸头了喵 (≧◡≦)♡");
        clickLog.clear(); whaleClickStep = 0; lastWhaleClickAt = 0;
        handler.removeCallbacks(shyRelease);
        handler.postDelayed(shyRelease, SHY_MS);
    }

    private void exitShy(boolean interrupted) {
        if (!"shy".equals(mood)) return;
        mood = "normal";
        floatView.setMood(mood);
        clickLog.clear(); whaleClickStep = 0; lastWhaleClickAt = 0;
        resetIdle();
    }

    private void enterExhausted() {
        if ("exhausted".equals(mood)) return;
        mood = "exhausted";
        floatView.setExhaustedMode(true);
        floatView.setMood(mood);
        exhaustedIndex = 0;
        if (prefs.isBubbleEnabled()) handler.postDelayed(() -> {
            if ("exhausted".equals(mood)) floatView.showBubble(EXHAUSTED_LINES[exhaustedIndex % EXHAUSTED_LINES.length]);
        }, EXHAUSTED_PROMPT_MS);
    }

    private void exitExhausted() {
        if (!"exhausted".equals(mood)) return;
        mood = "normal";
        floatView.setExhaustedMode(false);
        floatView.setMood(mood);
        resetIdle();
    }

    private static final long EXHAUSTED_PROMPT_MS = 10000;

    private void syncExhausted() {
        if (lastBalance <= 0) return;
        // 桌面版：exhaustedModeEnabled 开关 + exhaustedBalanceThreshold 阈值
        boolean enabled = prefs.isExhaustedEnabled();
        double threshold = prefs.getExhaustedThreshold();
        if (enabled && !"exhausted".equals(mood) && lastBalance < threshold) enterExhausted();
        else if (!enabled && "exhausted".equals(mood)) exitExhausted();
        else if (enabled && "exhausted".equals(mood) && lastBalance > threshold) exitExhausted();
    }

    private void showBalanceBubble() {
        String key = prefs.getApiKey();
        if (key == null || key.isEmpty()) {
            floatView.openBubble("DeepSeek余额", "未配置Key", "请在设置里粘贴 sk- Key");
            return;
        }
        if (lastBalance > 0) {
            floatView.openBubble("DeepSeek余额", "¥ " + String.format("%.2f", lastBalance), "今日已用 " + fmtToday());
        } else {
            floatView.openBubble("DeepSeek余额", "…", "加载中…");
        }
    }

    private void showRandomLine() {
        if (!prefs.isBubbleEnabled()) return;
        double r = random.nextDouble();
        double acc = 0;
        String line = LINES[0][0];
        for (String[] pair : LINES) {
            acc += Double.parseDouble(pair[1]);
            if (r <= acc) { line = pair[0]; break; }
        }
        floatView.showBubble(line);
    }

    private final Runnable refreshTask = new Runnable() {
        @Override public void run() {
            refreshBalance(false);
            handler.postDelayed(this, REFRESH_INTERVAL);
        }
    };

    // ========== 自动台词（桌面版 dialogue：intervalMin ± jitter%，carousel/random） ==========
    private int dialogueIdx = 0;
    private final Runnable dialogueAuto = new Runnable() {
        @Override public void run() {
            if ("normal".equals(mood) && prefs.isBubbleEnabled()
                    && floatView != null && !floatView.isBubbleOpen()) {
                String[] lines = pickNonEmpty(prefs.getDialogueLines());
                if (lines.length > 0) {
                    String line;
                    if ("carousel".equals(prefs.getDialogueMode())) {
                        line = lines[dialogueIdx % lines.length];
                        dialogueIdx++;
                    } else {
                        line = lines[random.nextInt(lines.length)];
                    }
                    floatView.showBubble(line);
                }
            }
            scheduleNextDialogue();
        }
    };

    private void scheduleNextDialogue() {
        int min = Math.max(1, prefs.getDialogueIntervalMin());
        int jitterPct = Math.max(0, Math.min(100, prefs.getDialogueJitterPct()));
        double jitter = min * (jitterPct / 100.0) * (random.nextDouble() * 2 - 1);
        long delay = (long) ((min + jitter) * 60000L);
        handler.postDelayed(dialogueAuto, Math.max(60000L, delay));
    }

    /** 过滤空白台词行（自定义台词可能留空行） */
    private String[] pickNonEmpty(String[] all) {
        if (all == null || all.length == 0) return new String[0];
        java.util.ArrayList<String> v = new java.util.ArrayList<>();
        for (String l : all) {
            if (l != null && !l.trim().isEmpty()) v.add(l);
        }
        return v.toArray(new String[0]);
    }

    private String fmtToday() {
        double c = prefs.getTodayUsed();
        return "¥ " + String.format("%.2f", c);
    }

    private void refreshBalance(boolean showLoading) {
        if (refreshing) return;
        String apiKey = prefs.getApiKey();
        if (apiKey == null || apiKey.isEmpty()) return;
        refreshing = true;
        new Thread(() -> {
            try {
                BalanceInfo info = DeepSeekApi.getBalance(apiKey);
                double balance = info.totalBalance;
                runOnUi(() -> {
                    double base = prefs.getTodayBase();
                    if (base <= 0) {
                        prefs.setTodayBase(balance);
                        prefs.setTodayUsed(0.0);
                    } else {
                        double used = Math.max(0.0, base - balance);
                        prefs.setTodayUsed(used);
                    }
                    boolean dropped = lastBalance > 0 && balance < lastBalance - 0.001;
                    if (dropped && prefs.isTeaseEnabled() && !floatView.isRedMode()) {
                        floatView.showBubble(String.format(TEASE[random.nextInt(TEASE.length)],
                                String.format("%.2f", lastBalance - balance)));
                    }
                    lastBalance = balance;
                    prefs.setCachedBalance(balance);
                    prefs.setLastUpdateTime(System.currentTimeMillis());
                    if (floatView.isBubbleOpen()) showBalanceBubble();
                });
            } catch (Exception e) {
                Log.e(TAG, "refresh failed", e);
            } finally {
                refreshing = false;
            }
        }).start();
    }

    private void runOnUi(Runnable r) { handler.post(r); }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "小鲸鱼守护", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("悬浮窗常驻守护通知");
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
        Intent it = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, it,
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return b.setSmallIcon(R.mipmap.ic_launcher_48)
                .setContentTitle("小鲸鱼余额挂件")
                .setContentText("本鱼正在守护你的余额～")
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
