package io.github.fmlgamer.nova;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalServer.class);
        super.onCreate(savedInstanceState);
        // Test builds: `am start ... --ez novaLocalServer true` starts the phone's own server without the UI (CI smoke test).
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable && getIntent().getBooleanExtra("novaLocalServer", false)) {
            new Thread(() -> {
                try {
                    Log.i(LocalServer.TAG, "local server ready at " + LocalServer.ensureRunning(this));
                } catch (Exception e) {
                    Log.e(LocalServer.TAG, "local server failed", e);
                }
            }, "nova-local-test").start();
        }
    }
}
