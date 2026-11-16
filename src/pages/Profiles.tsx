import { motion } from 'motion/react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { cls } from '../lib/format';
import { useSession } from '../lib/queries';
import { errorText, toast, useApp } from '../lib/store';
import type { Profile } from '../lib/types';
import { Avatar, AVATAR_KEYS, Button, Input, Modal, Switch } from '../components/ui';

/** Downscales a picked image to a 256px square data URI. */
export async function imageToAvatar(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const s = Math.min(bmp.width, bmp.height);
  ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return canvas.toDataURL('image/webp', 0.85);
}

export function ProfileEditor({ profile, onClose }: { profile: Profile | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = profile === 'new';
  const [name, setName] = useState(isNew ? '' : profile.name);
  const [avatar, setAvatar] = useState(isNew ? AVATAR_KEYS[Math.floor(Math.random() * AVATAR_KEYS.length)]! : profile.avatar);
  const [isKids, setKids] = useState(isNew ? false : profile.isKids);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) await api.profiles.create({ name: name.trim(), avatar, isKids });
      else await api.profiles.update(profile.id, { name: name.trim(), avatar, isKids });
      await qc.invalidateQueries({ queryKey: ['session'] });
      onClose();
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (isNew || !confirm(`Delete ${profile.name}? Their history and lists go with it.`)) return;
    try {
      await api.profiles.remove(profile.id);
      await qc.invalidateQueries({ queryKey: ['session'] });
      onClose();
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'New profile' : 'Edit profile'}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={remove} className="mr-auto">
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-5">
        <label className="group relative cursor-pointer">
          <Avatar avatar={avatar} name={name || '?'} className="size-24 text-4xl" />
          <span className="absolute inset-0 grid place-items-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            <Camera className="size-6" />
          </span>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setAvatar(await imageToAvatar(f));
            }}
          />
        </label>
        <div className="flex flex-wrap justify-center gap-2">
          {AVATAR_KEYS.map((k) => (
            <button key={k} onClick={() => setAvatar(k)} className={cls('rounded-full p-0.5 ring-2 transition', avatar === k ? 'ring-white' : 'ring-transparent hover:ring-white/30')}>
              <Avatar avatar={k} name={name || '?'} className="size-8 text-xs" />
            </button>
          ))}
        </div>
        <Input placeholder="Name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoFocus />
        <label className="flex w-full items-center justify-between rounded-xl bg-white/4 px-4 py-3 text-sm">
          <span>
            <span className="font-medium">Kids profile</span>
            <span className="block text-xs text-faint">A simpler Home with family-friendly picks.</span>
          </span>
          <Switch checked={isKids} onChange={setKids} />
        </label>
      </div>
    </Modal>
  );
}

export function Profiles() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const setProfile = useApp((s) => s.setProfile);
  const [manage, setManage] = useState(false);
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  if (!session) return null;
  const canAdd = session.settings.multiProfile && session.profiles.length < session.settings.maxProfiles;

  return (
    <div className="grid min-h-dvh place-items-center px-6 py-16">
      <div className="flex flex-col items-center">
        <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="font-display text-4xl font-bold sm:text-5xl">
          {manage ? 'Manage profiles' : "Who's watching?"}
        </motion.h1>
        <div className="mt-12 flex flex-wrap justify-center gap-6 sm:gap-10">
          {session.profiles.map((p, i) => (
            <motion.button
              key={p.id}
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 700, damping: 45, delay: 0.03 * i }}
              onClick={() => {
                if (manage) return setEditing(p);
                setProfile(p.id);
                navigate('/', { replace: true });
              }}
              className="group flex flex-col items-center gap-3"
            >
              <span className="relative">
                <Avatar avatar={p.avatar} name={p.name} className="size-28 text-5xl transition-all duration-300 group-hover:scale-105 group-hover:shadow-[0_0_0_4px_white] sm:size-36" />
                {manage && (
                  <span className="absolute inset-0 grid place-items-center rounded-full bg-black/55">
                    <Pencil className="size-7" />
                  </span>
                )}
              </span>
              <span className="text-base text-muted transition-colors group-hover:text-fg">{p.name}</span>
            </motion.button>
          ))}
          {canAdd && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.08 * session.profiles.length }}
              onClick={() => setEditing('new')}
              className="group flex flex-col items-center gap-3"
            >
              <span className="grid size-28 place-items-center rounded-full border-2 border-dashed border-white/20 text-muted transition-all group-hover:border-white/60 group-hover:text-fg sm:size-36">
                <Plus className="size-10" />
              </span>
              <span className="text-base text-muted">Add profile</span>
            </motion.button>
          )}
        </div>
        <Button variant="outline" className="mt-14" onClick={() => setManage((m) => !m)}>
          {manage ? 'Done' : 'Manage profiles'}
        </Button>
      </div>
      {editing && <ProfileEditor profile={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
