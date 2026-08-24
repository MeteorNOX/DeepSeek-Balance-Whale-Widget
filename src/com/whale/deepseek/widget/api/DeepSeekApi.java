package com.whale.deepseek.widget.api;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * DeepSeek API 客户端
 * 余额查询: GET https://api.deepseek.com/user/balance (需要 sk- API Key)
 * AI 对话: POST https://api.deepseek.com/chat/completions (需要 sk- API Key)
 */
public class DeepSeekApi {

    private static final String BALANCE_URL = "https://api.deepseek.com/user/balance";
    private static final String CHAT_URL = "https://api.deepseek.com/chat/completions";
    private static final int TIMEOUT_MS = 20000;

    /** 余额信息 */
    public static class BalanceInfo {
        public boolean available = false;
        public String currency = "CNY";
        public double totalBalance = 0;
        public double grantedBalance = 0;
        public double toppedUpBalance = 0;
    }

    /** 对话结果 */
    public static class ChatResult {
        public String content = "";
        public int promptTokens = 0;
        public int completionTokens = 0;
        public int totalTokens = 0;
    }

    /** 查询余额 */
    public static BalanceInfo getBalance(String apiKey) throws Exception {
        HttpURLConnection conn = open(BALANCE_URL, "GET", apiKey, null);
        try {
            int code = conn.getResponseCode();
            String body = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (code != 200) {
                throw new Exception("余额接口错误 HTTP " + code + ": " + truncate(body, 200));
            }
            JSONObject root = new JSONObject(body);
            BalanceInfo info = new BalanceInfo();
            info.available = root.optBoolean("is_available", false);
            JSONArray arr = root.optJSONArray("balance_infos");
            if (arr != null && arr.length() > 0) {
                JSONObject b = arr.getJSONObject(0);
                info.currency = b.optString("currency", "CNY");
                info.totalBalance = parseSafe(b.optString("total_balance", "0"));
                info.grantedBalance = parseSafe(b.optString("granted_balance", "0"));
                info.toppedUpBalance = parseSafe(b.optString("topped_up_balance", "0"));
            }
            return info;
        } finally {
            conn.disconnect();
        }
    }

    /**
     * AI 对话（非流式）
     * @param apiKey sk- API Key
     * @param systemPrompt 系统提示词（人设 + 余额注入）
     * @param history 历史消息 JSON 数组 [{role,content},...]（可为 null）
     * @param userMsg 本次用户消息
     */
    public static ChatResult chat(String apiKey, String systemPrompt, JSONArray history, String userMsg) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("model", "deepseek-chat");
        payload.put("stream", false);
        payload.put("temperature", 0.8);
        payload.put("max_tokens", 1200);

        JSONArray messages = new JSONArray();
        if (systemPrompt != null && !systemPrompt.isEmpty()) {
            JSONObject sys = new JSONObject();
            sys.put("role", "system");
            sys.put("content", systemPrompt);
            messages.put(sys);
        }
        if (history != null) {
            for (int i = 0; i < history.length(); i++) {
                messages.put(history.getJSONObject(i));
            }
        }
        JSONObject usr = new JSONObject();
        usr.put("role", "user");
        usr.put("content", userMsg);
        messages.put(usr);

        payload.put("messages", messages);

        HttpURLConnection conn = open(CHAT_URL, "POST", apiKey, payload.toString());
        try {
            int code = conn.getResponseCode();
            String body = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (code != 200) {
                throw new Exception("对话接口错误 HTTP " + code + ": " + truncate(body, 300));
            }
            JSONObject root = new JSONObject(body);
            ChatResult result = new ChatResult();
            JSONArray choices = root.optJSONArray("choices");
            if (choices != null && choices.length() > 0) {
                JSONObject msg = choices.getJSONObject(0).optJSONObject("message");
                if (msg != null) {
                    result.content = msg.optString("content", "");
                }
            }
            JSONObject usage = root.optJSONObject("usage");
            if (usage != null) {
                result.promptTokens = usage.optInt("prompt_tokens", 0);
                result.completionTokens = usage.optInt("completion_tokens", 0);
                result.totalTokens = usage.optInt("total_tokens", 0);
            }
            return result;
        } finally {
            conn.disconnect();
        }
    }

    private static HttpURLConnection open(String url, String method, String apiKey, String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setRequestProperty("Authorization", "Bearer " + apiKey);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "DeepSeekWhaleWidget/1.0 (Android)");
        if (body != null) {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        return conn;
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line);
            }
        }
        return sb.toString();
    }

    private static double parseSafe(String s) {
        try {
            return Double.parseDouble(s.trim());
        } catch (Exception e) {
            return 0;
        }
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() > max ? s.substring(0, max) + "..." : s;
    }

    /** 快捷换算：用量金额（cn币，用于每轮消耗弹泡） */
    public static double formatCost(int promptTokens, int completionTokens) {
        // 参考价：输入 ¥2/百万tokens（缓存未命中），输出 ¥8/百万tokens（以官方最新价为准，仅估算用）
        double inCost = promptTokens * 2.0 / 1_000_000.0;
        double outCost = completionTokens * 8.0 / 1_000_000.0;
        return inCost + outCost;
    }
}