import { useCallback, useEffect, useRef, useState } from 'react';
import { withProfile } from '../../lib/api';
import type { RoomChat, RoomMember, RoomState, RoomTarget } from '../../lib/types';

export interface RoomApi {
  connected: boolean;
  you: string | null;
  members: RoomMember[];
  chat: RoomChat[];
  reactions: { id: number; emoji: string; name: string }[];
  sendState: (s: { playing: boolean; position: number; rate: number }, reason: string) => void;
  sendChat: (text: string) => void;
  react: (emoji: string) => void;
  setBuffering: (on: boolean) => void;
}

/**
 * Watch-together sync. `onRemote` is called with the position everyone should be
 * at *now* (the server timestamp plus our measured clock offset accounts for latency).
 */
export function useRoom(code: string | null, onRemote: (s: RoomState, by: string, reason: string) => void, onTarget: (t: RoomTarget) => void): RoomApi {
  const [connected, setConnected] = useState(false);
  const [you, setYou] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [chat, setChat] = useState<RoomChat[]>([]);
  const [reactions, setReactions] = useState<{ id: number; emoji: string; name: string }[]>([]);
  const ws = useRef<WebSocket | null>(null);
  const skew = useRef(0);
  const remote = useRef(onRemote);
  remote.current = onRemote;
  const target = useRef(onTarget);
  target.current = onTarget;

  useEffect(() => {
    if (!code) return;
    let closed = false;
    let retry = 0;
    let pingTimer = 0;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}${withProfile(`/ws/rooms/${code}`)}`);
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        setConnected(true);
        pingTimer = window.setInterval(() => sock.readyState === 1 && sock.send(JSON.stringify({ t: 'ping', c: Date.now() })), 10_000);
        sock.send(JSON.stringify({ t: 'ping', c: Date.now() }));
      };
      sock.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Record<string, unknown> & { t: string };
        const now = () => Date.now() + skew.current;
        const project = (s: RoomState): RoomState => ({ ...s, position: s.playing ? s.position + ((now() - s.at) / 1000) * s.rate : s.position });
        if (m.t === 'welcome') {
          const room = m.room as { state: RoomState; members: RoomMember[]; chat: RoomChat[] };
          skew.current = (m.now as number) - Date.now();
          setYou(m.you as string);
          setMembers(room.members);
          setChat(room.chat);
          remote.current(project(room.state), '', 'join');
        } else if (m.t === 'pong') {
          const rtt = Date.now() - (m.c as number);
          skew.current = (m.s as number) + rtt / 2 - Date.now();
        } else if (m.t === 'state') remote.current(project(m.state as RoomState), String(m.byName ?? ''), String(m.reason ?? ''));
        else if (m.t === 'members') setMembers(m.members as RoomMember[]);
        else if (m.t === 'chat') setChat((c) => [...c.slice(-80), m.msg as RoomChat]);
        else if (m.t === 'react') {
          const id = Math.random();
          setReactions((r) => [...r.slice(-12), { id, emoji: String(m.emoji), name: String(m.name) }]);
          window.setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 3500);
        } else if (m.t === 'target') target.current(m.target as RoomTarget);
      };
      sock.onclose = () => {
        setConnected(false);
        window.clearInterval(pingTimer);
        if (!closed) window.setTimeout(connect, Math.min(10_000, 800 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearInterval(pingTimer);
      ws.current?.close();
    };
  }, [code]);

  const send = (o: unknown) => ws.current?.readyState === 1 && ws.current.send(JSON.stringify(o));
  return {
    connected,
    you,
    members,
    chat,
    reactions,
    sendState: useCallback((s, reason) => send({ t: 'state', ...s, reason }), []),
    sendChat: useCallback((text) => send({ t: 'chat', text }), []),
    react: useCallback((emoji) => send({ t: 'react', emoji }), []),
    setBuffering: useCallback((on) => send({ t: 'buffering', on }), []),
  };
}
