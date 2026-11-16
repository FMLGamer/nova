import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { watchPath } from '../lib/format';
import { errorText } from '../lib/store';
import { Button, Spinner } from '../components/ui';

/** /room/:code — resolves the room's current title and drops you into the synced player. */
export default function RoomJoin() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { data, error } = useQuery({ queryKey: ['room', code.toUpperCase()], queryFn: () => api.rooms.get(code.toUpperCase()), retry: false });
  useEffect(() => {
    if (data) navigate(watchPath({ mediaId: data.target.mediaId, season: data.target.season, episode: data.target.episode }, { room: data.code }), { replace: true });
  }, [data, navigate]);
  return (
    <div className="grid min-h-dvh place-items-center px-6 text-center">
      {error ? (
        <div>
          <h1 className="font-display text-3xl font-bold">This room has closed</h1>
          <p className="mt-2 text-muted">{errorText(error)}</p>
          <Button className="mt-6" variant="white" onClick={() => navigate('/')}>
            Go home
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <Spinner className="size-8" />
          <p className="text-muted">Joining room {code.toUpperCase()}…</p>
        </div>
      )}
    </div>
  );
}
