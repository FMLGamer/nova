import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Pin, Share2, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { errorText, toast } from '../lib/store';
import type { CatalogItem } from '../lib/types';
import { PosterCard } from '../components/media';
import { Button, Empty, Input, Modal, Spinner, TextArea } from '../components/ui';

export default function CollectionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: c, isLoading } = useQuery({ queryKey: ['collection', id], queryFn: () => api.me.collection(id) });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['collection', id] });
    qc.invalidateQueries({ queryKey: ['collections'] });
  };

  if (isLoading) return <div className="grid min-h-[60vh] place-items-center"><Spinner className="size-7" /></div>;
  if (!c) return <Empty title="Collection not found" />;

  return (
    <div className="px-5 pt-24 sm:px-10 sm:pt-28">
      <div className="flex flex-wrap items-end gap-4">
        <div className="mr-auto min-w-0">
          <div className="text-xs font-semibold tracking-widest text-faint uppercase">Collection · {c.count} titles</div>
          <h1 className="mt-1 font-display text-4xl font-bold sm:text-6xl">{c.name}</h1>
          {c.description && <p className="mt-2 max-w-2xl text-muted">{c.description}</p>}
        </div>
        <div className="flex gap-2">
          <Button
            variant={c.pinned ? 'white' : 'glass'}
            icon={<Pin className="size-4" />}
            onClick={async () => {
              await api.me.updateCollection(id, { pinned: !c.pinned });
              refresh();
            }}
          >
            {c.pinned ? 'Pinned to Home' : 'Pin to Home'}
          </Button>
          <Button
            variant="glass"
            icon={<Share2 className="size-4" />}
            onClick={async () => {
              try {
                const r = await api.shares.create({ scope: 'collection', target: id, label: c.name, expiresInDays: 30 });
                await navigator.clipboard?.writeText(r.url);
                toast('Guest link copied — valid for 30 days', 'ok');
              } catch (e) {
                toast(errorText(e), 'bad');
              }
            }}
          >
            Share
          </Button>
          <Button
            variant="glass"
            icon={<Pencil className="size-4" />}
            onClick={() => {
              setName(c.name);
              setDesc(c.description ?? '');
              setEditing(true);
            }}
          >
            Edit
          </Button>
        </div>
      </div>

      <div className="mt-10 grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
        {c.items.map((i) => (
          <div key={i.mediaId} className="group relative">
            <PosterCard item={{ id: i.mediaId, mediaType: i.mediaType as CatalogItem['mediaType'], title: i.title ?? 'Untitled', year: i.year, poster: i.poster }} />
            <button
              onClick={async () => {
                await api.me.removeFromCollection(id, i.mediaId);
                refresh();
              }}
              aria-label="Remove from collection"
              className="absolute top-2 left-2 grid size-7 place-items-center rounded-full bg-black/60 opacity-0 backdrop-blur transition group-hover:opacity-100 max-sm:opacity-100"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
      {!c.items.length && <Empty title="It's empty in here">Use “Collect” on any title page to add it.</Empty>}

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit collection"
        footer={
          <>
            <Button
              variant="danger"
              className="mr-auto"
              icon={<Trash2 className="size-4" />}
              onClick={async () => {
                if (!confirm(`Delete ${c.name}?`)) return;
                await api.me.deleteCollection(id);
                qc.invalidateQueries({ queryKey: ['collections'] });
                navigate('/library/collections');
              }}
            >
              Delete
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={async () => {
                await api.me.updateCollection(id, { name: name.trim(), description: desc.trim() || null });
                refresh();
                setEditing(false);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <TextArea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" />
        </div>
      </Modal>
    </div>
  );
}
