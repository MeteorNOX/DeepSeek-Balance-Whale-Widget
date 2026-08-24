package com.whale.deepseek.widget;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import com.whale.deepseek.widget.api.DeepSeekApi;
import com.whale.deepseek.widget.api.DeepSeekApi.BalanceInfo;
import com.whale.deepseek.widget.store.Prefs;

import java.util.Locale;

/**
 * 设置面板（参考桌面版 config.html 卡片式）：
 * 余额概览 / 基础配置(API Key) / 挂件显示(大小·音量·眨频·疲惫) /
 * 台词管理(列表·模式·间隔·波动) / 系统配置(模式·自启·颜色) / 启动
 */
public class MainActivity extends Activity {

    private Prefs prefs;
    private EditText keyInput, blinkMinInput, blinkMaxInput, exhaustedThresholdInput, dialogueIntervalInput;
    private LinearLayout dialogueList;
    private android.widget.ScrollView dialogueScroll;
    private Button addLineBtn;
    private boolean suppressDialogueSave = false;
    private Button keyToggleBtn, resetLinesBtn, resetColorBtn, startBtn, chatBtn;
    private RadioGroup modeGroup, dialogueModeGroup;
    private Switch soundSwitch, costSwitch, bubbleSwitch, teaseSwitch, autoStartSwitch, exhaustedSwitch;
    private SeekBar scaleSeek, volumeSeek, dialogueJitterSeek, globalHueSeek, bubbleHueSeek;
    private TextView scaleValTv, jitterValTv, volumeValTv, balanceCardA, balanceCardB;

    private boolean keyVisible = false;
    private static final float SCALE_MIN = 0.6f, SCALE_MAX = 2.5f;
    private static final int LEVEL_MIN = 1, LEVEL_MAX = 20;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        buildUi();
        loadPrefs();
        refreshBalanceCards();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshBalanceCards();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(245, 247, 250));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(14), dp(16), dp(24));
        scroll.addView(root, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ImageView whale = new ImageView(this);
        whale.setImageResource(R.drawable.whale_big);
        whale.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(110));
        wlp.gravity = Gravity.CENTER_HORIZONTAL;
        root.addView(whale, wlp);
        TextView title = new TextView(this);
        title.setText("小鲸鱼设置");
        title.setTextColor(Color.rgb(11, 37, 69));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        root.addView(title);
        TextView subtitle = new TextView(this);
        subtitle.setText("DeepSeek 余额挂件 · 对齐桌面版 For-WinDesktop");
        subtitle.setTextColor(Color.rgb(93, 109, 126));
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        subtitle.setGravity(Gravity.CENTER);
        root.addView(subtitle);

        LinearLayout overviewRow = new LinearLayout(this);
        overviewRow.setOrientation(LinearLayout.HORIZONTAL);
        overviewRow.setPadding(0, dp(14), 0, 0);
        balanceCardA = overviewCard("可用额度", "¥ --");
        balanceCardB = overviewCard("今日已用", "¥ --");
        overviewRow.addView(balanceCardA, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams blpB = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        blpB.leftMargin = dp(12);
        overviewRow.addView(balanceCardB, blpB);
        root.addView(overviewRow);

        LinearLayout baseCard = card(root, "🔑 基础配置");
        keyInput = input(baseCard, "sk- API Key", true);
        keyToggleBtn = fieldBtn(baseCard, "显示 / 隐藏");
        keyToggleBtn.setOnClickListener(v -> {
            keyVisible = !keyVisible;
            keyInput.setInputType(InputType.TYPE_CLASS_TEXT | (keyVisible
                    ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    : InputType.TYPE_TEXT_VARIATION_PASSWORD));
            keyInput.setSelection(keyInput.length());
            keyToggleBtn.setText(keyVisible ? "隐藏" : "显示");
        });

        buildWidgetCard(root);
        buildBehaviorCard(root);
        buildDialogueCard(root);
        buildSysCard(root);
        buildAboutCard(root);
        buildButtons(root);
        setContentView(scroll);
    }

    // ===== 引导与素材声明（原作者/来源/gif 致谢） =====
    private void buildAboutCard(LinearLayout root) {
        LinearLayout about = card(root, "📖 引导与素材声明");

        TextView guide = new TextView(this);
        guide.setText("🚀 三步上手：\n" +
                "① 粘贴 DeepSeek API Key（sk- 开头，仅存本机加密）\n" +
                "② 点「🐳 开启悬浮窗挂件」，授权悬浮窗权限\n" +
                "③ 小鲸鱼就位：轻点查余额 · 长按 1.5s 害羞 · 连点生气 · 拖动贴边\n" +
                "📌 点鲸鱼脸部区域才有效哦～");
        guide.setTextColor(Color.rgb(52, 74, 99));
        guide.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        guide.setLineSpacing(dp(3), 1.2f);
        about.addView(guide);

        TextView mats = new TextView(this);
        mats.setText("🎬 动图与素材声明\n" +
                "· 摸头动画 rua.gif（94KB）\n" +
                "· 鲸鱼表情位图 ×9（main/angry/shy/disappointed/exhausted\n" +
                "  half_closed/half_open/close_eyes/stroking）\n" +
                "· 气泡形状 SVG 与音效（D1/D2/Ya1/Ya2.mp3）\n" +
                "以上素材均取自原项目仓库，版权归原作者 MeteorNOX 所有。");
        mats.setTextColor(Color.rgb(93, 109, 126));
        mats.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mats.setLineSpacing(dp(2), 1.15f);
        LinearLayout.LayoutParams mLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mLp.topMargin = dp(10);
        about.addView(mats, mLp);

        TextView src = new TextView(this);
        src.setText("🐳 原作者与来源\n" +
                "· 原作者：MeteorNOX（GitHub @MeteorNOX）\n" +
                "· 原项目：DeepSeek-Balance-Whale-Widget\n" +
                "· 参考分支：For–WinDesktop（Tauri v2）\n" +
                "· 许可证：MIT License\n" +
                "· 本项目地址：github.com/a0979283788-ctrl/whale-widget-android\n" +
                "· 本版为 Android 原生悬浮窗移植版，与原项目无直接关联\n" +
                "· 仅供学习交流；API Key 保存在本机，请勿公开分享");
        src.setTextColor(Color.rgb(93, 109, 126));
        src.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        src.setLineSpacing(dp(2), 1.15f);
        LinearLayout.LayoutParams sLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sLp.topMargin = dp(10);
        about.addView(src, sLp);

        // 按钮行：原项目 + 本项目
        LinearLayout linkRow = new LinearLayout(this);
        linkRow.setOrientation(LinearLayout.HORIZONTAL);
        linkRow.setGravity(Gravity.CENTER_VERTICAL);
        Button openBtn = new Button(this);
        openBtn.setText("🌐 原项目");
        openBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        openBtn.setTextColor(Color.WHITE);
        android.graphics.drawable.GradientDrawable obg = new android.graphics.drawable.GradientDrawable();
        obg.setColor(Color.rgb(46, 134, 222));
        obg.setCornerRadius(dp(12));
        openBtn.setBackground(obg);
        LinearLayout.LayoutParams oLp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        oLp.topMargin = dp(12);
        oLp.rightMargin = dp(8);
        linkRow.addView(openBtn, oLp);
        openBtn.setOnClickListener(v -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget")));
            } catch (Exception e) {
                toast("无法打开浏览器");
            }
        });
        Button selfBtn = new Button(this);
        selfBtn.setText("🐳 本项目");
        selfBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        selfBtn.setTextColor(Color.WHITE);
        android.graphics.drawable.GradientDrawable sbg = new android.graphics.drawable.GradientDrawable();
        sbg.setColor(Color.rgb(74, 148, 209));
        sbg.setCornerRadius(dp(12));
        selfBtn.setBackground(sbg);
        LinearLayout.LayoutParams selfLp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        selfLp.topMargin = dp(12);
        linkRow.addView(selfBtn, selfLp);
        selfBtn.setOnClickListener(v -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://github.com/a0979283788-ctrl/whale-widget-android")));
            } catch (Exception e) {
                toast("无法打开浏览器");
            }
        });
        about.addView(linkRow);
    }

    // ===== 新手指引 =====
    private void buildGuideCard(LinearLayout root) {
        LinearLayout card = card(root, "📖 新手指引");
        TextView tv = new TextView(this);
                tv.setText("🚀 三步上手：\n① 粘贴 DeepSeek API Key（sk- 开头）\n② 点「🐳 开启悬浮窗挂件」，按提示授权悬浮窗\n③ 小鲸鱼就飘在屏幕右下角啦！\n\n🐟 互动手势：\n• 轻点 = 余额 → 台词/时间 → 时间\n• 按住 1.5 秒 = 害羞（摸头）\n• 连续快速点击 = 生气警告\n• 拖动 = 移动，松开自动贴边\n• 贴左边缘 = 镜像翻转\n\n📌 点鲸鱼脸部区域才有效哦～");
        tv.setTextColor(Color.rgb(52, 74, 99));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tv.setLineSpacing(dp(4), 1.15f);
        tv.setPadding(dp(4), dp(2), dp(4), dp(2));
        card.addView(tv);
    }

    // ===== 挂件显示 =====
    private void buildWidgetCard(LinearLayout root) {
        LinearLayout widgetCard = card(root, "🐳 挂件显示");
        scaleValTv = new TextView(this);
        scaleSeek = sliderRow(widgetCard, "大小", 1, 20, scaleValTv);
        scaleSeek.setOnSeekBarChangeListener(onSeek(v -> {
            float scale = SCALE_MIN + (v - LEVEL_MIN) / (float) (LEVEL_MAX - LEVEL_MIN) * (SCALE_MAX - SCALE_MIN);
            prefs.setFloatScale(scale);
            scaleValTv.setText(String.valueOf(v));
        }));
        volumeValTv = new TextView(this);
        volumeSeek = sliderRow(widgetCard, "音量", 0, 100, volumeValTv);
        volumeSeek.setOnSeekBarChangeListener(onSeek(v -> {
            prefs.setVolume(v / 100f);
            volumeValTv.setText(v + "%");
        }));
        LinearLayout blinkRow = row(widgetCard, "眨眼频率");
        blinkMinInput = numberInput(blinkRow, 4);
        blinkMaxInput = numberInput(blinkRow, 6);
        blinkRow.addView(blinkMinInput, new LinearLayout.LayoutParams(dp(56), ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView sep = new TextView(this);
        sep.setText(" ~ ");
        sep.setTextColor(Color.rgb(93, 109, 126));
        blinkRow.addView(sep);
        blinkRow.addView(blinkMaxInput, new LinearLayout.LayoutParams(dp(56), ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView sec = new TextView(this);
        sec.setText(" 秒");
        sec.setTextColor(Color.rgb(93, 109, 126));
        blinkRow.addView(sec);
        exhaustedSwitch = switchRow(widgetCard, "启用疲惫模式（余额不足时）");
        LinearLayout thrRow = row(widgetCard, "疲惫阈值");
        exhaustedThresholdInput = numberInput(thrRow, 5);
        thrRow.addView(exhaustedThresholdInput, new LinearLayout.LayoutParams(dp(80), ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView yuan = new TextView(this);
        yuan.setText(" 元");
        yuan.setTextColor(Color.rgb(93, 109, 126));
        thrRow.addView(yuan);
    }

    // ===== 声音与行为 =====
    private void buildBehaviorCard(LinearLayout root) {
        LinearLayout behaviorCard = card(root, "🔔 声音与行为");
        soundSwitch = switchRow(behaviorCard, "音效（按压/气泡音）");
        teaseSwitch = switchRow(behaviorCard, "余额下降吐槽");
        costSwitch = switchRow(behaviorCard, "消耗弹泡");
        bubbleSwitch = switchRow(behaviorCard, "台词气泡");
    }

    // ===== 台词管理 =====
    private void buildDialogueCard(LinearLayout root) {
        LinearLayout dialogueCard = card(root, "💬 台词管理");
        // 台词列表：可滚动、逐条编辑（对齐桌面版 dialogue-list 逐行 input+删除）
        dialogueScroll = new android.widget.ScrollView(this);
        dialogueScroll.setVerticalScrollBarEnabled(true);
        android.graphics.drawable.GradientDrawable dlgBg = new android.graphics.drawable.GradientDrawable();
        dlgBg.setColor(Color.rgb(248, 250, 253));
        dlgBg.setCornerRadius(dp(10));
        dlgBg.setStroke(dp(1), Color.rgb(221, 226, 232));
        dialogueScroll.setBackground(dlgBg);
        dialogueList = new LinearLayout(this);
        dialogueList.setOrientation(LinearLayout.VERTICAL);
        dialogueList.setPadding(dp(6), dp(6), dp(6), dp(6));
        dialogueScroll.addView(dialogueList);
        // 全展开显示所有台词行（避免嵌套 ScrollView 抢滚动），由外层整页控制滚动
        dialogueCard.addView(dialogueScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 按钮行：添加台词 + 恢复默认
        LinearLayout dlgBtnRow2 = new LinearLayout(this);
        dlgBtnRow2.setOrientation(LinearLayout.HORIZONTAL);
        dlgBtnRow2.setGravity(Gravity.CENTER_VERTICAL);
        addLineBtn = new Button(this);
        addLineBtn.setText("➕ 添加台词");
        addLineBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        addLineBtn.setTextColor(Color.WHITE);
        android.graphics.drawable.GradientDrawable addBg = new android.graphics.drawable.GradientDrawable();
        addBg.setColor(Color.rgb(46, 134, 222));
        addBg.setCornerRadius(dp(12));
        addLineBtn.setBackground(addBg);
        LinearLayout.LayoutParams addLp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        addLp.topMargin = dp(10);
        addLp.rightMargin = dp(8);
        dlgBtnRow2.addView(addLineBtn, addLp);
        resetLinesBtn = new Button(this);
        resetLinesBtn.setText("恢复默认台词");
        resetLinesBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        android.graphics.drawable.GradientDrawable rstBg = new android.graphics.drawable.GradientDrawable();
        rstBg.setColor(Color.rgb(240, 243, 247));
        rstBg.setCornerRadius(dp(12));
        resetLinesBtn.setBackground(rstBg);
        LinearLayout.LayoutParams rstLp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        rstLp.topMargin = dp(10);
        dlgBtnRow2.addView(resetLinesBtn, rstLp);
        dialogueCard.addView(dlgBtnRow2);

        addLineBtn.setOnClickListener(v -> addDialogueRow("", true));
        resetLinesBtn.setOnClickListener(v -> {
            prefs.setDialogueLines(null);
            buildDialogueRows(prefs.getDialogueLines(), false);
            toast("已恢复默认台词");
        });
        buildDialogueRows(prefs.getDialogueLines(), false);
        LinearLayout dlgModeRow = row(dialogueCard, "播放模式");
        dialogueModeGroup = new RadioGroup(this);
        dialogueModeGroup.setOrientation(RadioGroup.HORIZONTAL);
        RadioButton rbCarousel = new RadioButton(this);
        rbCarousel.setText("轮播");
        rbCarousel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        RadioButton rbRandom = new RadioButton(this);
        rbRandom.setText("随机");
        rbRandom.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        dialogueModeGroup.addView(rbCarousel);
        dialogueModeGroup.addView(rbRandom);
        dlgModeRow.addView(dialogueModeGroup);
        LinearLayout dlgIntervalRow = row(dialogueCard, "间隔时长");
        dialogueIntervalInput = numberInput(dlgIntervalRow, 5);
        dlgIntervalRow.addView(dialogueIntervalInput, new LinearLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView dlgMin = new TextView(this);
        dlgMin.setText(" 分钟");
        dlgMin.setTextColor(Color.rgb(93, 109, 126));
        dlgIntervalRow.addView(dlgMin);
        jitterValTv = new TextView(this);
        dialogueJitterSeek = sliderRow(dialogueCard, "波动幅度", 0, 100, jitterValTv);
        dialogueJitterSeek.setOnSeekBarChangeListener(onSeek(v -> {
            prefs.setDialogueJitterPct(v);
            jitterValTv.setText(v + "%");
        }));
    }

    /** 重建台词列表（lines==null 时读取 prefs/默认） */
    private void buildDialogueRows(String[] lines, boolean focusLast) {
        suppressDialogueSave = true;
        dialogueList.removeAllViews();
        if (lines == null) lines = prefs.getDialogueLines();
        for (String l : lines) addDialogueRowRaw(l);
        suppressDialogueSave = false;
        if (focusLast) {
            dialogueList.post(() -> {
                dialogueScroll.fullScroll(android.view.View.FOCUS_DOWN);
                if (dialogueList.getChildCount() > 0) {
                    android.view.View last = dialogueList.getChildAt(dialogueList.getChildCount() - 1);
                    if (last instanceof LinearLayout && ((LinearLayout) last).getChildCount() > 0) {
                        android.view.View et = ((LinearLayout) last).getChildAt(0);
                        et.requestFocus();
                    }
                }
            });
        }
    }

    /** 添加一行台词并聚焦 */
    private void addDialogueRow(String text, boolean focus) {
        addDialogueRowRaw(text);
        if (focus) {
            dialogueList.post(() -> {
                if (dialogueList.getChildCount() > 0) {
                    android.view.View last = dialogueList.getChildAt(dialogueList.getChildCount() - 1);
                    if (last instanceof LinearLayout && ((LinearLayout) last).getChildCount() > 0) {
                        EditText et = (EditText) ((LinearLayout) last).getChildAt(0);
                        et.requestFocus();
                        et.setSelection(et.length());
                    }
                }
                dialogueScroll.post(() -> dialogueScroll.fullScroll(android.view.View.FOCUS_DOWN));
            });
        }
    }

    /** 单行 UI：输入框 + 删除按钮 */
    private void addDialogueRowRaw(String text) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        EditText et = new EditText(this);
        et.setText(text == null ? "" : text);
        et.setHint("输入台词…");
        et.setSingleLine(true);
        et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        et.setTextColor(Color.rgb(28, 40, 51));
        et.setHintTextColor(Color.rgb(160, 175, 190));
        android.graphics.drawable.GradientDrawable rowBg = new android.graphics.drawable.GradientDrawable();
        rowBg.setColor(Color.WHITE);
        rowBg.setCornerRadius(dp(9));
        rowBg.setStroke(dp(1), Color.rgb(221, 226, 232));
        et.setBackground(rowBg);
        et.setPadding(dp(10), dp(4), dp(10), dp(4));
        LinearLayout.LayoutParams etLp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        etLp.rightMargin = dp(8);
        etLp.bottomMargin = dp(6);
        row.addView(et, etLp);
        Button del = new Button(this);
        del.setText("✕");
        del.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        del.setTextColor(Color.rgb(150, 60, 60));
        android.graphics.drawable.GradientDrawable delBg = new android.graphics.drawable.GradientDrawable();
        delBg.setColor(Color.rgb(253, 240, 240));
        delBg.setCornerRadius(dp(9));
        del.setBackground(delBg);
        LinearLayout.LayoutParams delLp = new LinearLayout.LayoutParams(dp(44), dp(44));
        delLp.bottomMargin = dp(6);
        row.addView(del, delLp);
        del.setOnClickListener(v -> {
            dialogueList.removeView(row);
            saveDialogueLines();
        });
        // 关键：EditText 触摸时会封锁父级 ScrollView 的拦截，垂直滑动需主动放行
        et.setOnTouchListener(new android.view.View.OnTouchListener() {
            private float downY = 0f;
            @Override public boolean onTouch(android.view.View v, android.view.MotionEvent ev) {
                switch (ev.getActionMasked()) {
                    case android.view.MotionEvent.ACTION_DOWN:
                        downY = ev.getRawY();
                        break;
                    case android.view.MotionEvent.ACTION_MOVE:
                        if (Math.abs(ev.getRawY() - downY) > dp(12)) {
                            v.getParent().requestDisallowInterceptTouchEvent(false);
                        }
                        break;
                }
                return false; // 不消费事件，保留光标点击/输入
            }
        });
        et.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence cs, int a, int b, int c) {}
            @Override public void onTextChanged(CharSequence cs, int a, int b, int c) {}
            @Override public void afterTextChanged(android.text.Editable ed) {
                if (!suppressDialogueSave) saveDialogueLines();
            }
        });
        dialogueList.addView(row);
    }

    /** 收集所有台词行保存（空白行忽略；全空回默认） */
    private void saveDialogueLines() {
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        for (int i = 0; i < dialogueList.getChildCount(); i++) {
            android.view.View rowV = dialogueList.getChildAt(i);
            if (rowV instanceof LinearLayout) {
                LinearLayout row = (LinearLayout) rowV;
                if (row.getChildCount() > 0) {
                    String t = ((EditText) row.getChildAt(0)).getText().toString().trim();
                    if (!t.isEmpty()) out.add(t);
                }
            }
        }
        prefs.setDialogueLines(out.isEmpty() ? null : out.toArray(new String[0]));
    }

    // ===== 系统配置 =====
    private void buildSysCard(LinearLayout root) {
        LinearLayout sysCard = card(root, "⚙️ 系统配置");
        modeGroup = new RadioGroup(this);
        modeGroup.setOrientation(RadioGroup.VERTICAL);
        modeGroup.addView(radioS("轻量模式（无通知，杀进程后消失）"));
        modeGroup.addView(radioS("常驻模式（前台服务 + 开机自启，更稳）"));
        sysCard.addView(modeGroup);
        autoStartSwitch = switchRow(sysCard, "开机自启（需常驻模式）");
        globalHueSeek = sliderRow(sysCard, "全局颜色", 0, 360, null);
        globalHueSeek.setOnSeekBarChangeListener(onSeek(v -> prefs.setGlobalHue(v)));
        bubbleHueSeek = sliderRow(sysCard, "气泡颜色", 0, 360, null);
        bubbleHueSeek.setOnSeekBarChangeListener(onSeek(v -> prefs.setBubbleHue(v)));
        resetColorBtn = fieldBtn(sysCard, "重置颜色");
        resetColorBtn.setOnClickListener(v -> {
            prefs.resetColors();
            globalHueSeek.setProgress(prefs.getGlobalHue());
            bubbleHueSeek.setProgress(prefs.getBubbleHue());
            toast("颜色已重置");
        });
    }

    // ===== 按钮 =====
    private void buildButtons(LinearLayout root) {
        startBtn = new Button(this);
        startBtn.setText("🐳 开启悬浮窗挂件");
        startBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        startBtn.setTypeface(Typeface.DEFAULT_BOLD);
        startBtn.setTextColor(Color.WHITE);
        android.graphics.drawable.GradientDrawable btnBg = new android.graphics.drawable.GradientDrawable();
        btnBg.setColors(new int[]{Color.rgb(46, 134, 222), Color.rgb(11, 105, 195)});
        btnBg.setCornerRadius(dp(14));
        startBtn.setBackground(btnBg);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        slp.topMargin = dp(20);
        root.addView(startBtn, slp);
        startBtn.setOnClickListener(v -> startFloat());

        chatBtn = new Button(this);
        chatBtn.setText("💬 找本鱼聊天（AI宠物）");
        chatBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        chatBtn.setTextColor(Color.rgb(11, 37, 69));
        android.graphics.drawable.GradientDrawable chatBg = new android.graphics.drawable.GradientDrawable();
        chatBg.setColor(Color.WHITE);
        chatBg.setCornerRadius(dp(14));
        chatBg.setStroke(dp(1), Color.rgb(46, 134, 222));
        chatBtn.setBackground(chatBg);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        clp.topMargin = dp(12);
        root.addView(chatBtn, clp);
        chatBtn.setOnClickListener(v -> {
            saveKey();
            if (!prefs.hasApiKey()) {
                toast("先配置 API Key 才能聊天哦～");
                return;
            }
            startActivity(new Intent(this, ChatActivity.class));
        });

        TextView note = new TextView(this);
        note.setText("提示：API Key 使用 Android Keystore 加密存储，仅保存在本机。\n"
                + "获取 Key：platform.deepseek.com → API Keys → 创建。\n"
                + "开启挂件需要授予「悬浮窗」权限。");
        note.setTextColor(Color.rgb(93, 109, 126));
        note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        note.setLineSpacing(dp(3), 1.1f);
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nlp.topMargin = dp(16);
        root.addView(note, nlp);
    }

    // ========== 控件工厂 ==========
    private LinearLayout card(LinearLayout parent, String title) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        card.setElevation(dp(3));
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(14));
        card.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14);
        parent.addView(card, lp);
        TextView tv = new TextView(this);
        tv.setText(title);
        tv.setTextColor(Color.rgb(11, 37, 69));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.bottomMargin = dp(8);
        card.addView(tv, tlp);
        return card;
    }

    private TextView overviewCard(String label, String value) {
        TextView tv = new TextView(this);
        tv.setText(label + "\n" + value);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(12), dp(14), dp(12), dp(14));
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(Color.rgb(11, 37, 69));
        bg.setCornerRadius(dp(14));
        tv.setBackground(bg);
        return tv;
    }

    private EditText input(LinearLayout parent, String hint, boolean password) {
        EditText et = new EditText(this);
        et.setHint(hint);
        et.setInputType(InputType.TYPE_CLASS_TEXT | (password ? InputType.TYPE_TEXT_VARIATION_PASSWORD : 0));
        et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        et.setSingleLine(true);
        et.setPadding(dp(12), dp(10), dp(12), dp(10));
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(12));
        bg.setStroke(dp(1), Color.rgb(221, 226, 232));
        et.setBackground(bg);
        parent.addView(et);
        return et;
    }

    private Button fieldBtn(LinearLayout parent, String text) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        Button btn = new Button(this);
        btn.setText(text);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(40));
        lp.topMargin = dp(8);
        parent.addView(btn, lp);
        return btn;
    }

    private SeekBar sliderRow(LinearLayout parent, String text, int min, int max, TextView valueTv) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView tv = fieldLabel(row, text);
        SeekBar sb = new SeekBar(this);
        sb.setMax(max - min);
        sb.setProgress((max - min) / 2);
        row.addView(sb, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (valueTv != null) {
            valueTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            valueTv.setTextColor(Color.rgb(11, 37, 69));
            valueTv.setGravity(Gravity.CENTER);
            valueTv.setMinimumWidth(dp(44));
            row.addView(valueTv);
        }
        parent.addView(row);
        return sb;
    }

    private LinearLayout row(LinearLayout parent, String text) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        fieldLabel(row, text);
        parent.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)));
        return row;
    }

    private TextView fieldLabel(LinearLayout row, String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(Color.rgb(28, 40, 51));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        row.addView(tv, new LinearLayout.LayoutParams(dp(96), ViewGroup.LayoutParams.WRAP_CONTENT));
        return tv;
    }

    private Switch switchRow(LinearLayout parent, String text) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView tv = fieldLabel(row, text);
        tv.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Switch sw = new Switch(this);
        row.addView(sw);
        parent.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        return sw;
    }

    private EditText numberInput(LinearLayout parent, int value) {
        EditText et = new EditText(this);
        et.setText(String.valueOf(value));
        et.setInputType(InputType.TYPE_CLASS_NUMBER);
        et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        et.setSingleLine(true);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(Color.rgb(248, 250, 253));
        bg.setCornerRadius(dp(8));
        bg.setStroke(dp(1), Color.rgb(221, 226, 232));
        et.setBackground(bg);
        return et;
    }

    private RadioButton radioS(String text) {
        RadioButton rb = new RadioButton(this);
        rb.setText(text);
        rb.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        rb.setTextColor(Color.rgb(28, 40, 51));
        return rb;
    }

    private SeekBar.OnSeekBarChangeListener onSeek(java.util.function.Consumer<Integer> cb) {
        return new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean fromUser) {
                if (fromUser && cb != null) cb.accept(p);
            }
            @Override public void onStartTrackingTouch(SeekBar s) {}
            @Override public void onStopTrackingTouch(SeekBar s) {}
        };
    }

    // ========== 逻辑 ==========
    private void loadPrefs() {
        String key = prefs.getApiKey();
        if (key != null) keyInput.setText(key);
        if (prefs.isForegroundMode()) {
            ((RadioButton) modeGroup.getChildAt(1)).setChecked(true);
        } else {
            ((RadioButton) modeGroup.getChildAt(0)).setChecked(true);
        }
        soundSwitch.setChecked(prefs.isSoundEnabled());
        teaseSwitch.setChecked(prefs.isTeaseEnabled());
        autoStartSwitch.setChecked(prefs.isAutoStart());
        costSwitch.setChecked(prefs.isTurnCostEnabled());
        bubbleSwitch.setChecked(prefs.isBubbleEnabled());
        exhaustedSwitch.setChecked(prefs.isExhaustedEnabled());
        float scale = prefs.getFloatScale();
        int level = Math.round(LEVEL_MIN + (scale - SCALE_MIN) / (SCALE_MAX - SCALE_MIN) * (LEVEL_MAX - LEVEL_MIN));
        scaleSeek.setProgress(Math.max(0, Math.min(19, level - LEVEL_MIN)));
        scaleValTv.setText(String.valueOf(level));
        volumeSeek.setProgress((int) (prefs.getVolume() * 100));
        volumeValTv.setText(Math.round(prefs.getVolume() * 100) + "%");
        blinkMinInput.setText(String.valueOf(prefs.getBlinkMinSec()));
        blinkMaxInput.setText(String.valueOf(prefs.getBlinkMaxSec()));
        exhaustedThresholdInput.setText(String.valueOf(prefs.getExhaustedThreshold()));
        buildDialogueRows(prefs.getDialogueLines(), false);
        if ("carousel".equals(prefs.getDialogueMode())) {
            ((RadioButton) dialogueModeGroup.getChildAt(0)).setChecked(true);
        } else {
            ((RadioButton) dialogueModeGroup.getChildAt(1)).setChecked(true);
        }
        dialogueIntervalInput.setText(String.valueOf(prefs.getDialogueIntervalMin()));
        dialogueJitterSeek.setProgress(prefs.getDialogueJitterPct());
        jitterValTv.setText(prefs.getDialogueJitterPct() + "%");
        globalHueSeek.setProgress(prefs.getGlobalHue());
        bubbleHueSeek.setProgress(prefs.getBubbleHue());

        modeGroup.setOnCheckedChangeListener((g, checkedId) -> prefs.setForegroundMode(checkedId == modeGroup.getChildAt(1).getId()));
        dialogueModeGroup.setOnCheckedChangeListener((g, checkedId) -> prefs.setDialogueMode(checkedId == dialogueModeGroup.getChildAt(0).getId() ? "carousel" : "random"));
        soundSwitch.setOnCheckedChangeListener((b, c) -> prefs.setSoundEnabled(c));
        teaseSwitch.setOnCheckedChangeListener((b, c) -> prefs.setTeaseEnabled(c));
        autoStartSwitch.setOnCheckedChangeListener((b, c) -> {
            prefs.setAutoStart(c);
            if (c && !prefs.isForegroundMode()) {
                prefs.setForegroundMode(true);
                ((RadioButton) modeGroup.getChildAt(1)).setChecked(true);
                toast("已自动切换为常驻模式");
            }
        });
        costSwitch.setOnCheckedChangeListener((b, c) -> prefs.setTurnCostEnabled(c));
        bubbleSwitch.setOnCheckedChangeListener((b, c) -> prefs.setBubbleEnabled(c));
        exhaustedSwitch.setOnCheckedChangeListener((b, c) -> prefs.setExhaustedEnabled(c));
    }



    private void saveKey() {
        String key = keyInput.getText().toString().trim();
        prefs.setApiKey(key);
        prefs.setBlinkMinSec(parseInt(blinkMinInput, 4));
        prefs.setBlinkMaxSec(parseInt(blinkMaxInput, 6));
        prefs.setExhaustedThreshold(parseDouble(exhaustedThresholdInput, 5.0));
        prefs.setDialogueIntervalMin(parseInt(dialogueIntervalInput, 5));
    }



    private int parseInt(EditText et, int def) {
        try { return Integer.parseInt(et.getText().toString().trim()); } catch (Exception e) { return def; }
    }

    private double parseDouble(EditText et, double def) {
        try { return Double.parseDouble(et.getText().toString().trim()); } catch (Exception e) { return def; }
    }

    private void startFloat() {
        saveKey();
        if (!Settings.canDrawOverlays(this)) {
            new AlertDialog.Builder(this)
                    .setTitle("需要悬浮窗权限")
                    .setMessage("请允许「小鲸鱼余额挂件」显示在其他应用上层，这样本鱼才能飘在你屏幕上～")
                    .setPositiveButton("去授权", (d, w) -> {
                        Intent it = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                Uri.parse("package:" + getPackageName()));
                        startActivity(it);
                    })
                    .setNegativeButton("取消", null)
                    .show();
            return;
        }
        if (prefs.isForegroundMode() && Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 100);
        }
        Intent it = new Intent(this, WhaleFloatService.class);
        if (prefs.isForegroundMode()) {
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(it);
            } else {
                startService(it);
            }
        } else {
            startService(it);
        }
        toast("小鲸鱼已上线！🐳");
    }

    private void refreshBalanceCards() {
        double cached = prefs.getCachedBalance();
        double today = prefs.getTodayUsed();
        if (cached > 0) {
            balanceCardA.setText("可用额度\n¥ " + String.format("%.2f", cached));
            balanceCardB.setText("今日已用\n¥ " + String.format("%.2f", today));
        } else {
            balanceCardA.setText("可用额度\n¥ --");
            balanceCardB.setText("今日已用\n¥ --");
        }
        if (prefs.hasApiKey()) {
            new Thread(() -> {
                try {
                    BalanceInfo info = DeepSeekApi.getBalance(prefs.getApiKey());
                    prefs.setCachedBalance(info.totalBalance);
                    prefs.setLastUpdateTime(System.currentTimeMillis());
                    runOnUiThread(() -> {
                        balanceCardA.setText("可用额度\n¥ " + String.format("%.2f", info.totalBalance));
                        balanceCardB.setText("今日已用\n¥ " + String.format("%.2f", prefs.getTodayUsed()));
                    });
                } catch (Exception ignored) {}
            }).start();
        }
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}
