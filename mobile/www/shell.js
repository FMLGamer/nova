// Shared by the connect and error pages of the Android shell.
window.novaShell = {
  /** Asks the server's health check, natively (no CORS in the way), whether this really is Nova. */
  async isNova(url) {
    const http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (!http) return true;
    try {
      const r = await http.get({ url: `${url}/healthz`, connectTimeout: 8000, readTimeout: 8000 });
      const body = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      return r.status === 200 && Boolean(body && body.ok);
    } catch {
      return false;
    }
  },
};
