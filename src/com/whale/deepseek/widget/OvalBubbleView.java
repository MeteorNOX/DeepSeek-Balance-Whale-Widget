package com.whale.deepseek.widget;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.view.View;

/**
 * 原生椭圆对话气泡（参照原版 SVG 几何）：
 * 大椭圆(454,247)rx373 ry232 + 尾巴半椭圆 + 2个小气泡，白底蓝描边 #203170
 */
public class OvalBubbleView extends View {

    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private String text = "";
    private final RectF bigOval = new RectF();
    private final Path tail = new Path();

    public OvalBubbleView(Context context) {
        super(context);
        fillPaint.setStyle(Paint.Style.FILL);
        fillPaint.setColor(Color.WHITE);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setColor(Color.rgb(32, 49, 112));
        strokePaint.setStrokeWidth(dp(3));
        strokePaint.setStrokeJoin(Paint.Join.ROUND);
        textPaint.setColor(Color.rgb(83, 107, 169));
        textPaint.setTypeface(Typeface.DEFAULT_BOLD);
        textPaint.setTextAlign(Paint.Align.CENTER);
    }

    public void setBubbleText(String t) {
        text = t == null ? "" : t;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        if (w <= 0 || h <= 0) return;

        // 比例参照原版 viewBox 1026x700
        float sx = w / 1026f;
        float sy = h / 700f;

        // 大椭圆: 中心(454,247) rx373 ry232 -> bbox(81,15)(827,479)
        bigOval.set(81 * sx, 15 * sy, 827 * sx, 479 * sy);

        // 尾巴: (301,465)-(413,484) 中心(356,472)倾10°半椭圆
        tail.reset();
        RectF tailRect = new RectF(295 * sx, 430 * sy, 420 * sx, 560 * sy);
        tail.addOval(tailRect, Path.Direction.CW);
        // 尾巴覆盖大椭圆下缘部分
        canvas.save();
        canvas.drawOval(bigOval, fillPaint);
        canvas.drawOval(tailRect, fillPaint);

        // 小气泡1: (352,561) rx37.5 ry26
        RectF b1 = new RectF((352 - 38) * sx, (561 - 27) * sy, (352 + 38) * sx, (561 + 27) * sy);
        canvas.drawOval(b1, fillPaint);
        // 小气泡2: (442,646) rx24.5 ry18
        RectF b2 = new RectF((442 - 25) * sx, (646 - 19) * sy, (442 + 25) * sx, (646 + 19) * sy);
        canvas.drawOval(b2, fillPaint);

        // 描边（椭圆边框）
        canvas.drawOval(bigOval, strokePaint);
        canvas.drawOval(b1, strokePaint);
        canvas.drawOval(b2, strokePaint);
        canvas.restore();

        // 文本（居中，自动换行）
        if (!text.isEmpty()) {
            textPaint.setTextSize(dp(13));
            String[] lines = text.split("\n");
            float lineH = dp(20);
            float startY = bigOval.centerY() - ((lines.length - 1) * lineH) / 2f
                    - (textPaint.ascent() + textPaint.descent()) / 2f;
            for (String line : lines) {
                boolean isAmount = line.startsWith("¥");
                textPaint.setTextSize(isAmount ? dp(17) : dp(13));
                textPaint.setTypeface(Typeface.DEFAULT_BOLD);
                canvas.drawText(line, bigOval.centerX(), startY, textPaint);
                startY += lineH;
            }
        }
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
