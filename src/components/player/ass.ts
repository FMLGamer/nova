import { useEffect, useRef } from 'react';
import type JASSUB from 'jassub';
import type { SubBlock } from './subtitles';

/**
 * Renders a Matroska ASS/SSA track with libass (JASSUB) so typesetting, signs,
 * karaoke and embedded fonts look exactly as the release intended. Blocks are
 * fed as they stream in; libass de-duplicates repeats by ReadOrder.
 */
export function useAssRenderer(opts: {
  enabled: boolean;
  video: HTMLVideoElement | null;
  /** An empty, absolutely positioned element over the video; the canvas is created inside it. */
  host: HTMLElement | null;
  header: string | null;
  blocks: { current: SubBlock[] } | null;
  version: number;
  fonts: string[];
  /** Added to the video's clock (piped streams start at 0; minus the user's delay). */
  timeOffset: number;
  onError: (message: string) => void;
}) {
  const { enabled, video, host, header, blocks, version, fonts, timeOffset, onError } = opts;
  const inst = useRef<JASSUB | null>(null);
  const fed = useRef(0);
  const offset = useRef(timeOffset);
  offset.current = timeOffset;

  const feed = () => {
    const j = inst.current;
    const list = blocks?.current;
    if (!j || !list) return;
    for (let i = fed.current; i < list.length; i++) {
      const [start, dur, text] = list[i]!;
      void j.renderer.processChunk(text, start, dur);
    }
    fed.current = list.length;
  };

  const fontKey = fonts.join('|');
  const videoRef = useRef(video);
  videoRef.current = video;
  const hasVideo = Boolean(video);
  useEffect(() => {
    const v = videoRef.current;
    if (!enabled || !v || !host || !header) return;
    let cancelled = false;
    let j: JASSUB | null = null;
    // A canvas can only be handed to one worker, and destroy() removes it: one per instance.
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
    host.appendChild(canvas);
    (async () => {
      const { default: Renderer } = await import('jassub');
      if (cancelled) return;
      j = new Renderer({
        video: v,
        canvas,
        subContent: header,
        fonts,
        timeOffset: offset.current,
        queryFonts: false,
        // Sharp enough on any screen; 4K renders cost ~4x the memory for no visible gain under video.
        maxRenderHeight: 1440,
      });
      await j.ready;
      if (cancelled) return;
      inst.current = j;
      fed.current = 0;
      feed();
    })().catch((e: unknown) => {
      if (!cancelled) onError(e instanceof Error ? e.message : 'Styled subtitles failed');
    });
    return () => {
      cancelled = true;
      inst.current = null;
      if (j) void j.destroy().catch(() => undefined);
      canvas.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, hasVideo, host, header, fontKey]);

  // A new <video> (another stream mode or a seek in a converted stream) keeps the same renderer.
  useEffect(() => {
    const j = inst.current;
    if (j && video && j._video !== video) void j.setVideo(video);
  }, [video]);

  useEffect(feed, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (inst.current) inst.current.timeOffset = timeOffset;
  }, [timeOffset]);

  return inst;
}
