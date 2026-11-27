import { motion } from 'motion/react';
import { Fragment, useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, LayoutGrid, Link2, Palette, Play, Plus, Sparkles, Subtitles, Trash2, UserRound, BookOpen, Info, ListChecks, SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api';
import { cls, LANGUAGES, relTime, reportIssueUrl } from '../lib/format';
import { fuzzyMatch } from '../lib/fuzzy';
import { useAppConfig, usePrefs, useProfile, useSavePrefs, useSession } from '../lib/queries';
import { READING_FONTS } from '../lib/reading-fonts';
import { errorText, toast } from '../lib/store';
import { PLATFORM_NAME, desktop, useDesktopInfo, type DesktopSettings } from '../lib/desktop';
import { androidApp, switchServer } from '../lib/mobile';
import type { AssistantProvider, Preferences, SubtitleStyle } from '../lib/types';
import { Avatar, Badge, Button, Card, Chip, Input, Row, Segmented, Select, SettingsFilter, SettingsGroup as Group, SettingsSearch, Slider, Spinner, Switch, TextArea } from '../components/ui';
import { cueStyle } from '../components/player/subtitles';
import { SHORTCUTS, keyLabel, shortcutMap } from '../components/player/shortcuts';
import { ProfileEditor } from './Profiles';
import { BetaSection, CustomizeSection, ImportHistory } from './SettingsCustomize';
import { themeColors } from '../components/reader/common';

/** The menu, in categories; whatever only some people need lives under Advanced. */
const SECTIONS = [
  { id: '', label: 'Profile', icon: UserRound, group: 'You' },
  { id: 'account', label: 'Account & sharing', icon: KeyRound, group: 'You' },
  { id: 'tracking', label: 'Anime & manga tracking', icon: ListChecks, group: 'You' },
  { id: 'playback', label: 'Playback', icon: Play, group: 'Watching & reading' },
  { id: 'subtitles', label: 'Subtitles', icon: Subtitles, group: 'Watching & reading' },
  { id: 'reading', label: 'Reading', icon: BookOpen, group: 'Watching & reading' },
  { id: 'appearance', label: 'Appearance', icon: Palette, group: 'Look & feel' },
  { id: 'customize', label: 'Pages & menus', icon: LayoutGrid, group: 'Look & feel' },
  { id: 'assistant', label: 'Assistant', icon: Sparkles, group: 'Nova' },
  { id: 'about', label: 'About & updates', icon: Info, group: 'Nova' },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal, group: 'Advanced' },
];
/** Pages that moved into Advanced, for old links. */
const MOVED: Record<string, string> = { home: 'customize', sources: 'advanced', beta: 'advanced' };

function MultiChips({ value, options, onChange }: { value: string[]; options: { value: string; label: string }[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <Chip key={o.value} active={on} onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}>
            {o.label}
          </Chip>
        );
      })}
    </div>
  );
}

function LangSelect({ value, onChange, allowNone }: { value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-48">
      {allowNone && <option value="">None</option>}
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </Select>
  );
}

function ProfileSection() {
  const profile = useProfile();
  const { data: session } = useSession();
  const [editing, setEditing] = useState(false);
  if (!profile || !session) return null;
  return (
    <>
      <Card className="mb-5 flex items-center gap-5">
        <Avatar avatar={profile.avatar} name={profile.name} className="size-20 text-3xl" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-2xl font-semibold">{profile.name}</div>
          <div className="text-sm text-muted">
            @{session.account.username}
            {profile.isKids ? ' · Kids profile' : ''}
          </div>
        </div>
        <Button onClick={() => setEditing(true)}>Edit</Button>
      </Card>
      <Group title="Everything this profile keeps to itself" hint="Watch history, reading progress, My List, collections, your Home screen and every preference on these pages are per profile.">
        <Row label="Profiles on this account" hint={session.settings.multiProfile ? `Up to ${session.settings.maxProfiles}` : 'Ask an admin to allow more'}>
          <span className="text-sm text-muted">{session.profiles.length}</span>
        </Row>
      </Group>
      <ImportHistory />
      {editing && <ProfileEditor profile={profile} onClose={() => setEditing(false)} />}
    </>
  );
}

function ShortcutsGroup({ p, set }: { p: Preferences; set: (x: object) => void }) {
  const [recording, setRecording] = useState<string | null>(null);
  const custom = p.ui.shortcuts ?? {};
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Escape' && !['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) set({ ui: { shortcuts: { [recording]: e.key.toLowerCase() } } });
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [recording, set]);
  const used = shortcutMap(custom);
  return (
    <Group title="Keyboard shortcuts" hint="Click a shortcut, then press the key you want. Esc cancels.">
      {SHORTCUTS.map((s) => {
        const keys = custom[s.id] ? [custom[s.id]!] : [...s.keys];
        const clash = keys.some((k) => used.get(k) !== s.id);
        return (
          <Row key={s.id} label={s.label} hint={clash ? 'That key already does something else' : undefined}>
            <div className="flex items-center gap-2">
              {custom[s.id] && (
                <button onClick={() => set({ ui: { shortcuts: { [s.id]: '' } } })} className="text-xs text-muted hover:text-fg">
                  Reset
                </button>
              )}
              <button
                onClick={() => setRecording(recording === s.id ? null : s.id)}
                className={cls('min-w-20 rounded-lg border px-2.5 py-1 font-mono text-xs', recording === s.id ? 'border-accent text-accent' : 'border-line text-fg hover:border-line-strong')}
              >
                {recording === s.id ? 'Press a key…' : keys.map(keyLabel).join(' / ')}
              </button>
            </div>
          </Row>
        );
      })}
    </Group>
  );
}

function PlaybackSection({ p, set }: { p: Preferences; set: (x: object) => void }) {
  const ui = p.ui;
  const dub = p.anime.audioLanguages;
  const animeAudio = dub.length === 1 && dub[0] === 'ja' ? 'sub' : dub[0] === 'ja' ? 'dual' : 'dub';
  return (
    <>
      <Group title="Starting things">
        <Row label="Pick the best source for me" hint="Skip the source list and start the top match (your server's copy first).">
          <Switch checked={ui.autoSelectSource} onChange={(v) => set({ ui: { autoSelectSource: v } })} />
        </Row>
        <Row label="Play the next episode automatically">
          <Switch checked={ui.autoplayNext} onChange={(v) => set({ ui: { autoplayNext: v } })} />
        </Row>
        <Row label="Play trailers in the background" hint="On Home and title pages, muted until you unmute.">
          <Switch checked={ui.autoplayPreviews} onChange={(v) => set({ ui: { autoplayPreviews: v } })} />
        </Row>
        <Row label="Skip intros automatically">
          <Switch checked={ui.skipIntroAutomatically} onChange={(v) => set({ ui: { skipIntroAutomatically: v } })} />
        </Row>
        <Row label="Skip credits automatically" hint="Jumps straight to the next episode when there is one.">
          <Switch checked={ui.skipCreditsAutomatically} onChange={(v) => set({ ui: { skipCreditsAutomatically: v } })} />
        </Row>
        <Row label="Skip without intro data" hint="When Nova doesn't know where an episode's intro or credits are, Skip jumps ahead this far. Off hides the button then." stack>
          <Slider value={ui.skipFallbackSeconds} min={0} max={180} step={5} onChange={(v) => set({ ui: { skipFallbackSeconds: v } })} format={(v) => (v ? `${v} s` : 'Off')} />
        </Row>
        <Row label="Default speed" stack>
          <Slider value={ui.playbackSpeed} min={0.25} max={3} step={0.05} onChange={(v) => set({ ui: { playbackSpeed: Math.round(v * 100) / 100 } })} format={(v) => `${v.toFixed(2)}×`} />
        </Row>
      </Group>
      <Group title="Picture">
        <Row
          label="Enhancement"
          hint="Runs on your GPU in the browser. Anime4K sharpens line art; deband smooths gradients. With None, the graphics driver's own upscaling and HDR (NVIDIA RTX Video) can work on the picture instead."
        >
          <Select value={ui.enhance} onChange={(e) => set({ ui: { enhance: e.target.value } })} className="w-40">
            <option value="none">Off</option>
            <option value="sharpen">Sharpen</option>
            <option value="anime4k">Anime4K</option>
            <option value="deband">Deband</option>
            <option value="custom">Custom GLSL</option>
          </Select>
        </Row>
        {ui.enhance === 'custom' && (
          <Row stack label="Custom shader chain" hint={<>GLSL ES 3 passes separated by <code>//!PASS</code>. Each defines <code>vec4 hook(sampler2D tex, vec2 uv, vec2 px)</code>; <code>luma()</code> and <code>t</code> are available.</>}>
            <TextArea
              defaultValue={ui.customShader}
              onBlur={(e) => set({ ui: { customShader: e.target.value } })}
              className="min-h-40 font-mono text-xs"
              placeholder={'vec4 hook(sampler2D tex, vec2 uv, vec2 px){\n  vec4 c = texture(tex, uv);\n  return vec4(pow(c.rgb, vec3(0.95)), 1.);\n}'}
            />
          </Row>
        )}
      </Group>
      <Group title="Anime">
        <Row label="Audio">
          <Segmented
            size="sm"
            value={animeAudio}
            onChange={(v) => set({ anime: { audioLanguages: v === 'sub' ? ['ja'] : v === 'dual' ? ['ja', 'en'] : ['en', 'ja'] } })}
            options={[
              { value: 'sub', label: 'Japanese only' },
              { value: 'dual', label: 'Either' },
              { value: 'dub', label: 'Prefer English dub' },
            ]}
          />
        </Row>
      </Group>
      <ShortcutsGroup p={p} set={set} />
    </>
  );
}

/** Advanced: transcoding and outside players. */
function CompatibilityGroup({ p, set }: { p: Preferences; set: (x: object) => void }) {
  const { data: session } = useSession();
  const ui = p.ui;
  return (
    <Group title="Compatibility">
      {session?.settings.transcodingEnabled ? (
        <>
          <Row label="Always transcode" hint="Converts every stream on the server. Use for weak devices; costs quality and server CPU.">
            <Switch checked={ui.transcode} onChange={(v) => set({ ui: { transcode: v } })} />
          </Row>
          <Row label="Transcode resolution">
            <Segmented size="sm" value={String(ui.transcodeHeight)} onChange={(v) => set({ ui: { transcodeHeight: Number(v) } })} options={[{ value: '480', label: '480p' }, { value: '720', label: '720p' }, { value: '1080', label: '1080p' }]} />
          </Row>
        </>
      ) : (
        <p className="py-3 text-sm text-muted">Nova fixes unplayable audio on the fly. Full video transcoding needs an admin to enable it for your account.</p>
      )}
      <Row label="Preferred external player" hint="Highlighted in the player's “Open in” menu.">
        <Segmented size="sm" value={ui.externalPlayer || 'none'} onChange={(v) => set({ ui: { externalPlayer: v === 'none' ? '' : v } })} options={[{ value: 'none', label: 'None' }, { value: 'vlc', label: 'VLC' }, { value: 'mpv', label: 'mpv' }, { value: 'iina', label: 'IINA' }]} />
      </Row>
    </Group>
  );
}

function SubtitlesSection({ p, set }: { p: Preferences; set: (x: object) => void }) {
  const s = p.ui.subtitleStyle;
  const style = (x: Partial<SubtitleStyle>) => set({ ui: { subtitleStyle: x } });
  return (
    <>
      <div className="relative mb-5 aspect-[21/9] overflow-hidden rounded-3xl bg-[radial-gradient(ellipse_at_30%_20%,#3b4a6b,transparent_60%),radial-gradient(ellipse_at_80%_70%,#6b3b4a,transparent_55%),linear-gradient(#1a2030,#0d1018)] ring-1 ring-white/10">
        <div className="absolute inset-0 bg-black/20" />
        <div className="absolute inset-x-0 flex justify-center px-6 text-center" style={{ bottom: `${s.position}%` }}>
          <span style={cueStyle(s, 0.8)}>We're going to need a bigger boat.</span>
        </div>
      </div>
      <Group title="Choosing subtitles">
        <Row label="Turn subtitles on automatically" hint="Uses a track inside the file first, then OpenSubtitles. Skipped when the audio is already in your language (except anime).">
          <Switch checked={p.ui.autoSelectSubtitles} onChange={(v) => set({ ui: { autoSelectSubtitles: v } })} />
        </Row>
        <Row label="Language">
          <LangSelect value={p.ui.subtitleLanguage} onChange={(v) => set({ ui: { subtitleLanguage: v } })} />
        </Row>
        <Row label="Second language" hint="Shown smaller above the main line — handy for learning.">
          <LangSelect allowNone value={p.ui.secondarySubtitleLanguage} onChange={(v) => set({ ui: { secondarySubtitleLanguage: v } })} />
        </Row>
        <Row label="Translate when missing" hint="Machine-translates the best available track into your language.">
          <Switch checked={p.ui.translateSubtitles} onChange={(v) => set({ ui: { translateSubtitles: v } })} />
        </Row>
        <Row label="Keep original styling" hint="Anime-style ASS tracks render with their own fonts, signs and karaoke. Off uses your look below.">
          <Switch checked={p.ui.styledSubtitles !== false} onChange={(v) => set({ ui: { styledSubtitles: v } })} />
        </Row>
        <Row label="Translation service">
          <Segmented size="sm" value={p.ui.translateProvider} onChange={(v) => set({ ui: { translateProvider: v } })} options={[{ value: 'google', label: 'Google' }, { value: 'deepl', label: 'DeepL' }, { value: 'assistant', label: 'AI model' }]} />
        </Row>
        <Row stack label="Never pick tracks named" hint="Comma-separated. Tracks whose name contains one of these are skipped when subtitles turn on automatically (you can still pick them).">
          <Input
            key={p.ui.subtitleIgnore.join(',')}
            defaultValue={p.ui.subtitleIgnore.join(', ')}
            onBlur={(e) => set({ ui: { subtitleIgnore: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })}
          />
        </Row>
      </Group>
      <Group title="Look">
        <Row label="Typeface">
          <Select value={s.fontFamily} onChange={(e) => style({ fontFamily: e.target.value as SubtitleStyle['fontFamily'] })} className="w-48">
            <option value="sans">Inter</option>
            <option value="serif">Serif</option>
            <option value="mono">Monospace</option>
            <option value="rounded">Rounded</option>
            <option value="atkinson">Atkinson Hyperlegible</option>
            <option value="dyslexic">OpenDyslexic</option>
          </Select>
        </Row>
        <Row label="Size" stack>
          <Slider value={s.fontSize} min={60} max={200} step={5} onChange={(v) => style({ fontSize: v })} format={(v) => `${v}%`} />
        </Row>
        <Row label="Weight" stack>
          <Slider value={s.weight} min={400} max={900} step={100} onChange={(v) => style({ weight: v })} format={(v) => String(v)} />
        </Row>
        <Row label="Colour">
          <div className="flex items-center gap-2">
            {['#ffffff', '#fde047', '#a7f3d0', '#bae6fd'].map((c) => (
              <button key={c} onClick={() => style({ color: c })} aria-label={c} className={cls('size-7 rounded-full ring-2', s.color === c ? 'ring-accent' : 'ring-white/10')} style={{ background: c }} />
            ))}
            <input type="color" value={s.color} onChange={(e) => style({ color: e.target.value })} className="size-7 cursor-pointer rounded-full bg-transparent" />
          </div>
        </Row>
        <Row label="Text opacity" stack>
          <Slider value={s.opacity} min={30} max={100} step={5} onChange={(v) => style({ opacity: v })} format={(v) => `${v}%`} />
        </Row>
        <Row label="Background box" stack>
          <Slider value={s.background} min={0} max={100} step={5} onChange={(v) => style({ background: v })} format={(v) => `${v}%`} />
        </Row>
        <Row label="Edge">
          <Select value={s.edge} onChange={(e) => style({ edge: e.target.value as SubtitleStyle['edge'] })} className="w-40">
            <option value="none">None</option>
            <option value="outline">Outline</option>
            <option value="shadow">Drop shadow</option>
            <option value="raised">Raised</option>
            <option value="depressed">Depressed</option>
          </Select>
        </Row>
        <Row label="Height from bottom" stack>
          <Slider value={s.position} min={2} max={40} onChange={(v) => style({ position: v })} format={(v) => `${v}%`} />
        </Row>
      </Group>
    </>
  );
}

const QUALITIES = ['2160p', '1080p', '720p', '480p'].map((q) => ({ value: q, label: q === '2160p' ? '4K' : q }));
const CODECS = ['h264', 'h265', 'av1'].map((v) => ({ value: v, label: v.toUpperCase() }));
const AUDIO = ['aac', 'opus', 'mp3', 'eac3', 'ac3', 'dts', 'truehd', 'flac'].map((v) => ({ value: v, label: v.toUpperCase() }));
const SOURCES = [
  { value: 'remux', label: 'Remux' },
  { value: 'bluray', label: 'Blu-ray' },
  { value: 'webdl', label: 'WEB-DL' },
  { value: 'web', label: 'WEBRip' },
  { value: 'hdtv', label: 'HDTV' },
  { value: 'dvd', label: 'DVD' },
];

function SourcesGroups({ p, set }: { p: Preferences; set: (x: object) => void }) {
  const t = p.torrent;
  return (
    <>
      <Group
        title="Which sources are OK"
        hint="Pick everything you're happy with. Of the sources that fit, the one with the most seeders plays. Sources that don't fit are still listed under More sources."
      >
        <Row stack label="Resolution">
          <MultiChips value={t.qualities} options={QUALITIES} onChange={(v) => set({ torrent: { qualities: v } })} />
        </Row>
        <Row stack label="Video codecs" hint="H.264 plays everywhere; H.265 and AV1 are smaller but need a recent device.">
          <MultiChips value={t.codecs} options={CODECS} onChange={(v) => set({ torrent: { codecs: v } })} />
        </Row>
        <Row stack label="Audio" hint="Nova converts audio browsers can't play, so all of these work.">
          <MultiChips value={t.audioCodecs} options={AUDIO} onChange={(v) => set({ torrent: { audioCodecs: v } })} />
        </Row>
        <Row stack label="Release type" hint="Remuxes are untouched disc copies: the best picture, but very large files.">
          <MultiChips value={t.formats} options={SOURCES} onChange={(v) => set({ torrent: { formats: v } })} />
        </Row>
        <Row stack label="Audio languages">
          <MultiChips value={t.preferredLanguages} options={LANGUAGES.slice(0, 12).map((l) => ({ value: l.code, label: l.name }))} onChange={(v) => set({ torrent: { preferredLanguages: v } })} />
        </Row>
        <Row label="Biggest file" stack>
          <Slider value={t.maxSizeGb} min={1} max={80} onChange={(v) => set({ torrent: { maxSizeGb: v } })} format={(v) => `${v} GB`} />
        </Row>
        <Row label="Fewest seeders" stack>
          <Slider value={t.minSeeders} min={0} max={50} onChange={(v) => set({ torrent: { minSeeders: v } })} format={(v) => String(v)} />
        </Row>
        <Row label="HDR is OK" hint="HDR looks washed out on screens and browsers that can't show it.">
          <Switch checked={t.allowHdr} onChange={(v) => set({ torrent: { allowHdr: v } })} />
        </Row>
      </Group>
      <Group title="Anime releases">
        <Row label="Prefer releases with subtitles inside" hint="Perfect sync, no lookup needed.">
          <Switch checked={p.anime.preferEmbeddedSubs} onChange={(v) => set({ anime: { preferEmbeddedSubs: v } })} />
        </Row>
        <Row stack label="Favourite groups" hint="Comma-separated, e.g. SubsPlease, Erai-raws.">
          <Input defaultValue={p.anime.preferredGroups.join(', ')} onBlur={(e) => set({ anime: { preferredGroups: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} />
        </Row>
      </Group>
    </>
  );
}

function ReadingSection({ p, set }: { p: Preferences; set: (x: object) => void }) {
  const r = p.reader;
  const c = themeColors(r);
  const rs = (x: Partial<Preferences['reader']>) => set({ reader: x });
  return (
    <>
      <div className="mb-5 rounded-3xl p-8 ring-1 ring-white/10" style={{ background: c.bg, color: c.fg, fontFamily: READING_FONTS[r.typeface].css, fontSize: `${r.fontSize}%`, lineHeight: r.lineHeight, textAlign: r.justify ? 'justify' : 'start', paddingInline: `max(2rem, ${r.margins}%)` }}>
        It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors.
      </div>
      <Group title="Books">
        <Row label="Typeface">
          <Select value={r.typeface} onChange={(e) => rs({ typeface: e.target.value as Preferences['reader']['typeface'] })} className="w-56">
            {(Object.keys(READING_FONTS) as (keyof typeof READING_FONTS)[]).map((k) => (
              <option key={k} value={k}>
                {READING_FONTS[k].label}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Size" stack>
          <Slider value={r.fontSize} min={70} max={200} step={5} onChange={(v) => rs({ fontSize: v })} format={(v) => `${v}%`} />
        </Row>
        <Row label="Line spacing" stack>
          <Slider value={r.lineHeight} min={1.1} max={2.4} step={0.05} onChange={(v) => rs({ lineHeight: v })} format={(v) => v.toFixed(2)} />
        </Row>
        <Row label="Margins" stack>
          <Slider value={r.margins} min={0} max={25} onChange={(v) => rs({ margins: v })} format={(v) => `${v}%`} />
        </Row>
        <Row label="Justify">
          <Switch checked={r.justify} onChange={(v) => rs({ justify: v })} />
        </Row>
        <Row label="Theme">
          <Segmented size="sm" value={r.theme} onChange={(v) => rs({ theme: v })} options={[{ value: 'night', label: 'Night' }, { value: 'sepia', label: 'Sepia' }, { value: 'paper', label: 'Paper' }, { value: 'custom', label: 'Custom' }]} />
        </Row>
        {r.theme === 'custom' && (
          <Row label="Custom colours">
            <div className="flex gap-3">
              <input type="color" value={r.customBg} onChange={(e) => rs({ customBg: e.target.value })} aria-label="Background" />
              <input type="color" value={r.customFg} onChange={(e) => rs({ customFg: e.target.value })} aria-label="Text" />
            </div>
          </Row>
        )}
      </Group>
      <Group title="Comics & manga">
        <Row label="Layout">
          <Segmented size="sm" value={r.comicMode} onChange={(v) => rs({ comicMode: v })} options={[{ value: 'single', label: 'Single' }, { value: 'double', label: 'Spread' }, { value: 'scroll', label: 'Scroll' }]} />
        </Row>
        <Row label="Direction">
          <Segmented size="sm" value={r.comicDirection} onChange={(v) => rs({ comicDirection: v })} options={[{ value: 'ltr', label: 'Left → right' }, { value: 'rtl', label: 'Right → left' }]} />
        </Row>
        <Row label="Fit">
          <Segmented size="sm" value={r.comicFit} onChange={(v) => rs({ comicFit: v })} options={[{ value: 'height', label: 'Height' }, { value: 'width', label: 'Width' }, { value: 'original', label: 'Original' }]} />
        </Row>
      </Group>
    </>
  );
}

const ACCENTS: { id: Preferences['ui']['accent']; a: string; b: string; label: string }[] = [
  { id: 'nova', a: '#a78bfa', b: '#f472b6', label: 'Nova' },
  { id: 'ember', a: '#fb923c', b: '#f43f5e', label: 'Ember' },
  { id: 'ocean', a: '#38bdf8', b: '#818cf8', label: 'Ocean' },
  { id: 'aurora', a: '#34d399', b: '#22d3ee', label: 'Aurora' },
  { id: 'mono', a: '#f5f4fa', b: '#b8b6c9', label: 'Mono' },
];

function AppearanceSection({ p, set }: { p: Preferences; set: (x: object) => void }) {
  const { data: session } = useSession();
  return (
    <>
      <Group title="Accent">
        <div className="grid grid-cols-5 gap-3 py-4">
          {ACCENTS.map((a) => (
            <button key={a.id} onClick={() => set({ ui: { accent: a.id } })} className="group flex flex-col items-center gap-2">
              <span className={cls('size-14 rounded-2xl ring-2 ring-offset-4 ring-offset-bg transition', p.ui.accent === a.id ? 'ring-white' : 'ring-transparent group-hover:ring-white/30')} style={{ background: `linear-gradient(135deg, ${a.a}, ${a.b})` }} />
              <span className="text-xs text-muted">{a.label}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title="Comfort">
        <Row label="Reduce motion" hint="Turns off page transitions and animated backgrounds.">
          <Switch checked={p.ui.reduceMotion} onChange={(v) => set({ ui: { reduceMotion: v } })} />
        </Row>
        <Row label="Hide spoilers" hint="Episodes you haven't watched keep their titles, pictures and descriptions hidden.">
          <Switch checked={p.ui.hideSpoilers} onChange={(v) => set({ ui: { hideSpoilers: v } })} />
        </Row>
        <Row label="Hide scores" hint="No ratings on title pages and banners: make up your own mind.">
          <Switch checked={p.ui.hideScores} onChange={(v) => set({ ui: { hideScores: v } })} />
        </Row>
      </Group>
      <HdrGroup />
      <Group title="Sections">
        <Row
          label="Music & free books"
          hint={
            session?.settings.musicBooksEnabled
              ? 'Adds a Music tab and public-domain books & audiobooks to Read.'
              : session?.account.isAdmin
                ? 'Turn it on for your account under Admin → People first.'
                : 'An admin hasn’t enabled this for your account.'
          }
        >
          <Switch disabled={!session?.settings.musicBooksEnabled} checked={p.ui.musicAndBooks} onChange={(v) => set({ ui: { musicAndBooks: v } })} />
        </Row>
      </Group>
    </>
  );
}

/** Windows app: whether Windows Auto HDR may brighten the interface (it applies when Nova starts). */
function HdrGroup() {
  const [info, setInfo] = useDesktopInfo();
  if (!info || !desktop || info.platform !== 'win32') return null;
  const on = Boolean(info.settings.hdrInterface);
  const pending = info.hdrAtLaunch !== undefined && info.hdrAtLaunch !== on;
  return (
    <Group title="HDR" hint="HDR videos, and SDR videos that RTX Video HDR turns into HDR, always play in HDR on an HDR screen.">
      <Row
        label="HDR interface"
        hint="Lets Windows Auto HDR brighten Nova's own screens too. Windows switches it on and off as videos start and stop, so with it off the interface always looks the same."
      >
        <Switch
          checked={on}
          onChange={async (v) => {
            const settings = await desktop!.setSettings({ hdrInterface: v });
            setInfo((i) => (i ? { ...i, settings } : i));
          }}
        />
      </Row>
      {pending && (
        <Row label="Restart Nova to apply this">
          <Button size="sm" variant="white" onClick={() => void desktop!.relaunch?.()}>
            Restart now
          </Button>
        </Row>
      )}
    </Group>
  );
}

const PROVIDER_KINDS: { value: AssistantProvider['kind']; label: string; model: string; key: boolean; url?: string }[] = [
  { value: 'anthropic', label: 'Anthropic', model: 'claude-sonnet-4-5', key: true },
  { value: 'openai', label: 'OpenAI', model: 'gpt-4.1-mini', key: true },
  { value: 'gemini', label: 'Google Gemini', model: 'gemini-2.5-flash', key: true },
  { value: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', key: true },
  { value: 'ollama', label: 'Ollama (local)', model: 'llama3.2', key: false, url: 'http://localhost:11434/v1' },
  { value: 'openai-compatible', label: 'OpenAI-compatible (OpenCode, LM Studio…)', model: '', key: false, url: 'http://localhost:1234/v1' },
];

function AssistantSection() {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const providers = useQuery({ queryKey: ['assistant-providers'], queryFn: api.assistant.providers, enabled: Boolean(session?.settings.assistantEnabled) });
  const [kind, setKind] = useState<AssistantProvider['kind']>('anthropic');
  const preset = PROVIDER_KINDS.find((k) => k.value === kind)!;
  const [form, setForm] = useState({ name: '', model: '', baseUrl: '', apiKey: '', shared: false });
  if (!session?.settings.assistantEnabled) return <Card><p className="text-sm text-muted">The assistant isn't enabled for your account. An admin can turn it on in Server → People.</p></Card>;
  const add = async () => {
    try {
      await api.assistant.saveProvider({ kind, name: form.name || preset.label, model: form.model || preset.model, baseUrl: form.baseUrl || preset.url || null, apiKey: form.apiKey || null, shared: form.shared });
      setForm({ name: '', model: '', baseUrl: '', apiKey: '', shared: false });
      qc.invalidateQueries({ queryKey: ['assistant-providers'] });
      toast('Model connected', 'ok');
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };
  return (
    <>
      <Group title="Connected models" hint="The assistant acts with your permissions only. Shared changes always wait for your confirmation.">
        {!providers.data?.length && <p className="py-3 text-sm text-muted">None yet.</p>}
        {providers.data?.map((pr) => (
          <Row key={pr.id} label={<span className="flex items-center gap-2">{pr.name} {pr.shared && <Badge>Shared</Badge>}</span>} hint={`${pr.model}${pr.baseUrl ? ` · ${pr.baseUrl}` : ''}`}>
            {(!pr.shared || session.account.isAdmin) && (
              <button
                onClick={async () => {
                  await api.assistant.deleteProvider(pr.id);
                  qc.invalidateQueries({ queryKey: ['assistant-providers'] });
                }}
                aria-label="Remove"
                className="rounded-lg p-2 text-muted hover:bg-white/8 hover:text-bad"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </Row>
        ))}
      </Group>
      <Group title="Connect a model">
        <div className="grid gap-3 py-3 sm:grid-cols-2">
          <Select value={kind} onChange={(e) => setKind(e.target.value as AssistantProvider['kind'])} className="sm:col-span-2">
            {PROVIDER_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
          <Input placeholder={`Name (${preset.label})`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input placeholder={`Model (${preset.model || 'required'})`} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          {(preset.url || kind === 'openai-compatible') && <Input className="sm:col-span-2" placeholder={`Base URL (${preset.url})`} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />}
          {preset.key && <Input className="sm:col-span-2" type="password" placeholder="API key" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />}
          {session.account.isAdmin && (
            <label className="flex items-center gap-3 text-sm sm:col-span-2">
              <Switch checked={form.shared} onChange={(v) => setForm({ ...form, shared: v })} /> Share with everyone on this server
            </label>
          )}
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={add} disabled={(preset.key && !form.apiKey) || (!preset.model && !form.model)} className="sm:col-span-2">
            Connect
          </Button>
        </div>
      </Group>
    </>
  );
}

function AccountSection() {
  const qc = useQueryClient();
  const { data: appConfig } = useAppConfig();
  const shares = useQuery({ queryKey: ['shares'], queryFn: api.shares.list });
  const pairings = useQuery({ queryKey: ['engine-pairings'], queryFn: api.system.pairings, enabled: appConfig?.mode === 'desktop' && appConfig.platform !== 'android' });
  return (
    <>
      {appConfig?.mode === 'desktop' && appConfig.platform !== 'android' && (
        <Group title="Websites streaming through this computer" hint="A Nova website whose server leaves torrents to its viewers can use this app to stream. You approved these.">
          {!pairings.data?.length && <p className="py-3 text-sm text-muted">None yet.</p>}
          {pairings.data?.map((p) => (
            <Row key={p.id} label={p.origin} hint={`Allowed ${relTime(p.createdAt)}`}>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await api.system.unpair(p.id);
                  qc.invalidateQueries({ queryKey: ['engine-pairings'] });
                }}
              >
                Remove
              </Button>
            </Row>
          ))}
        </Group>
      )}
      <Group title="Guest links" hint="Links you've shared. Guests only see what each link covers, until it expires.">
        {!shares.data?.length && <p className="py-3 text-sm text-muted">You haven't shared anything.</p>}
        {shares.data?.map((s) => (
          <Row
            key={s.id}
            label={<span className="flex items-center gap-2"><Link2 className="size-4 text-faint" /> {s.label ?? s.target}</span>}
            hint={`${s.scope} · used ${s.uses}× · ${s.revoked ? 'revoked' : s.expired ? 'expired' : s.expiresAt ? `expires ${relTime(s.expiresAt)}` : 'never expires'}`}
          >
            {!s.revoked && (
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await api.shares.revoke(s.id);
                  qc.invalidateQueries({ queryKey: ['shares'] });
                }}
              >
                Revoke
              </Button>
            )}
          </Row>
        ))}
      </Group>
      <Group title="Your data">
        <Row label="Export this profile" hint="Watch history, lists, collections, reading progress and notes as JSON.">
          <a href={api.me.exportUrl()} download>
            <Button size="sm">Download</Button>
          </a>
        </Row>
      </Group>
    </>
  );
}

/** Advanced: tokens for the plugin CLI and other tools. */
function ApiTokensGroup() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.me.tokens });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  return (
      <Group title="API tokens" hint={<>For the <code>nova-plugin</code> CLI and other tools. A token can do what you can.</>}>
        {tokens.data?.map((t) => (
          <Row key={t.id} label={t.name} hint={`Created ${relTime(t.createdAt)}${t.lastUsedAt ? ` · used ${relTime(t.lastUsedAt)}` : ''}`}>
            <button
              onClick={async () => {
                await api.me.deleteToken(t.id);
                qc.invalidateQueries({ queryKey: ['tokens'] });
              }}
              aria-label="Revoke token"
              className="rounded-lg p-2 text-muted hover:bg-white/8 hover:text-bad"
            >
              <Trash2 className="size-4" />
            </button>
          </Row>
        ))}
        {fresh && (
          <div className="my-3 rounded-2xl bg-ok/10 p-3 text-sm">
            <div className="mb-2 text-ok">Copy it now — it won't be shown again.</div>
            <div className="flex gap-2">
              <Input readOnly value={fresh} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button
                icon={<Copy className="size-4" />}
                onClick={() => {
                  navigator.clipboard?.writeText(fresh);
                  toast('Copied', 'ok');
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        )}
        <div className="flex gap-2 py-3">
          <Input placeholder="Token name, e.g. laptop CLI" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            variant="white"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                setFresh(await api.me.createToken(name.trim()));
                setName('');
                qc.invalidateQueries({ queryKey: ['tokens'] });
              } catch (e) {
                toast(errorText(e), 'bad');
              }
            }}
          >
            Create
          </Button>
        </div>
      </Group>
  );
}

/** Your own styles on top of Nova's. */
function CustomCssGroup({ p, set }: { p: Preferences; set: (x: object) => void }) {
  return (
    <Group title="Custom CSS" hint="Your own styles on top of Nova's, for this profile only. Clear it to undo.">
      <div className="py-3">
        <TextArea
          key={p.ui.customCss}
          defaultValue={p.ui.customCss}
          onBlur={(e) => e.target.value !== p.ui.customCss && set({ ui: { customCss: e.target.value } })}
          className="min-h-32 font-mono text-xs"
          spellCheck={false}
          placeholder={':root { --a1: #22d3ee; }\n.font-display { letter-spacing: 0; }'}
        />
      </div>
    </Group>
  );
}

/** Settings → Advanced: fine-tuning most people never need. */
function AdvancedSection({ p, set }: { p: Preferences; set: (x: object) => void }) {
  return (
    <>
      <p className="mb-5 text-sm text-muted">Fine-tuning for those who like it. Nova's defaults work well without any of this.</p>
      <SourcesGroups p={p} set={set} />
      <CompatibilityGroup p={p} set={set} />
      <CustomCssGroup p={p} set={set} />
      <ApiTokensGroup />
      <BetaSection p={p} set={set} />
    </>
  );
}

function TrackerAccountRow({ name, user, avatar, onDisconnect }: { name: string; user: string | null; avatar: string | null; onDisconnect: () => void }) {
  return (
    <Row
      label={
        <span className="flex items-center gap-3">
          {avatar ? <img src={avatar} alt="" className="size-8 rounded-full object-cover" /> : null}
          <span>
            {user}
            <span className="block text-xs font-normal text-faint">Connected to {name}</span>
          </span>
        </span>
      }
    >
      <Button size="sm" variant="ghost" onClick={onDisconnect}>
        Disconnect
      </Button>
    </Row>
  );
}

function TrackingSection({ p, set }: { p?: Preferences; set: (x: object) => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['trackers'], queryFn: api.trackers.status, refetchOnWindowFocus: true });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const s = status.data;
  if (!s) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['trackers'] });
  const disconnect = async (service: 'anilist' | 'mal') => {
    await api.trackers.disconnect(service).catch((e) => toast(errorText(e), 'bad'));
    refresh();
  };
  const connectAnilist = async () => {
    setBusy(true);
    try {
      await api.trackers.connectAnilist(token);
      setToken('');
      toast('AniList connected', 'ok');
      refresh();
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const anilistDev = 'https://anilist.co/settings/developer';
  return (
    <>
      <Group title="AniList" hint="Episodes you finish in Nova and manga chapters you read are marked on your AniList, and you can change a title's status from its page.">
        {s.anilist.connected ? (
          <TrackerAccountRow name="AniList" user={s.anilist.user} avatar={s.anilist.avatar} onDisconnect={() => void disconnect('anilist')} />
        ) : (
          <div className="space-y-3 py-3 text-sm">
            {s.anilistAuthorizeUrl ? (
              <p className="text-muted">
                1.{' '}
                <a href={s.anilistAuthorizeUrl} target="_blank" rel="noreferrer" className="font-semibold text-fg underline">
                  Open AniList
                </a>{' '}
                and approve Nova. 2. Copy the token AniList shows you and paste it here.
              </p>
            ) : (
              <p className="text-muted">
                Create a free API client at{' '}
                <a href={anilistDev} target="_blank" rel="noreferrer" className="text-fg underline">
                  anilist.co/settings/developer
                </a>{' '}
                with redirect URL <code className="rounded bg-white/8 px-1">https://anilist.co/api/v2/oauth/pin</code>, open{' '}
                <code className="rounded bg-white/8 px-1 break-all">https://anilist.co/api/v2/oauth/authorize?client_id=YOUR_ID&amp;response_type=token</code>, approve, and paste the token
                it shows here. (A server admin can add the client ID once under Server → Advanced → Integrations to make this one click.)
              </p>
            )}
            <div className="flex gap-2">
              <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste your AniList token" className="flex-1" />
              <Button variant="white" loading={busy} disabled={token.trim().length < 20} onClick={connectAnilist}>
                Connect
              </Button>
            </div>
          </div>
        )}
      </Group>
      <Group title="MyAnimeList" hint="The same for MyAnimeList: finished episodes and chapters update your lists.">
        {s.mal.connected ? (
          <TrackerAccountRow name="MyAnimeList" user={s.mal.user} avatar={s.mal.avatar} onDisconnect={() => void disconnect('mal')} />
        ) : s.mal.configured ? (
          <Row label="Connect your account" hint="Opens MyAnimeList to sign in. Come back here when it says you're connected.">
            <Button
              variant="white"
              size="sm"
              onClick={async () => {
                try {
                  window.open(await api.trackers.malAuthorize(), '_blank', 'noopener');
                } catch (e) {
                  toast(errorText(e), 'bad');
                }
              }}
            >
              Connect
            </Button>
          </Row>
        ) : (
          <p className="py-3 text-sm text-muted">A server admin can turn on MyAnimeList under Server → Advanced → Integrations.</p>
        )}
      </Group>
      {p && (s.anilist.connected || s.mal.connected) && (
        <Group title="How Nova updates your lists" hint="With both connected, every change goes to both.">
          <Row label="Add shows I start as “Watching”" hint="A minute into an episode of something you haven't listed (or only planned).">
            <Switch checked={p.anime.trackAutoAdd} onChange={(v) => set({ anime: { trackAutoAdd: v } })} />
          </Row>
          <Row label="Count an episode as watched at" stack>
            <Slider value={p.anime.trackAt} min={50} max={100} step={5} onChange={(v) => set({ anime: { trackAt: v } })} format={(v) => `${v}%`} />
          </Row>
        </Group>
      )}
    </>
  );
}

function UpdateRow() {
  const { data: session } = useSession();
  const [info] = useDesktopInfo();
  const [fresh, setFresh] = useState(false);
  const release = useQuery({ queryKey: ['app-update', fresh], queryFn: () => api.system.update(fresh), staleTime: 30 * 60_000 });
  const u = info?.update;
  // A release the updater hasn't picked up yet: have it start downloading now.
  const behind = Boolean(release.data?.available && u?.supported && info?.settings.autoUpdate && (u.status === 'idle' || u.status === 'none'));
  useEffect(() => {
    if (behind) void desktop?.checkForUpdates();
  }, [behind]);
  if (u?.supported && u.status !== 'idle' && u.status !== 'none') {
    return (
      <Row
        label={u.status === 'ready' ? `Nova ${u.version} is ready` : u.status === 'checking' ? 'Checking for updates…' : u.status === 'downloading' ? `Downloading Nova ${u.version ?? ''}` : 'The update check failed'}
        hint={u.status === 'ready' ? 'It installs when you close Nova, or right now.' : u.status === 'downloading' ? `${Math.round((u.progress ?? 0) * 100)}%` : u.error}
      >
        {u.status === 'ready' ? (
          <Button size="sm" variant="white" onClick={() => void desktop?.installUpdate()}>
            Restart now
          </Button>
        ) : u.status === 'error' ? (
          <Button size="sm" onClick={() => void desktop?.checkForUpdates()}>
            Try again
          </Button>
        ) : (
          <Spinner className="size-4" />
        )}
      </Row>
    );
  }
  const r = release.data;
  const selfUpdating = Boolean(u?.supported && info?.settings.autoUpdate);
  return (
    <Row
      label={r?.available ? `Nova ${r.latest!.version} is out` : release.isFetching ? 'Checking for updates…' : r?.latest ? "You're up to date" : 'Updates'}
      hint={
        r?.available
          ? selfUpdating
            ? 'Nova downloads it in the background and installs it the next time you close Nova.'
            : desktop
              ? 'Download it from the release page and install it over this one; your data stays.'
              : session?.account.isAdmin
                ? 'Pull the new image and restart the container; your data stays.'
                : 'Your server admin can update Nova.'
          : r?.latest
            ? `Latest release: ${r.latest.version}`
            : 'Nova can check its project page for new releases.'
      }
    >
      {r?.available ? (
        <a href={r.latest!.url} target="_blank" rel="noreferrer">
          <Button size="sm" variant={selfUpdating ? 'ghost' : 'white'}>
            {desktop && !selfUpdating ? 'Download' : "What's new"}
          </Button>
        </a>
      ) : (
        <Button
          size="sm"
          loading={release.isFetching}
          onClick={() => {
            if (u?.supported) void desktop?.checkForUpdates();
            setFresh(true);
            void release.refetch();
          }}
        >
          Check now
        </Button>
      )}
    </Row>
  );
}

function AboutSection({ p, set }: { p?: Preferences; set: (x: object) => void }) {
  const { data: cfg } = useAppConfig();
  const { data: session } = useSession();
  const [info, setInfo] = useDesktopInfo();
  if (!cfg) return null;
  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noreferrer">
      <Button size="sm">{label}</Button>
    </a>
  );
  const setDesktop = async (patch: Partial<DesktopSettings>) => {
    const settings = await desktop!.setSettings(patch);
    setInfo((i) => (i ? { ...i, settings } : i));
  };
  return (
    <>
      <Group title="About Nova" hint="Nova is open source. Found a bug or missing something? Let us know.">
        <Row label="Version">{cfg.version}</Row>
        <Row label="Running as">{cfg.platform === 'android' ? 'Android app (Nova runs on this phone)' : cfg.mode === 'desktop' ? (PLATFORM_NAME[desktop?.platform ?? ''] ?? 'Desktop app') : androidApp ? 'Android app' : 'Server'}</Row>
        {androidApp && (
          <Row label="Server" hint={location.host}>
            <Button size="sm" onClick={switchServer}>
              Switch server
            </Button>
          </Row>
        )}
        <Row label="Report a problem" hint="Opens a new issue with your Nova version and browser already filled in.">
          {link(reportIssueUrl(cfg), 'Report')}
        </Row>
        <Row label="Source code & releases">{link(cfg.projectUrl, 'Open')}</Row>
      </Group>
      <Group title="Updates">
        <UpdateRow />
        {info ? (
          <Row
            label="Check for updates automatically"
            hint={info.update.supported ? 'New versions download in the background and install the next time you close Nova.' : 'Nova tells you when a new version is out.'}
          >
            <Switch checked={info.settings.autoUpdate} onChange={(v) => void setDesktop({ autoUpdate: v })} />
          </Row>
        ) : (
          session?.account.isAdmin &&
          p && (
            <Row label="Tell me about new versions" hint="A notice when a new Nova release is out.">
              <Switch checked={p.ui.updateNotices} onChange={(v) => set({ ui: { updateNotices: v } })} />
            </Row>
          )
        )}
      </Group>
      {info?.discordAvailable && (
        <Group title="Discord" hint="While Discord runs on this computer, your status shows what you're watching or reading.">
          <Row label="Show what I'm watching">
            <Switch checked={info.settings.discord} onChange={(v) => void setDesktop({ discord: v })} />
          </Row>
        </Group>
      )}
    </>
  );
}

export default function Settings() {
  const { section = '' } = useParams();
  const { data: prefs } = usePrefs();
  const save = useSavePrefs();
  const set = (x: object) => save.mutate(x);
  const [query, setQuery] = useState('');
  const q = query.trim();
  const active = SECTIONS.find((s) => s.id === (MOVED[section] ?? section)) ?? SECTIONS[0]!;
  const render = (id: string) => (
    <>
      {id === '' && <ProfileSection />}
      {id === 'account' && <AccountSection />}
      {id === 'about' && <AboutSection p={prefs} set={set} />}
      {id === 'tracking' && <TrackingSection p={prefs} set={set} />}
      {id === 'assistant' && <AssistantSection />}
      {prefs && id === 'playback' && <PlaybackSection p={prefs} set={set} />}
      {prefs && id === 'subtitles' && <SubtitlesSection p={prefs} set={set} />}
      {prefs && id === 'reading' && <ReadingSection p={prefs} set={set} />}
      {prefs && id === 'customize' && <CustomizeSection p={prefs} set={set} />}
      {prefs && id === 'appearance' && <AppearanceSection p={prefs} set={set} />}
      {prefs && id === 'advanced' && <AdvancedSection p={prefs} set={set} />}
    </>
  );

  return (
    <div className="px-5 pt-24 sm:px-10 sm:pt-28">
      <h1 className="font-display text-4xl font-bold sm:text-6xl">Settings</h1>
      <div className="mt-8 grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="space-y-4">
          <SettingsSearch value={query} onChange={setQuery} placeholder="Search settings" />
          <nav className={cls('scrollbar-none -mx-5 flex gap-1 overflow-x-auto px-5 lg:mx-0 lg:flex-col lg:px-0', q && 'opacity-50')}>
            {SECTIONS.map((s, i) => (
              <Fragment key={s.id}>
                {s.group !== SECTIONS[i - 1]?.group && <div className="hidden px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase first:pt-0 lg:block">{s.group}</div>}
                <NavLink to={`/settings${s.id ? `/${s.id}` : ''}`} end onClick={() => setQuery('')} className="relative flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium">
                  {({ isActive }) => (
                    <>
                      {isActive && !q && <motion.span layoutId="settings-nav" className="absolute inset-0 rounded-xl bg-white/10" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                      <s.icon className={cls('relative size-4', isActive && !q ? 'text-accent' : 'text-faint')} />
                      <span className={cls('relative', isActive && !q ? 'text-fg' : 'text-muted')}>{s.label}</span>
                    </>
                  )}
                </NavLink>
              </Fragment>
            ))}
          </nav>
        </div>
        {q ? (
          // Every page at once, each showing only what matches.
          <div data-searching="" className="max-w-3xl space-y-8 pb-10">
            {SECTIONS.map((s) => {
              const all = fuzzyMatch(s.label, q);
              return (
                <section key={s.id} data-section="" data-all={all ? '' : undefined}>
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted">
                    <s.icon className="size-4 text-faint" /> {s.label}
                  </h2>
                  <SettingsFilter.Provider value={{ q, all, context: s.label }}>{render(s.id)}</SettingsFilter.Provider>
                </section>
              );
            })}
            <p data-search-empty="" className="text-sm text-muted">
              Nothing matches “{q}”.
            </p>
          </div>
        ) : (
          <motion.div key={active.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-3xl pb-10">
            {render(active.id)}
          </motion.div>
        )}
      </div>
    </div>
  );
}
