package com.whale.deepseek.widget;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.whale.deepseek.widget.store.Prefs;

/**
 * 开机自启：仅当用户开启「开机自启 + 常驻模式」时启动悬浮窗服务
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        Prefs prefs = new Prefs(context);
        if (prefs.isForegroundMode() && prefs.isAutoStart()) {
            try {
                Intent svc = new Intent(context, WhaleFloatService.class);
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    context.startForegroundService(svc);
                } else {
                    context.startService(svc);
                }
                Log.i(TAG, "boot auto-start service");
            } catch (Exception e) {
                Log.e(TAG, "boot start failed", e);
            }
        }
    }
}