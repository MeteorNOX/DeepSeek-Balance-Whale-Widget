package com.whale.deepseek.widget;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.animation.OvershootInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;

import java.util.Random;

/**
 * 悬浮窗小鲸鱼 —— 100% 对齐原版插件布局：
 * .dshwv-root(正方形 base×base) > .dshwv-body(全窗/按压载体)
 *   ├─ img    右下角59.45%×59.45% 鲸鱼
 *   ├─ bubble 左上 宽100% aspect1026/700（白气泡+2小泡）
 *   │   ├─ rua   (44.25%,38%)中心 max560u×400u
 *   │   └─ text  (44.25%,38%)中心 #536ba9 label66u/amount128u/hint56u
 * 左吸附: 整root镜像; text/rua 二次翻转保持可读
 * 素材: ds_whale常态 / ds_whale_blink眨眼帧 / ds_whale_m说话帧 / ds_whale_red红温 / rua.gif
 */
/**
 * 悬浮窗小鲸鱼 —— 对齐桌面版（For-WinDesktop）实现：
 * 窗口正方形 (250×scale).clamp(122,625)px；root 铺满
 *   ├─ img    右下角59.45%×59.45% 鲸鱼（表情系统换图）
 *   ├─ bubble 左上 宽100% aspect1026/700（白气泡+2小泡 SVG贴图）
 *   │   └─ text  (44.25%,38%)中心: label66u/amount128u/period104u/hint56u
 * 左吸附: 整root镜像; text 二次翻转保持可读
 * 表情: normal(main)/angry/disappointed/shy/exhausted/stroking(按压)
 * 眨眼: half_closed(70ms)->closed(150ms)->half_open(70ms)->main, 间隔4~6s
 */
public class WhaleFloatView extends FrameLayout {

    private final Context ctx;
    private Bitmap bmNormal, bmAngry, bmSad, bmShy, bmTired, bmStroke,
            bmHalfClosed, bmClosed, bmHalfOpen;
    private final Random random = new Random();
    private final Handler handler = new Handler(Looper.getMainLooper());

    // 表情状态（对齐桌面版 flags.mood）
    private String mood = "normal"; // normal|angry|disappointed|shy|exhausted
    private boolean pressing = false;
    private boolean exhaustedMode = false;
    private int blinkMinSec = 4, blinkMaxSec = 6;

    private FrameLayout body;
    private BubbleView bubble;
    private ImageView whaleImg;
    private boolean mirrored = false, bubbleOpen = false;
    private int basePx = 375;

    public interface BubbleStateListener { void onBubbleStateChanged(boolean open); }
    public interface MenuListener { void onRefresh(); void onChat(); void onSettings(); void onHide(); }
    public interface SettingListener {
        void onScaleChanged(float scale);
        void onVolumeChanged(float v);
        void onSoundChanged(boolean on);
        void onTeaseChanged(boolean on);
        void onCostChanged(boolean on);
        void onBubbleChanged(boolean on);
        void onKeySaved(String key);
        void onModeChanged(boolean fg);
    }

    private MenuListener menuListener;
    private SettingListener settingListener;
    private BubbleStateListener bubbleStateListener;

    public WhaleFloatView(Context context) {
        super(context);
        this.ctx = context;
        init();
    }

    public void setMenuListener(MenuListener l) { this.menuListener = l; }
    public void setSettingListener(SettingListener l) { this.settingListener = l; }
    public void setBubbleStateListener(BubbleStateListener l) { this.bubbleStateListener = l; }

    private void init() {
        bmNormal = load(R.drawable.ds_whale);
        bmAngry = load(R.drawable.ds_whale_angry);
        if (bmAngry == null) bmAngry = load(R.drawable.ds_whale_red);
        bmSad = load(R.drawable.ds_whale_sad);
        bmShy = load(R.drawable.ds_whale_shy);
        bmTired = load(R.drawable.ds_whale_tired);
        bmStroke = load(R.drawable.ds_whale_stroke);
        bmHalfClosed = load(R.drawable.ds_whale_halfclosed);
        bmClosed = load(R.drawable.ds_whale_closed);
        bmHalfOpen = load(R.drawable.ds_whale_halfopen);
        if (bmNormal == null) bmNormal = bmAngry != null ? bmAngry : bmStroke;
        if (bmAngry == null) bmAngry = bmNormal;
        if (bmSad == null) bmSad = bmNormal;
        if (bmShy == null) bmShy = bmNormal;
        if (bmTired == null) bmTired = bmNormal;
        if (bmStroke == null) bmStroke = bmNormal;
        if (bmHalfClosed == null) bmHalfClosed = bmNormal;
        if (bmClosed == null) bmClosed = bmNormal;
        if (bmHalfOpen == null) bmHalfOpen = bmNormal;

        setBackgroundColor(Color.TRANSPARENT);

        body = new FrameLayout(ctx);
        addView(body, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        whaleImg = new ImageView(ctx);
        whaleImg.setImageBitmap(bmNormal);
        whaleImg.setScaleType(ImageView.ScaleType.FIT_XY);
        body.addView(whaleImg, whaleLp());

        bubble = new BubbleView(ctx);
        body.addView(bubble, bubbleLp());

        // 呼吸（增强，原版无）：轻浮动，不干扰眨眼换图
        ValueAnimator breathe = ValueAnimator.ofFloat(0f, 1f);
        breathe.setDuration(2600);
        breathe.setRepeatCount(ValueAnimator.INFINITE);
        breathe.setRepeatMode(ValueAnimator.REVERSE);
        breathe.addUpdateListener(a -> {
            float t = (float) a.getAnimatedValue();
            if (!redMode()) whaleImg.setTranslationY((float) (Math.sin(t * Math.PI * 2) * dp(1.8f)));
        });
        breathe.start();

        scheduleBlink();
    }

    private Bitmap load(int res) {
        try { return BitmapFactory.decodeResource(getResources(), res); } catch (Exception e) { return null; }
    }

    private boolean redMode() { return "angry".equals(mood); }

    /** 桌面版: 窗口正方形 = (250×scale).clamp(122,625) 逻辑px；Service 转 px 传入 */
    public void setBasePx(int px) {
        this.basePx = px;
        post(() -> {
            whaleImg.setLayoutParams(whaleLp());
            bubble.setLayoutParams(bubbleLp());
            requestLayout();
        });
    }
    public int getBasePx() { return basePx; }
    public int getBubbleHeightPx() { return (int) (basePx * 700f / 1026f); }

    private LayoutParams whaleLp() {
        int s = (int) (basePx * 0.5945f);
        return new LayoutParams(s, s, Gravity.BOTTOM | Gravity.END);
    }
    private LayoutParams bubbleLp() {
        return new LayoutParams(LayoutParams.MATCH_PARENT, getBubbleHeightPx(), Gravity.TOP | Gravity.START);
    }

    // ========== 眨眼（桌面版 4 帧真图：半闭70ms→闭150ms→半睁70ms→恢复，间隔4~6s） ==========
    public void setBlinkInterval(int minSec, int maxSec) {
        blinkMinSec = Math.max(1, minSec);
        blinkMaxSec = Math.max(blinkMinSec, maxSec);
    }

    private void scheduleBlink() {
        handler.postDelayed(() -> {
            startBlink();
            scheduleBlink();
        }, (long) (blinkMinSec * 1000 + random.nextDouble() * (blinkMaxSec - blinkMinSec) * 1000));
    }

    private boolean isBlinkAllowed() {
        return "normal".equals(mood) && !exhaustedMode && !pressing;
    }

    private void startBlink() {
        if (!isBlinkAllowed()) return;
        whaleImg.setImageBitmap(bmHalfClosed);
        handler.postDelayed(() -> {
            if (!isBlinkAllowed()) { syncVisualState(); return; }
            whaleImg.setImageBitmap(bmClosed);
            handler.postDelayed(() -> {
                if (!isBlinkAllowed()) { syncVisualState(); return; }
                whaleImg.setImageBitmap(bmHalfOpen);
                handler.postDelayed(() -> {
                    if (isBlinkAllowed()) syncVisualState();
                }, 70);
            }, 150);
        }, 70);
    }

    // ========== 气泡 API ==========
    public View getBubbleView() { return bubble; }
    public boolean isBubbleOpen() { return bubbleOpen; }

    public void openBubble(String label, String amount, String hint) {
        bubble.label = label;
        bubble.labelWrap = false; // 余额气泡单行(桌面版无 wrap)
        bubble.amountText = amount;
        bubble.amountStyle = "amount";
        bubble.amountColor = Color.rgb(83, 107, 169);
        bubble.hintText = hint;
        showBubbleInternal(true);
    }

    public void showBubbleText(String text) {
        bubble.label = text;
        bubble.labelWrap = true; // 台词气泡 wrap(桌面版 showDialogueLine)
        bubble.amountText = "";
        bubble.amountStyle = "amount";
        bubble.hintText = "";
        showBubbleInternal(true);
    }

    /** 时间气泡（桌面版）：A"当前时间" + P 高峰(红)/空闲(绿) */
    public void showTimeBubble(boolean peak) {
        bubble.label = "当前时间";
        bubble.labelWrap = false; // 时间气泡单行
        bubble.amountStyle = "period";
        bubble.amountText = peak ? "高峰时间" : "空闲时间";
        bubble.amountColor = peak ? Color.rgb(224, 67, 63) : Color.rgb(47, 162, 76);
        bubble.hintText = "";
        showBubbleInternal(true);
    }

    public void showBubble(String text) {
        if (text == null) return;
        // 台词限制：不超过 12 个字符（按 Unicode 码点，中文/emoji 各算 1）
        int n = text.codePointCount(0, text.length());
        if (n > 12) {
            text = text.substring(0, text.offsetByCodePoints(0, 12));
        }
        showBubbleText(text);
    }

    private void showBubbleInternal(boolean withAutoHide) {
        bubble.setOpen(true);
        bubbleOpen = true;
        // 原版 open 动画：气泡 scale(.7)->1 弹性 + 文字延迟淡入
        bubble.animate().cancel();
        bubble.setScaleX(0.7f);
        bubble.setScaleY(0.7f);
        bubble.setAlpha(0f);
        bubble.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(280)
                .setInterpolator(new OvershootInterpolator(1.6f)).start();
        handler.removeCallbacks(autoHide);
        if (withAutoHide) handler.postDelayed(autoHide, 5000);
        if (bubbleStateListener != null) bubbleStateListener.onBubbleStateChanged(true);
    }

    private final Runnable autoHide = () -> closeBubble();

    public void closeBubble() {
        bubble.setOpen(false);
        bubbleOpen = false;
        // 快速收起动画
        bubble.animate().alpha(0f).scaleX(0.7f).scaleY(0.7f).setDuration(140).start();
        if (bubbleStateListener != null) bubbleStateListener.onBubbleStateChanged(false);
    }

    public void hideBubbleNow() { closeBubble(); }

    // ========== 表情系统（桌面版 flags.mood 状态机） ==========

    /** 设置当前表情（normal|angry|disappointed|shy|exhausted）并同步换图 */
    public void setMood(String m) {
        this.mood = m;
        syncVisualState();
    }
    public String getMood() { return mood; }

    public void setExhaustedMode(boolean on) {
        if (exhaustedMode == on) return;
        exhaustedMode = on;
        if (on) cancelBlinkFrames();
        syncVisualState();
    }
    public boolean isExhaustedMode() { return exhaustedMode; }

    /** 按压开始：静默更换按压图（stroking.png）+显示Q弹 */
    public void startPress() {
        pressing = true;
        cancelBlinkFrames();
        syncVisualState();
    }
    /** 按压结束：恢复当前表情图 */
    public void endPress() {
        pressing = false;
        syncVisualState();
    }

    private void cancelBlinkFrames() { /* 眨眼帧由下一次 scheduleBlink 周期性触发，此处仅同步图标 */ }

    /** 对齐桌面版 syncVisualState() */
    private void syncVisualState() {
        if (!"normal".equals(mood)) {
            Bitmap bm = bmNormal;
            if ("angry".equals(mood)) bm = bmAngry;
            else if ("disappointed".equals(mood)) bm = bmSad;
            else if ("shy".equals(mood)) bm = bmShy;
            else if ("exhausted".equals(mood)) bm = bmTired;
            whaleImg.setImageBitmap(bm);
            return;
        }
        if (exhaustedMode) { whaleImg.setImageBitmap(bmTired); return; }
        if (pressing) { whaleImg.setImageBitmap(bmStroke); return; }
        whaleImg.setImageBitmap(bmNormal);
    }

    public boolean isPressing() { return pressing; }
    public boolean isRedMode() { return "angry".equals(mood); }

    // ========== 颜色（桌面版 globalColor/bubbleColor 色相） ==========
    private int labelHue = 223;  // #536ba9
    private int amountHue = 227; // #203170

    /** 设置文案色相（0-360），气泡自动重绘 */
    public void setColorHue(int globalHue, int bubbleHue) {
        labelHue = ((globalHue % 360) + 360) % 360;
        amountHue = ((bubbleHue % 360) + 360) % 360;
        if (bubble != null) bubble.invalidate();
    }

    private int labelColor() { return Color.HSVToColor(new float[]{labelHue, 0.51f, 0.66f}); }
    private int amountColor() { return Color.HSVToColor(new float[]{amountHue, 0.71f, 0.44f}); }

    // ========== 余额数字滚动（桌面版 animateAmount：700ms 缓出） ==========
    public void animateAmount(float from, float to, String currency, int durationMs) {
        if (!Float.isFinite(from)) from = to;
        if (from == to) {
            bubble.amountText = fmtAmount(to, currency);
            bubble.invalidate();
            return;
        }
        final float fFrom = from, fTo = to;
        ValueAnimator va = ValueAnimator.ofFloat(0f, 1f);
        va.setDuration(durationMs);
        va.addUpdateListener(a -> {
            float t = (float) a.getAnimatedValue();
            float eased = 1 - (float) Math.pow(1 - t, 3);
            bubble.amountText = fmtAmount(fFrom + (fTo - fFrom) * eased, currency);
            bubble.invalidate();
        });
        va.start();
    }

    private String fmtAmount(double v, String currency) {
        return "CNY".equals(currency) ? "¥ " + String.format("%.2f", v) : String.format("%.2f", v) + " " + currency;
    }

    // ========== 按压 Q弹（作用于整个 body，原版 .dshwv-body 动画） ==========
    public void pressAnim() {
        body.animate().cancel();
        float mx = mirrored ? -1.05f : 1.05f;
        body.setScaleX(mx);
        body.setScaleY(0.88f);
        body.animate().scaleX(mirrored ? -1f : 1f).scaleY(1f).setDuration(380)
                .setInterpolator(new OvershootInterpolator(3f)).start();
    }

    /** 桌面版左吸附：整个 root scaleX(-1) 镜像（气泡图形一起翻转，text 内部二次翻转保持可读） */
    public void setMirrored(boolean mirror) {
        if (mirrored == mirror) return;
        mirrored = mirror;
        body.setScaleX(mirror ? -1f : 1f);
        bubble.invalidate();
    }
    public boolean isMirrored() { return mirrored; }

    /** 兼容旧API */
    public void setMirror(boolean mirror) { setMirrored(mirror); }

    /** 触摸点是否落在鲸鱼像素上（桌面版 hit-test: 主图610×610采样 + 镜像 lx=610-lx；透明处不响应） */
    public boolean isTouchingWhale(float x, float y) {
        try {
            Bitmap bm = bmNormal;
            if (bm == null) return true;
            int w = whaleImg.getWidth();
            int h = whaleImg.getHeight();
            if (w <= 0 || h <= 0) return true;
            // whaleImg 位于 root 右下角 (basePx-w, basePx-h)；镜像后视觉在左下角
            float lx = x - (basePx - w);
            float ly = y - (basePx - h);
            if (mirrored) lx = (basePx - x) - (basePx - w); // 镜像映射同桌面版 lx=610-lx
            if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
            int alpha = (bm.getPixel((int) (lx / w * bm.getWidth()),
                    (int) (ly / h * bm.getHeight())) >>> 24) & 0xFF;
            return alpha > 10;
        } catch (Exception e) {
            return true;
        }
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    /** 桌面版气泡：SVG 贴图 + 文字以 root 基准(44.25%,38%)定位；支持 amount/period 两种金额样式 */
    private class BubbleView extends View {
        private final TextPaint textPaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private Bitmap bubbleBmp;
        String label = "", amountText = "", hintText = "";
        boolean labelWrap = false; // 台词自动换行(桌面版 .dshwv-wrap 560u/1.2)
        String amountStyle = "amount"; // amount(128u) | period(104u)
        int amountColor = Color.rgb(83, 107, 169);
        private boolean open = false;
        private boolean red = false;

        BubbleView(Context c) {
            super(c);
            try { bubbleBmp = BitmapFactory.decodeResource(getResources(), R.drawable.bubble_shape); } catch (Exception e) { bubbleBmp = null; }
        }

        void setOpen(boolean o) { open = o; invalidate(); }
        void setRed(boolean r) { red = r; invalidate(); }

        @Override
        protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
            int w = MeasureSpec.getSize(widthMeasureSpec);
            int h = MeasureSpec.getSize(heightMeasureSpec);
            if (w <= 0) w = basePx;
            if (h <= 0) h = getBubbleHeightPx();
            setMeasuredDimension(w, h);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float w = getWidth();
            float h = getHeight();
            if (w <= 0 || h <= 0) return;

            // ===== 气泡贴图（原版SVG离线渲染的精确气泡形状） =====
            if (bubbleBmp != null) {
                Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
                p.setFilterBitmap(true);
                canvas.drawBitmap(bubbleBmp, null, new RectF(0, 0, w, h), p);
            }

            // 文字：相对【气泡】的 (44.25%, 38%) 居中（桌面版 .dshwv-text 是 .dshwv-bubble 子元素！
            // top:38% 相对气泡高700u → 266u，不是 root 的 1026u×38%）
            if (open) {
                float cx = basePx * 0.4425f;
                float cy = getBubbleHeightPx() * 0.38f;
                float u = basePx / 1026f;
                textPaint.setTextAlign(Paint.Align.CENTER);
                StaticLayout wrapLabel = null;
                float lhLabel = 0f;
                if (!label.isEmpty()) {
                    textPaint.setColor(red ? Color.rgb(180, 60, 60) : labelColor());
                    textPaint.setTextSize(u * 66);
                    textPaint.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
                    textPaint.setLetterSpacing(0.06f);
                    if (labelWrap) {
                        // 桌面版 .dshwv-wrap: max-width 560u + white-space normal + line-height 1.2
                        // 注意: StaticLayout.draw 依赖 paint.setTextAlign，若为 CENTER 每行会以行宽中点
                        // 为画线基准导致整段右移半个行宽 -> 必须用 LEFT 对齐副本构造
                        TextPaint wrapPaint = new TextPaint(textPaint);
                        wrapPaint.setTextAlign(Paint.Align.LEFT);
                        wrapLabel = new StaticLayout(label, wrapPaint,
                                Math.max(1, Math.round(u * 560)),
                                Layout.Alignment.ALIGN_CENTER, 1.2f, 0f, false);
                        lhLabel = wrapLabel.getHeight();
                    } else {
                        lhLabel = u * 66 * 1.15f;
                    }
                }
                float lhAmount = "period".equals(amountStyle) ? u * 104 * 1.05f + u * 12 : u * 128 * 1.05f;
                float lhHint = u * 56 * 1.15f + u * 9;
                float total = (label.isEmpty() ? 0 : lhLabel) + (amountText.isEmpty() ? 0 : lhAmount) + (hintText.isEmpty() ? 0 : lhHint);
                float y = cy - total / 2f;

                canvas.save();
                if (mirrored) canvas.scale(-1f, 1f, cx, 0);

                // CSS line-height 语义：每行文字视觉中心位于行框中心
                if (!label.isEmpty()) {
                    if (wrapLabel != null) {
                        // wrap 台词：整块以 cx 居中绘制（StaticLayout 内 ALIGN_CENTER）
                        canvas.save();
                        canvas.translate(cx - wrapLabel.getWidth() / 2f, y);
                        wrapLabel.draw(canvas);
                        canvas.restore();
                    } else {
                        canvas.drawText(label, cx, y + lhLabel / 2f - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint);
                    }
                    y += lhLabel;
                }
                if (!amountText.isEmpty()) {
                    textPaint.setColor(red ? Color.rgb(200, 30, 30) : ("period".equals(amountStyle) ? amountColor : amountColor()));
                    float size = "period".equals(amountStyle) ? u * 104 : u * 128;
                    textPaint.setTextSize(size);
                    textPaint.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
                    textPaint.setLetterSpacing(0f);
                    canvas.drawText(amountText, cx, y + lhAmount / 2f - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint);
                    y += lhAmount;
                }
                if (!hintText.isEmpty()) {
                    textPaint.setColor(Color.rgb(159, 176, 217));
                    textPaint.setTextSize(u * 56);
                    textPaint.setTypeface(Typeface.DEFAULT);
                    textPaint.setLetterSpacing(0.02f);
                    canvas.drawText(hintText, cx, y + lhHint / 2f - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint);
                }
                canvas.restore();
            }
        }
    }
}
