// Nova for Android is this same web app in a native shell (mobile/), which tags its user agent.
export const androidApp = typeof navigator !== 'undefined' && /\bNovaAndroid\b/.test(navigator.userAgent);

/** Back to the shell's own page to pick another server. */
export function switchServer() {
  location.href = 'https://localhost/index.html?change=1';
}
