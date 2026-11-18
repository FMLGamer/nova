import { Fragment, type ReactNode } from 'react';
import { cls } from '../lib/format';
import { pageLayout, type PageId } from '../lib/layout';
import { usePrefs } from '../lib/queries';
import type { HeroSize } from '../lib/types';
import { HERO_HEIGHT } from './Hero';

/**
 * A page made of the profile's chosen sections, under its hero. `hero` returns null when there is
 * nothing to feature; without a hero the content starts below the top bar instead of under it.
 */
export function PageLayout({ page, title, hero, sections }: { page: PageId; title: string; hero: (size: HeroSize) => ReactNode; sections: Record<string, ReactNode> }) {
  const { data: prefs } = usePrefs();
  const layout = pageLayout(page, prefs);
  const top = layout.hero ? hero(layout.heroSize) : null;
  // The two tall heroes fade into the first row; the shorter ones sit above it.
  const join = layout.heroSize === 'full' ? '-mt-[6svh]' : layout.heroSize === 'large' ? '-mt-[2svh]' : 'mt-12';
  return (
    <div className={cls('pb-10', !top && 'pt-24 sm:pt-28')}>
      <h1 className="sr-only">{title}</h1>
      {top}
      <div className={cls('relative z-10', page === 'home' ? 'space-y-10' : 'space-y-12', top ? join : null)}>
        {layout.sections.map((id) => (
          <Fragment key={id}>{sections[id] ?? null}</Fragment>
        ))}
      </div>
    </div>
  );
}

export const HeroSkeleton = ({ size }: { size: HeroSize }) => <div className={cls(HERO_HEIGHT[size], 'skeleton')} />;
