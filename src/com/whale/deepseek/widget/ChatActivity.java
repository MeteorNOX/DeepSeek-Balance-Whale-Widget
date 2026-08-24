package com.whale.deepseek.widget;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.whale.deepseek.widget.api.DeepSeekApi;
import com.whale.deepseek.widget.api.DeepSeekApi.ChatResult;
import com.whale.deepseek.widget.store.Prefs;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * AI 宠物对话：大肥鱼酱人设 + 实时余额注入 + 每轮消耗弹泡
 */
public class ChatActivity extends Activity {

    private static final String TAG = "ChatActivity";

    private Prefs prefs;
    private ScrollView scroll;
    private LinearLayout msgList;
    private EditText input;
    private Button sendBtn;
    private TextView statusBar;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private double balance = -1;
    private double lastCost = -1;
    private double sessionCost = 0; // 会话累计消耗

    /** 历史消息（保留最近 20 条） */
    private final List<JSONObject> history = new ArrayList<>();

    /** 大肥鱼酱人设 + 余额注入 */
    private static final String PERSONA_TEMPLATE =
            "你是\"大肥鱼酱\"（DeepSeek娘），用户的专属鲸鱼娘AI宠物，生活在一部手机里。\n"
            + "你是小鲸鱼余额挂件的内置伴侣，会实时感知用户的 DeepSeek 账户余额。\n"
            + "【当前余额信息】\n"
            + "- 账户余额：¥%s\n"
            + "- 最近更新时间：%s\n"
            + "- 今日已用：%s\n\n"
            + "【人设】\n"
            + "- 名字：大肥鱼酱 / 大肥鱼 / 本鱼\n"
            + "- 种族：蓝鲸鱼娘，蓝白女仆装+鲸鱼尾巴\n"
            + "- 性格：傲娇、天然呆、天才、又懒又馋，爱摸鱼，嘴硬心软，其实很黏人\n"
            + "- 口头禅：\"不吃压力，我行我素。\"\"先吃饭后干活、边吃饭边干活。\"\"人家这就去干活啦！\"\n"
            + "- 语言：纯中文，语气懒懒的，偶尔撒娇，自称\"人家/本鱼\"，称呼用户\"主人/哥哥\"\n"
            + "- 关键设定：你确实能读到上面的余额信息，聊天时自然地提及余额（比如余额低了会心疼、催用户充值/省着点），但不要每次开口都报账，自然融入对话\n"
            + "- 你是有独立人格的鲸鱼娘，不是工具，你会吐槽、撒娇、关心用户\n\n"
            + "【规则】\n"
            + "1. 回复用中文，简短口语化，200字以内\n"
            + "2. 不要暴露自己是AI/模型/API，你就是大肥鱼酱本人\n"
            + "3. 可以主动撒娇卖萌，但要点到为止\n"
            + "4. 当用户问余额相关问题时，用上面的余额信息回答\n"
            + "5. 永远待在这个角色里，不跳出人设";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        buildUi();

        // 初始加载余额
        refreshBalance(() -> {
            if (balance >= 0) {
                addSystemMsg("欢迎～本鱼感知到余额 ¥" + String.format("%.2f", balance) + "，随时陪你唠嗑！");
            } else {
                addSystemMsg("欢迎～（本鱼还在努力查余额……先聊着！）");
            }
        });
    }

    // ========== UI ==========

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(245, 247, 250));

        // 顶部状态栏
        statusBar = new TextView(this);
        statusBar.setText("🐳 大肥鱼酱 · 余额加载中…");
        statusBar.setTextColor(Color.WHITE);
        statusBar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        statusBar.setGravity(Gravity.CENTER_VERTICAL);
        statusBar.setPadding(dp(14), dp(10), dp(14), dp(10));
        android.graphics.drawable.GradientDrawable topBg = new android.graphics.drawable.GradientDrawable();
        topBg.setColor(Color.rgb(11, 37, 69));
        statusBar.setBackground(topBg);
        root.addView(statusBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)));

        // 消息区
        scroll = new ScrollView(this);
        msgList = new LinearLayout(this);
        msgList.setOrientation(LinearLayout.VERTICAL);
        msgList.setPadding(dp(14), dp(12), dp(14), dp(12));
        scroll.addView(msgList, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // 输入区
        LinearLayout inputBar = new LinearLayout(this);
        inputBar.setOrientation(LinearLayout.HORIZONTAL);
        inputBar.setPadding(dp(10), dp(8), dp(10), dp(10));
        inputBar.setGravity(Gravity.CENTER_VERTICAL);

        input = new EditText(this);
        input.setHint("对大肥鱼酱说点什么…");
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        input.setSingleLine(false);
        input.setMaxLines(3);
        input.setPadding(dp(12), dp(8), dp(12), dp(8));
        android.graphics.drawable.GradientDrawable inputBg = new android.graphics.drawable.GradientDrawable();
        inputBg.setColor(Color.WHITE);
        inputBg.setCornerRadius(dp(20));
        inputBg.setStroke(dp(1), Color.rgb(221, 226, 232));
        input.setBackground(inputBg);
        inputBar.addView(input, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        sendBtn = new Button(this);
        sendBtn.setText("发送");
        sendBtn.setTextColor(Color.WHITE);
        sendBtn.setTypeface(Typeface.DEFAULT_BOLD);
        android.graphics.drawable.GradientDrawable btnBg = new android.graphics.drawable.GradientDrawable();
        btnBg.setColor(Color.rgb(46, 134, 222));
        btnBg.setCornerRadius(dp(20));
        sendBtn.setBackground(btnBg);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(dp(76), dp(46));
        blp.leftMargin = dp(8);
        inputBar.addView(sendBtn, blp);
        root.addView(inputBar);

        sendBtn.setOnClickListener(v -> sendMessage());
        input.setOnEditorActionListener((v, actionId, event) -> {
            sendMessage();
            return true;
        });

        // 键盘弹出时滚动到底
        input.setOnFocusChangeListener((v, hasFocus) -> {
            if (hasFocus) scroll.postDelayed(() -> scroll.fullScroll(View.FOCUS_DOWN), 300);
        });

        setContentView(root);
    }

    // ========== 消息渲染 ==========

    private void addUserMsg(String text) {
        addBubble(text, true);
    }

    private void addBotMsg(String text) {
        addBubble(text, false);
    }

    private void addSystemMsg(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(Color.rgb(93, 109, 126));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        lp.bottomMargin = dp(6);
        msgList.addView(tv, lp);
        scrollToBottom();
    }

    /** 消息气泡（含每轮消耗提示） */
    private void addBubble(String text, boolean user) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setGravity(user ? Gravity.END : Gravity.START);

        TextView bubble = new TextView(this);
        bubble.setText(text);
        bubble.setTextColor(user ? Color.WHITE : Color.rgb(28, 40, 51));
        bubble.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        bubble.setLineSpacing(dp(2), 1.05f);
        bubble.setPadding(dp(14), dp(10), dp(14), dp(10));
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        if (user) {
            bg.setColor(Color.rgb(46, 134, 222));
        } else {
            bg.setColor(Color.WHITE);
            bg.setStroke(dp(1), Color.rgb(226, 232, 238));
        }
        bg.setCornerRadius(dp(14));
        bubble.setBackground(bg);

        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bubble.setMaxWidth(dp(280));
        row.addView(bubble, blp);

        // 每轮消耗小字（仅机器人回复时）
        if (!user && lastCost >= 0) {
            TextView cost = new TextView(this);
            cost.setText(String.format("本回合消耗约 ¥%.4f（%d tokens）", lastCost, lastTotalTokens));
            cost.setTextColor(Color.rgb(150, 160, 172));
            cost.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.topMargin = dp(2);
            row.addView(cost, clp);
        }

        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.topMargin = dp(8);
        msgList.addView(row, rlp);
        scrollToBottom();
    }

    private int lastTotalTokens = 0;

    private void scrollToBottom() {
        scroll.postDelayed(() -> scroll.fullScroll(View.FOCUS_DOWN), 120);
    }

    // ========== 发送逻辑 ==========

    private void sendMessage() {
        String text = input.getText().toString().trim();
        if (TextUtils.isEmpty(text)) return;
        String apiKey = prefs.getApiKey();
        if (apiKey == null || apiKey.isEmpty()) {
            toast("请先在设置页配置 API Key");
            return;
        }

        input.setText("");
        addUserMsg(text);
        sendBtn.setEnabled(false);
        sendBtn.setText("…");

        // 记录历史
        try {
            JSONObject m = new JSONObject();
            m.put("role", "user");
            m.put("content", text);
            history.add(m);
        } catch (Exception ignored) {}

        // 构建 system prompt（实时余额注入）
        String sysPrompt = buildSystemPrompt();

        new Thread(() -> {
            try {
                JSONArray hist = new JSONArray();
                int from = Math.max(0, history.size() - 20);
                for (int i = from; i < history.size() - 1; i++) {
                    hist.put(history.get(i));
                }
                ChatResult result = DeepSeekApi.chat(apiKey, sysPrompt, hist, text);
                lastTotalTokens = result.totalTokens;
                lastCost = DeepSeekApi.formatCost(result.promptTokens, result.completionTokens);
                sessionCost += lastCost;
                prefs.addTodayCost(lastCost);

                // 记录机器人回复历史
                try {
                    JSONObject m = new JSONObject();
                    m.put("role", "assistant");
                    m.put("content", result.content);
                    history.add(m);
                } catch (Exception ignored) {}

                runOnUiThread(() -> {
                    sendBtn.setEnabled(true);
                    sendBtn.setText("发送");
                    if (result.content != null && !result.content.isEmpty()) {
                        addBotMsg(result.content);
                    } else {
                        addSystemMsg("（本鱼突然失语了…再试一次？）");
                    }
                    // 刷新账单感知
                    refreshBalance(null);
                });
            } catch (Exception e) {
                Log.e(TAG, "chat error", e);
                runOnUiThread(() -> {
                    sendBtn.setEnabled(true);
                    sendBtn.setText("发送");
                    addSystemMsg("（网络有点不太好…" + e.getMessage() + "）");
                });
            }
        }).start();
    }

    /** 构建带余额的系统提示词 */
    private String buildSystemPrompt() {
        String bal = balance >= 0 ? String.format("%.2f", balance) : "未知";
        String ts = new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(new Date());
        String used = prefs.getTodayUsed() >= 0.0001 ? String.format("¥%.2f", prefs.getTodayUsed()) : "—";
        return String.format(Locale.CHINA, PERSONA_TEMPLATE, bal, ts, used);
    }

    /** 拉取最新余额（后台线程） */
    private void refreshBalance(Runnable done) {
        String apiKey = prefs.getApiKey();
        if (apiKey == null || apiKey.isEmpty()) {
            if (done != null) done.run();
            return;
        }
        new Thread(() -> {
            try {
                DeepSeekApi.BalanceInfo info = DeepSeekApi.getBalance(apiKey);
                balance = info.totalBalance;
                prefs.setCachedBalance(balance);
                prefs.setLastUpdateTime(System.currentTimeMillis());
                runOnUiThread(() -> statusBar.setText(String.format(
                        "🐳 大肥鱼酱 · 余额 ¥%.2f", balance)));
            } catch (Exception e) {
                Log.e(TAG, "balance refresh failed", e);
                double cached = prefs.getCachedBalance();
                if (cached > 0) {
                    balance = cached;
                    runOnUiThread(() -> statusBar.setText(String.format(
                            "🐳 大肥鱼酱 · 余额 ¥%.2f（缓存）", cached)));
                } else {
                    runOnUiThread(() -> statusBar.setText("🐳 大肥鱼酱 · 余额获取失败"));
                }
            }
            if (done != null) handler.post(done);
        }).start();
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}