import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { ApiError, isUpstreamError } from './lib/api';
import { noticeUpstream, upstreamRetryDelay } from './lib/upstream';
import './index.css';

const queryClient = new QueryClient({
  // Whatever still failed after the retries: say what and why.
  queryCache: new QueryCache({ onError: (e) => noticeUpstream(e) }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      // AniList, TMDB and co. being busy is temporary: a few tries, after the pause the server suggests.
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < (isUpstreamError(e) ? 3 : 1),
      retryDelay: (n, e) => (isUpstreamError(e) ? upstreamRetryDelay(n, e) : Math.min(1000 * 2 ** n, 30_000)),
    },
  },
});

if (import.meta.env.PROD) registerSW({ immediate: true });

// Image errors don't bubble: catch them on the way down and let CSS hide the broken image.
document.addEventListener('error', (e) => e.target instanceof HTMLImageElement && (e.target.dataset.broken = ''), true);
document.addEventListener('load', (e) => e.target instanceof HTMLImageElement && delete e.target.dataset.broken, true);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <MotionConfig reducedMotion="user" transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}>
          <App />
        </MotionConfig>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
