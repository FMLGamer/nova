package io.github.fmlgamer.nova;

import android.content.Context;
import android.os.Environment;
import android.util.Log;
import android.webkit.CookieManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Nova on the phone itself: runs the bundled Node.js (Termux's build, installed as libnovanode.so) with the
 * Nova server from the app's assets, like the desktop app does, and signs the WebView in as the owner.
 */
@CapacitorPlugin(name = "NovaLocalServer")
public class LocalServer extends Plugin {
    static final String TAG = "NovaLocal";
    static final int PORT = 11471;
    static final String URL_BASE = "http://127.0.0.1:" + PORT;

    private static Process process;
    /** The server's stdin: held open so the server exits when the app goes away. */
    private static OutputStream lifeline;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", nodeBinary(getContext()).exists());
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        new Thread(() -> {
            try {
                JSObject r = new JSObject();
                r.put("url", ensureRunning(getContext()));
                call.resolve(r);
            } catch (Exception e) {
                Log.e(TAG, "start failed", e);
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        }, "nova-local-start").start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    static File nodeBinary(Context ctx) {
        return new File(ctx.getApplicationInfo().nativeLibraryDir, "libnovanode.so");
    }

    private static boolean alive() {
        if (process == null) return false;
        try {
            process.exitValue();
            return false;
        } catch (IllegalThreadStateException running) {
            return true;
        }
    }

    static synchronized void stopServer() {
        if (process != null) process.destroy();
        process = null;
        lifeline = null;
    }

    /** Starts the server unless it already runs, waits until it answers, and signs the WebView in. Returns its address. */
    static synchronized String ensureRunning(Context ctx) throws Exception {
        if (!nodeBinary(ctx).exists()) throw new IOException("This build of Nova can't run a server on the phone");
        File home = new File(ctx.getFilesDir(), "nova");
        File keyFile = new File(home, "desktop.key");
        if (!alive() && !healthy()) {
            File server = unpack(ctx, home);
            spawn(ctx, home, server, secret(keyFile), secret(new File(home, "session.secret")));
        }
        waitHealthy(home);
        signIn(secret(keyFile));
        return URL_BASE;
    }

    /** A random value kept in the app's private storage (created the first time). */
    private static String secret(File file) throws IOException {
        if (file.exists()) {
            String s = readAll(new java.io.FileInputStream(file)).trim();
            if (s.length() >= 32) return s;
        }
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        StringBuilder hex = new StringBuilder();
        for (byte x : b) hex.append(String.format("%02x", x));
        file.getParentFile().mkdirs();
        try (FileWriter w = new FileWriter(file)) {
            w.write(hex.toString());
        }
        return hex.toString();
    }

    /** The server and web app from the APK, unpacked once per version. */
    private static File unpack(Context ctx, File home) throws Exception {
        File dir = new File(home, "app");
        File stamp = new File(dir, ".version");
        String version = new JSONObject(readAll(ctx.getAssets().open("nova-server.json"))).getString("version");
        if (stamp.exists() && version.equals(readAll(new java.io.FileInputStream(stamp)).trim())) return dir;
        Log.i(TAG, "unpacking Nova " + version);
        deleteTree(dir);
        dir.mkdirs();
        String root = dir.getCanonicalPath() + File.separator;
        byte[] buf = new byte[64 * 1024];
        try (ZipInputStream zip = new ZipInputStream(ctx.getAssets().open("nova-server.zip"))) {
            for (ZipEntry e; (e = zip.getNextEntry()) != null; ) {
                File out = new File(dir, e.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("Bad entry " + e.getName());
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                out.getParentFile().mkdirs();
                try (FileOutputStream os = new FileOutputStream(out)) {
                    for (int n; (n = zip.read(buf)) > 0; ) os.write(buf, 0, n);
                }
            }
        }
        try (InputStream in = ctx.getAssets().open("nova-cacert.pem"); FileOutputStream os = new FileOutputStream(new File(home, "cacert.pem"))) {
            for (int n; (n = in.read(buf)) > 0; ) os.write(buf, 0, n);
        }
        try (FileWriter w = new FileWriter(stamp)) {
            w.write(version);
        }
        return dir;
    }

    private static void spawn(Context ctx, File home, File app, String key, String sessionSecret) throws IOException {
        String libs = ctx.getApplicationInfo().nativeLibraryDir;
        File logs = new File(home, "logs");
        logs.mkdirs();
        File log = new File(logs, "server.log");
        if (log.length() > 5L * 1024 * 1024) log.renameTo(new File(logs, "server.log.1"));
        File movies = ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES);
        File library = new File(movies != null ? movies : new File(home, "library"), "Nova");
        File cache = new File(ctx.getCacheDir(), "nova");
        cache.mkdirs();

        ProcessBuilder pb = new ProcessBuilder(nodeBinary(ctx).getAbsolutePath(), new File(app, "server/dist/index.js").getAbsolutePath());
        pb.directory(new File(app, "server"));
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("LD_LIBRARY_PATH", libs);
        env.put("PATH", libs + ":/system/bin");
        env.put("HOME", home.getAbsolutePath());
        env.put("TMPDIR", cache.getAbsolutePath());
        env.put("SSL_CERT_FILE", new File(home, "cacert.pem").getAbsolutePath());
        env.put("NODE_EXTRA_CA_CERTS", new File(home, "cacert.pem").getAbsolutePath());
        env.put("NODE_ENV", "production");
        env.put("NOVA_MODE", "desktop");
        env.put("NOVA_EXIT_WITH_PARENT", "1");
        env.put("HOST", "127.0.0.1");
        env.put("PORT", String.valueOf(PORT));
        env.put("DATA_DIR", new File(home, "data").getAbsolutePath());
        env.put("TORRENT_DIR", new File(cache, "torrents").getAbsolutePath());
        env.put("LIBRARY_DIR", library.getAbsolutePath());
        env.put("WEB_DIR", new File(app, "web").getAbsolutePath());
        env.put("SESSION_SECRET", sessionSecret);
        env.put("ADMIN_USERNAME", "owner");
        env.put("NOVA_DESKTOP_KEY", key);
        env.put("MAX_TRANSCODES", "0");
        env.put("CACHE_TOTAL_MB", "4096");
        Log.i(TAG, "starting the server");
        process = pb.start();
        lifeline = process.getOutputStream();
        final Process p = process;
        Thread pump = new Thread(() -> {
            byte[] buf = new byte[8192];
            try (InputStream in = p.getInputStream(); FileOutputStream out = new FileOutputStream(log, true)) {
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    out.flush();
                }
            } catch (IOException ignored) {
                // the server went away
            }
        }, "nova-local-log");
        pump.setDaemon(true);
        pump.start();
    }

    private static boolean healthy() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(URL_BASE + "/healthz").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(3000);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (IOException e) {
            return false;
        }
    }

    private static void waitHealthy(File home) throws Exception {
        long deadline = System.currentTimeMillis() + 120_000;
        while (System.currentTimeMillis() < deadline) {
            if (healthy()) return;
            if (process != null && !alive()) throw new IOException("The server stopped while starting (code " + process.exitValue() + "). " + tail(new File(home, "logs/server.log")));
            Thread.sleep(500);
        }
        throw new IOException("The server didn't start in time. " + tail(new File(home, "logs/server.log")));
    }

    /** Exchanges the key for the owner's session, as a cookie for the WebView. */
    private static void signIn(String key) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(URL_BASE + "/api/desktop/session").openConnection();
        c.setRequestMethod("POST");
        c.setRequestProperty("X-Nova-Desktop-Key", key);
        c.setConnectTimeout(5000);
        c.setReadTimeout(10000);
        c.setDoOutput(true);
        c.getOutputStream().close();
        if (c.getResponseCode() != 200) throw new IOException("Signing in to the server on this phone failed (" + c.getResponseCode() + ")");
        JSONObject body = new JSONObject(readAll(c.getInputStream()));
        c.disconnect();
        CookieManager cookies = CookieManager.getInstance();
        cookies.setCookie(URL_BASE, "stream_session=" + body.getString("token") + "; Path=/; Max-Age=" + body.getLong("maxAge") + "; HttpOnly; SameSite=Lax");
        cookies.flush();
    }

    private static String tail(File file) {
        try (RandomAccessFile f = new RandomAccessFile(file, "r")) {
            long from = Math.max(0, f.length() - 600);
            f.seek(from);
            byte[] b = new byte[(int) (f.length() - from)];
            f.readFully(b);
            return new String(b, StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return "";
        }
    }

    private static String readAll(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) sb.append(line).append('\n');
        }
        return sb.toString();
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
