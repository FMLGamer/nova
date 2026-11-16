import '@fontsource-variable/literata';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/opendyslexic/400.css';
import literataUrl from '@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url';
import atkinsonUrl from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url';
import atkinsonBoldUrl from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url';
import dyslexicUrl from '@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2?url';

export const READING_FONTS = {
  literata: { label: 'Literata', css: '"Literata Variable", Georgia, serif' },
  atkinson: { label: 'Atkinson Hyperlegible', css: '"Atkinson Hyperlegible", system-ui, sans-serif' },
  dyslexic: { label: 'OpenDyslexic', css: '"OpenDyslexic", sans-serif' },
  serif: { label: 'Classic serif', css: 'Georgia, "Times New Roman", serif' },
  sans: { label: 'Inter', css: '"Inter Variable", system-ui, sans-serif' },
} as const;

/** @font-face rules for documents that can't see the app's stylesheets (EPUB iframes). */
export function fontFaceCss(): string {
  const abs = (u: string) => new URL(u, location.href).toString();
  return `
@font-face{font-family:"Literata Variable";src:url("${abs(literataUrl)}") format("woff2");font-weight:200 900;font-display:swap}
@font-face{font-family:"Atkinson Hyperlegible";src:url("${abs(atkinsonUrl)}") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Atkinson Hyperlegible";src:url("${abs(atkinsonBoldUrl)}") format("woff2");font-weight:700;font-display:swap}
@font-face{font-family:"OpenDyslexic";src:url("${abs(dyslexicUrl)}") format("woff2");font-weight:400;font-display:swap}`;
}
