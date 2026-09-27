import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Heart, MessageCircle, Share2, Music, Volume2, VolumeX, Play, ArrowLeft, AlertTriangle, Send, Plus, Check, RefreshCw, CornerDownRight, Upload } from 'lucide-react';
import { toast } from 'sonner';
import ShareMenu from '@/components/share/ShareMenu';

interface Short {
  id: string;          // unique key in list (may be suffixed)
  realId: string;      // actual talent_media id
  user_id: string;
  url: string;
  title: string | null;
  description: string | null;
  category?: string | null;
  profile?: { name: string | null; avatar_url: string | null };
  likes?: number;
  liked?: boolean;
  comments_count?: number;
}

interface Comment {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
  parent_id: string | null;
  profile?: { name: string | null; avatar_url: string | null };
  likes?: number;
  liked?: boolean;
  replies?: Comment[];
  repliesLoaded?: boolean;
}

const shuffle = <T,>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const ShortsPage: React.FC = () => {
  const navigate = useNavigate();
  const [shorts, setShorts] = useState<Short[]>([]);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(true);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [videoErrors, setVideoErrors] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [heartBurst, setHeartBurst] = useState<Record<string, number>>({});
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [activeIdx, setActiveIdx] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState<Short | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const tapTimers = useRef<Record<string, any>>({});
  const authorScore = useRef<Map<string, number>>(new Map());
  const categoryScore = useRef<Map<string, number>>(new Map());
  const seenRealIds = useRef<Set<string>>(new Set());
  const watchAccum = useRef<Map<string, number>>(new Map()); // realId -> seconds in this session
  const sessionDelta = useRef<Map<string, number>>(new Map()); // realId -> unsaved delta
  const lastTickRef = useRef<{ key: string; t: number } | null>(null);
  const flushTimer = useRef<any>(null);
  const [newCount, setNewCount] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<'uploading' | 'saving'>('uploading');
  const [uploadSlow, setUploadSlow] = useState(false);
  const [uploadFileName, setUploadFileName] = useState('');
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const latestCreatedAt = useRef<string | null>(null);


  useEffect(() => { load(); }, []);

  // Realtime: detect new shorts inserted by anyone
  useEffect(() => {
    const channel = supabase
      .channel('shorts-feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'talent_media' },
        (payload) => {
          const row: any = payload.new;
          if (!row || !['short', 'video'].includes(row.media_type)) return;
          if (seenRealIds.current.has(row.id)) return;
          // Own upload → refresh silently and bring to top
          if (currentUser && row.user_id === currentUser) {
            refreshTop();
          } else {
            setNewCount((n) => n + 1);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [currentUser]);

  // Fetch newest shorts and prepend them to the feed
  const refreshTop = async () => {
    let q = supabase
      .from('talent_media')
      .select('*')
      .in('media_type', ['short', 'video'])
      .order('created_at', { ascending: false })
      .limit(30);
    if (latestCreatedAt.current) q = q.gt('created_at', latestCreatedAt.current);
    const { data } = await q;
    const fresh = (data || []).filter((r: any) => !seenRealIds.current.has(r.id));
    if (fresh.length === 0) { setNewCount(0); return; }
    fresh.forEach((r: any) => seenRealIds.current.add(r.id));
    latestCreatedAt.current = fresh[0].created_at;
    const enriched = await enrich(fresh, currentUser || undefined);
    setShorts(prev => [...enriched, ...prev]);
    setNewCount(0);
    setActiveIdx(0);
    requestAnimationFrame(() => {
      const container = document.querySelector('[data-shorts-scroll]') as HTMLElement | null;
      container?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  // Periodic + unmount flush of watch deltas
  useEffect(() => {
    flushTimer.current = setInterval(() => flushEngagement(), 5000);
    const onHide = () => flushEngagement();
    window.addEventListener('beforeunload', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(flushTimer.current);
      window.removeEventListener('beforeunload', onHide);
      document.removeEventListener('visibilitychange', onHide);
      flushEngagement();
    };
  }, [currentUser]);

  const load = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    setCurrentUser(user?.id || null);

    let followedIds: string[] = [];
    if (user) {
      const { data: conns } = await supabase
        .from('connections')
        .select('user_id, connected_user_id, status')
        .or(`user_id.eq.${user.id},connected_user_id.eq.${user.id}`)
        .eq('status', 'accepted');
      const fset = new Set<string>();
      (conns || []).forEach(c => {
        const other = c.user_id === user.id ? c.connected_user_id : c.user_id;
        if (other) fset.add(other);
      });
      followedIds = Array.from(fset);
      setFollowing(fset);

      // Restore persisted engagement → seed author/category scores so recos stay coherent
      const { data: eng } = await supabase
        .from('short_engagements')
        .select('media_id, watch_seconds, liked, passed, talent_media!inner(user_id, category)')
        .eq('user_id', user.id);
      (eng as any[] || []).forEach((e) => {
        const tm = e.talent_media;
        if (!tm) return;
        let score = 0;
        if (e.liked) score += 5;
        if (e.watch_seconds > 15) score += 2;
        else if (e.watch_seconds > 5) score += 0.5;
        if (e.passed) score -= 1;
        if (score !== 0) {
          authorScore.current.set(tm.user_id, (authorScore.current.get(tm.user_id) || 0) + score);
          if (tm.category) categoryScore.current.set(tm.category, (categoryScore.current.get(tm.category) || 0) + score);
        }
        seenRealIds.current.add(e.media_id);
      });
    }

    let query = supabase
      .from('talent_media')
      .select('*')
      .in('media_type', ['short', 'video'])
      .order('created_at', { ascending: false })
      .limit(100);

    if (followedIds.length > 0) {
      query = query.in('user_id', followedIds);
    }

    let { data } = await query;
    if (!data || data.length === 0) {
      const fallback = await supabase
        .from('talent_media')
        .select('*')
        .in('media_type', ['short', 'video'])
        .order('created_at', { ascending: false })
        .limit(50);
      data = fallback.data || [];
    }

    // Keep newest first; only lightly shuffle the tail to add variety
    const head = (data || []).slice(0, 5);
    const tail = shuffle((data || []).slice(5));
    const items = [...head, ...tail];
    if (items[0]?.created_at) latestCreatedAt.current = items[0].created_at;
    items.forEach((i: any) => seenRealIds.current.add(i.id));
    const enriched = await enrich(items, user?.id);
    setShorts(enriched);
    setLoading(false);
  };

  // Persist accumulated session deltas + flags to short_engagements
  const flushEngagement = async () => {
    if (!currentUser || sessionDelta.current.size === 0) return;
    const rows = Array.from(sessionDelta.current.entries()).map(([media_id, watch_seconds]) => ({
      media_id, watch_seconds, user_id: currentUser,
    }));
    sessionDelta.current.clear();
    // Fetch existing rows to sum
    const ids = rows.map(r => r.media_id);
    const { data: existing } = await supabase
      .from('short_engagements')
      .select('media_id, watch_seconds, view_count')
      .eq('user_id', currentUser)
      .in('media_id', ids);
    const exMap = new Map((existing || []).map(e => [e.media_id, e]));
    const payload = rows.map(r => {
      const ex = exMap.get(r.media_id);
      return {
        user_id: currentUser,
        media_id: r.media_id,
        watch_seconds: (ex?.watch_seconds ? Number(ex.watch_seconds) : 0) + r.watch_seconds,
        view_count: (ex?.view_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      };
    });
    await supabase.from('short_engagements').upsert(payload, { onConflict: 'user_id,media_id' });
  };

  const recordEngagement = (s: Short, kind: 'watch' | 'like' | 'pass', weight = 1) => {
    const a = authorScore.current.get(s.user_id) || 0;
    authorScore.current.set(s.user_id, a + (kind === 'pass' ? -weight : weight));
    if (s.category) {
      const c = categoryScore.current.get(s.category) || 0;
      categoryScore.current.set(s.category, c + (kind === 'pass' ? -weight : weight));
    }
  };

  // Persist pass/like flags immediately on the engagement row
  const persistFlag = async (realId: string, fields: { liked?: boolean; passed?: boolean }) => {
    if (!currentUser) return;
    await supabase.from('short_engagements').upsert(
      { user_id: currentUser, media_id: realId, ...fields, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,media_id' }
    );
  };

  const enrich = async (items: any[], uid?: string): Promise<Short[]> => {
    if (items.length === 0) return [];
    const ids = [...new Set(items.map(i => i.user_id))];
    const mediaIds = items.map(i => i.id);
    const [{ data: profiles }, likesAgg, mineLikes, commentsAgg] = await Promise.all([
      supabase.from('profiles').select('id, name, avatar_url').in('id', ids),
      supabase.from('media_likes').select('media_id').in('media_id', mediaIds),
      uid ? supabase.from('media_likes').select('media_id').in('media_id', mediaIds).eq('user_id', uid) : Promise.resolve({ data: [] as any[] }),
      supabase.from('media_comments').select('media_id').in('media_id', mediaIds),
    ]);
    const pmap = new Map((profiles || []).map(p => [p.id, p]));
    const likeCount = new Map<string, number>();
    (likesAgg.data as any[] || []).forEach((l: any) => likeCount.set(l.media_id, (likeCount.get(l.media_id) || 0) + 1));
    const commentCount = new Map<string, number>();
    (commentsAgg.data as any[] || []).forEach((c: any) => commentCount.set(c.media_id, (commentCount.get(c.media_id) || 0) + 1));
    const mineSet = new Set((mineLikes.data as any[] || []).map((l: any) => l.media_id));
    return items.map((i, k) => ({
      id: `${i.id}-${Date.now()}-${k}`,
      realId: i.id,
      user_id: i.user_id,
      url: i.url,
      title: i.title,
      description: i.description,
      category: i.category,
      profile: pmap.get(i.user_id),
      likes: likeCount.get(i.id) || 0,
      liked: mineSet.has(i.id),
      comments_count: commentCount.get(i.id) || 0,
    }));
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => entries.forEach(e => {
        const v = e.target as HTMLVideoElement;
        const idx = Number(v.dataset.idx);
        if (e.intersectionRatio > 0.7) {
          v.play().catch(() => {});
          setActiveIdx(idx);
        } else {
          v.pause();
        }
      }),
      { threshold: [0, 0.7, 1] }
    );
    videoRefs.current.forEach(v => v && observer.observe(v));
    return () => observer.disconnect();
  }, [shorts]);

  const prevActiveRef = useRef<number>(-1);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev >= 0 && prev !== activeIdx && shorts[prev]) {
      const prevShort = shorts[prev];
      const v = videoRefs.current[prev];
      const watched = watchAccum.current.get(prevShort.realId) || 0;
      const dur = v?.duration || 0;
      if (dur > 0) {
        const ratio = watched / dur;
        if (ratio < 0.25 && watched < 4) {
          recordEngagement(prevShort, 'pass', 1);
          persistFlag(prevShort.realId, { passed: true });
        } else if (ratio > 0.7 || watched > 15) {
          recordEngagement(prevShort, 'watch', 2);
        } else {
          recordEngagement(prevShort, 'watch', 0.5);
        }
      } else if (watched > 5) {
        recordEngagement(prevShort, 'watch', 1);
      }
      flushEngagement();
    }
    prevActiveRef.current = activeIdx;
    if (shorts.length > 0 && activeIdx >= shorts.length - 2) {
      appendMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx]);

  const appendMore = async () => {
    const topAuthors = Array.from(authorScore.current.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
    const topCategories = Array.from(categoryScore.current.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);

    const exclude = Array.from(seenRealIds.current);
    let query = supabase
      .from('talent_media')
      .select('*')
      .in('media_type', ['short', 'video'])
      .limit(50);
    if (exclude.length > 0 && exclude.length < 200) {
      query = query.not('id', 'in', `(${exclude.join(',')})`);
    }
    const { data } = await query;
    let pool = data || [];

    if (pool.length > 0 && (topAuthors.length > 0 || topCategories.length > 0)) {
      const score = (m: any) =>
        (topAuthors.includes(m.user_id) ? (authorScore.current.get(m.user_id) || 0) : 0) +
        (m.category && topCategories.includes(m.category) ? (categoryScore.current.get(m.category) || 0) * 0.5 : 0) +
        Math.random() * 0.3;
      pool = [...pool].sort((a, b) => score(b) - score(a));
    } else {
      pool = shuffle(pool);
    }

    if (pool.length === 0) return;
    const more = await enrich(pool.slice(0, 20), currentUser || undefined);
    more.forEach(m => seenRealIds.current.add(m.realId));
    setShorts(prev => [...prev, ...more]);
  };

  const toggleLike = async (s: Short, idx: number, animate = false) => {
    if (!currentUser) { toast.error('Connectez-vous'); return; }
    const was = s.liked;
    setShorts(prev => prev.map((x, i) => i === idx ? { ...x, liked: animate ? true : !was, likes: (x.likes || 0) + ((animate ? (was ? 0 : 1) : (was ? -1 : 1))) } : x));
    if (animate) setHeartBurst(p => ({ ...p, [s.id]: Date.now() }));
    if (animate && was) return;
    if (!was) recordEngagement(s, 'like', 5);
    if (was) {
      await supabase.from('media_likes').delete().eq('media_id', s.realId).eq('user_id', currentUser);
      persistFlag(s.realId, { liked: false });
    } else {
      await supabase.from('media_likes').insert({ media_id: s.realId, user_id: currentUser });
      persistFlag(s.realId, { liked: true });
    }
  };

  const handleTap = (s: Short, idx: number) => {
    const key = s.id;
    if (tapTimers.current[key]) {
      clearTimeout(tapTimers.current[key]);
      tapTimers.current[key] = null;
      toggleLike(s, idx, true);
    } else {
      tapTimers.current[key] = setTimeout(() => {
        tapTimers.current[key] = null;
        setMuted(m => !m);
      }, 250);
    }
  };

  const toggleFollow = async (targetId: string) => {
    if (!currentUser) { toast.error('Connectez-vous'); return; }
    if (currentUser === targetId) return;
    const isFollowing = following.has(targetId);
    if (isFollowing) {
      await supabase.from('connections').delete()
        .or(`and(user_id.eq.${currentUser},connected_user_id.eq.${targetId}),and(user_id.eq.${targetId},connected_user_id.eq.${currentUser})`);
      setFollowing(prev => { const n = new Set(prev); n.delete(targetId); return n; });
    } else {
      await supabase.from('connections').insert({ user_id: currentUser, connected_user_id: targetId, status: 'accepted' });
      setFollowing(prev => new Set(prev).add(targetId));
      toast.success('Abonné');
    }
  };

  const loadComments = async (short: Short) => {
    setCommentsLoading(true);
    const { data } = await supabase
      .from('media_comments')
      .select('*')
      .eq('media_id', short.realId)
      .is('parent_id', null)
      .order('created_at', { ascending: false });
    const list = (data as any[]) || [];
    if (list.length === 0) { setComments([]); setCommentsLoading(false); return; }
    const ids = [...new Set(list.map(c => c.user_id))];
    const cIds = list.map(c => c.id);
    const [{ data: profiles }, likesAgg, mineLikes, repliesAgg] = await Promise.all([
      supabase.from('profiles').select('id, name, avatar_url').in('id', ids),
      supabase.from('media_comment_likes').select('comment_id').in('comment_id', cIds),
      currentUser
        ? supabase.from('media_comment_likes').select('comment_id').in('comment_id', cIds).eq('user_id', currentUser)
        : Promise.resolve({ data: [] as any[] }),
      supabase.from('media_comments').select('parent_id').in('parent_id', cIds),
    ]);
    const pmap = new Map((profiles || []).map(p => [p.id, p]));
    const likeCount = new Map<string, number>();
    (likesAgg.data as any[] || []).forEach(l => likeCount.set(l.comment_id, (likeCount.get(l.comment_id) || 0) + 1));
    const replyCount = new Map<string, number>();
    (repliesAgg.data as any[] || []).forEach((r: any) => replyCount.set(r.parent_id, (replyCount.get(r.parent_id) || 0) + 1));
    const mineSet = new Set((mineLikes.data as any[] || []).map(l => l.comment_id));
    setComments(list.map(c => ({
      ...c, profile: pmap.get(c.user_id),
      likes: likeCount.get(c.id) || 0,
      liked: mineSet.has(c.id),
      replies: replyCount.get(c.id) ? new Array(replyCount.get(c.id)).fill(null) : [],
      repliesLoaded: false,
    })));
    setCommentsLoading(false);
  };

  const openComments = async (short: Short) => {
    setCommentsOpen(short);
    setComments([]);
    setReplyTo(null);
    setNewComment('');
    loadComments(short);
  };

  const loadReplies = async (c: Comment) => {
    const { data } = await supabase
      .from('media_comments')
      .select('*')
      .eq('parent_id', c.id)
      .order('created_at', { ascending: true });
    const list = (data as any[]) || [];
    const ids = [...new Set(list.map(x => x.user_id))];
    const cIds = list.map(x => x.id);
    const [profilesRes, likesAgg, mineLikes] = await Promise.all([
      ids.length ? supabase.from('profiles').select('id,name,avatar_url').in('id', ids) : Promise.resolve({ data: [] as any[] }),
      cIds.length ? supabase.from('media_comment_likes').select('comment_id').in('comment_id', cIds) : Promise.resolve({ data: [] as any[] }),
      currentUser && cIds.length
        ? supabase.from('media_comment_likes').select('comment_id').in('comment_id', cIds).eq('user_id', currentUser)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const pmap = new Map(((profilesRes as any).data as any[] || []).map(p => [p.id, p]));
    const likeCount = new Map<string, number>();
    (likesAgg.data as any[] || []).forEach(l => likeCount.set(l.comment_id, (likeCount.get(l.comment_id) || 0) + 1));
    const mineSet = new Set((mineLikes.data as any[] || []).map(l => l.comment_id));
    const replies = list.map(r => ({
      ...r, profile: pmap.get(r.user_id),
      likes: likeCount.get(r.id) || 0, liked: mineSet.has(r.id),
    }));
    setComments(prev => prev.map(x => x.id === c.id ? { ...x, replies, repliesLoaded: true } : x));
  };

  const toggleCommentLike = async (c: Comment, parentId?: string) => {
    if (!currentUser) { toast.error('Connectez-vous'); return; }
    const was = !!c.liked;
    const apply = (cm: Comment): Comment => cm.id === c.id
      ? { ...cm, liked: !was, likes: (cm.likes || 0) + (was ? -1 : 1) } : cm;
    setComments(prev => prev.map(top =>
      parentId
        ? (top.id === parentId ? { ...top, replies: (top.replies || []).map(apply) } : top)
        : apply(top)
    ));
    if (was) {
      await supabase.from('media_comment_likes').delete().eq('comment_id', c.id).eq('user_id', currentUser);
    } else {
      await supabase.from('media_comment_likes').insert({ comment_id: c.id, user_id: currentUser });
    }
  };

  const submitComment = async () => {
    if (!currentUser || !commentsOpen || !newComment.trim()) return;
    const parent_id = replyTo?.id || null;
    const { data, error } = await supabase.from('media_comments')
      .insert({ media_id: commentsOpen.realId, user_id: currentUser, content: newComment.trim(), parent_id })
      .select().single();
    if (error) { toast.error(error.message); return; }
    const { data: profile } = await supabase.from('profiles').select('id, name, avatar_url').eq('id', currentUser).single();
    const newC: Comment = { ...(data as any), profile, likes: 0, liked: false };
    if (parent_id) {
      setComments(prev => prev.map(top => top.id === parent_id
        ? { ...top, replies: [...(top.replies || []).filter(r => r), newC], repliesLoaded: true }
        : top));
    } else {
      setComments(prev => [{ ...newC, replies: [], repliesLoaded: true }, ...prev]);
      setShorts(prev => prev.map(s => s.id === commentsOpen.id ? { ...s, comments_count: (s.comments_count || 0) + 1 } : s));
    }
    setNewComment('');
    setReplyTo(null);
  };

  const MAX_SHORT_SIZE = 200 * 1024 * 1024; // 200 MB

  const cancelUpload = () => {
    uploadXhrRef.current?.abort();
  };

  const handleUploadShort = async (file: File) => {
    if (!file) return;
    if (!currentUser) { toast.error('Connectez-vous pour publier'); return; }
    if (!file.type.startsWith('video/')) {
      toast.error(`Format non accepté (${file.type || 'inconnu'}). Choisissez une vidéo (MP4, MOV, WEBM…).`);
      return;
    }
    if (file.size > MAX_SHORT_SIZE) {
      toast.error(`Fichier trop volumineux (${Math.round(file.size / (1024 * 1024))} Mo). Maximum : 200 Mo.`);
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    setUploadPhase('uploading');
    setUploadSlow(false);
    setUploadFileName(file.name);
    const startedAt = Date.now();
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { toast.error('Session expirée. Reconnectez-vous puis réessayez.'); return; }

      const ext = file.name.split('.').pop() || 'mp4';
      const path = `${currentUser}/shorts/${Date.now()}.${ext}`;
      const url = `${supabase.supabaseUrl}/storage/v1/object/profile-files/${path.split('/').map(encodeURIComponent).join('/')}`;

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        uploadXhrRef.current = xhr;
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('x-upsert', 'false');
        if (file.type) xhr.setRequestHeader('Content-Type', file.type);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
            if (Date.now() - startedAt > 15000) setUploadSlow(true);
          }
        };
        xhr.timeout = 180000; // 3 min max
        xhr.ontimeout = () => reject(new Error("Le transfert a trop duré (plus de 3 minutes). Vérifiez votre connexion puis réessayez."));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
          let msg = `Échec de l'envoi (code ${xhr.status}). Réessayez.`;
          try {
            const body = JSON.parse(xhr.responseText || '{}');
            const detail = (body.message || body.error || '').toString().toLowerCase();
            if (xhr.status === 413 || xhr.status === 422 || detail.includes('size') || detail.includes('too large')) {
              msg = `Fichier trop volumineux (max 200 Mo).`;
            } else if (xhr.status === 401 || xhr.status === 403) {
              msg = 'Session expirée. Reconnectez-vous puis réessayez.';
            } else if (xhr.status === 409) {
              msg = 'Un fichier identique existe déjà. Réessayez.';
            } else if (detail) {
              msg = `Échec de l'envoi : ${body.message || body.error}`;
            }
          } catch { /* keep default message */ }
          reject(new Error(msg));
        };
        xhr.onerror = () => reject(new Error("Connexion interrompue pendant l'envoi. Vérifiez votre réseau puis réessayez."));
        xhr.onabort = () => {
          const err = new Error('Upload annulé') as Error & { aborted?: boolean };
          err.aborted = true;
          reject(err);
        };
        xhr.send(file);
      });

      // Storage OK → save the short in the feed
      setUploadPhase('saving');
      const { data: urlData } = supabase.storage.from('profile-files').getPublicUrl(path);
      const { error } = await supabase.from('talent_media').insert({
        user_id: currentUser,
        media_type: 'short',
        url: urlData.publicUrl,
        title: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || null,
      });
      if (error) {
        toast.error(`La vidéo a été envoyée mais la publication a échoué : ${error.message}`);
        return;
      }
      toast.success('Short publié !');
      // Realtime listener will prepend, but also refresh to be safe
      refreshTop();
    } catch (e: any) {
      if (e?.aborted) {
        toast.info('Upload annulé');
      } else {
        toast.error(e?.message || "Erreur lors de la publication. Réessayez.");
      }
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadSlow(false);
      uploadXhrRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUploadShort(f);
        }}
      />
      <div className="absolute top-3 left-3 right-3 z-30 flex items-center justify-between pointer-events-none">
        <Button size="icon" variant="secondary" className="rounded-full h-9 w-9 pointer-events-auto" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-white font-semibold text-sm bg-black/30 px-3 py-1 rounded-full pointer-events-auto">Shorts</span>
        <div className="flex items-center gap-2 pointer-events-auto">
          <Button
            size="icon" variant="secondary" className="rounded-full h-9 w-9"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Publier un short"
          >
            {uploading
              ? <div className="h-4 w-4 border-2 border-current/30 border-t-current rounded-full animate-spin" />
              : <Upload className="h-4 w-4" />}
          </Button>
          <Button size="icon" variant="secondary" className="rounded-full h-9 w-9" onClick={() => setMuted(m => !m)}>
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {uploading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/75">
          <div className="w-72 max-w-[85vw] text-center text-white">
            <div className="mx-auto mb-3 h-10 w-10 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <p className="text-sm font-semibold mb-1">
              {uploadPhase === 'saving' ? 'Publication du Short…' : 'Envoi de la vidéo…'}
            </p>
            <p className="text-xs text-white/70 mb-3 truncate">
              {uploadFileName}
              {uploadPhase === 'uploading' && uploadProgress > 0 ? ` — ${uploadProgress}%` : ''}
            </p>
            {uploadPhase === 'uploading' && (
              <div className="h-2 w-full rounded-full bg-white/20 overflow-hidden mb-3">
                <div
                  className="h-full rounded-full bg-white transition-all duration-300"
                  style={{ width: `${Math.max(uploadProgress, 4)}%` }}
                />
              </div>
            )}
            {uploadSlow && uploadPhase === 'uploading' && (
              <p className="text-xs text-yellow-300 mb-3">
                Transfert lent — connexion faible. Vous pouvez patienter ou annuler.
              </p>
            )}
            <Button size="sm" variant="outline" className="border-white text-white bg-transparent hover:bg-white hover:text-black" onClick={cancelUpload}>
              Annuler
            </Button>
          </div>
        </div>
      )}

      {newCount > 0 && (
        <button
          onClick={refreshTop}
          className="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-primary text-primary-foreground rounded-full shadow-lg px-4 py-2 text-xs font-semibold flex items-center gap-2 animate-fade-in hover:scale-105 transition"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {newCount} nouvelle{newCount > 1 ? 's' : ''} vidéo{newCount > 1 ? 's' : ''} — Rafraîchir
        </button>
      )}

      {loading ? (
        <div className="h-full flex items-center justify-center text-white/70 text-sm">Chargement...</div>
      ) : shorts.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-white/70 text-sm gap-2 px-6 text-center">
          <Play className="h-10 w-10 opacity-40" />
          <p>Aucun Short pour l'instant.</p>
        </div>
      ) : (
        <div data-shorts-scroll className="h-full overflow-y-auto snap-y snap-mandatory scrollbar-hide" style={{ scrollbarWidth: 'none' }}>
          {shorts.map((short, idx) => {
            const isFollowing = following.has(short.user_id);
            const isSelf = currentUser === short.user_id;
            const prog = progress[short.id] || 0;
            return (
              <div key={short.id} className="relative h-full w-full snap-start snap-always overflow-hidden" style={{ height: '100dvh' }}>
                {videoErrors[short.id] ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-white/80">
                    <AlertTriangle className="h-10 w-10 mb-2 text-yellow-400" />
                    <p className="text-sm">Vidéo indisponible</p>
                  </div>
                ) : (
                  <video
                    ref={el => (videoRefs.current[idx] = el)}
                    data-idx={idx}
                    src={short.url}
                    className="absolute inset-0 w-full h-full object-cover"
                    loop
                    muted={muted}
                    playsInline
                    preload={Math.abs(idx - activeIdx) <= 2 ? 'auto' : 'metadata'}
                    onClick={() => handleTap(short, idx)}
                    onTimeUpdate={(e) => {
                      const v = e.currentTarget;
                      const now = v.currentTime;
                      const last = lastTickRef.current;
                      if (last && last.key === short.realId) {
                        const delta = now - last.t;
                        if (delta > 0 && delta < 1.5) {
                          watchAccum.current.set(short.realId, (watchAccum.current.get(short.realId) || 0) + delta);
                          sessionDelta.current.set(short.realId, (sessionDelta.current.get(short.realId) || 0) + delta);
                        }
                      }
                      lastTickRef.current = { key: short.realId, t: now };
                      if (v.duration) setProgress(p => ({ ...p, [short.id]: (v.currentTime / v.duration) * 100 }));
                    }}
                    onError={() => setVideoErrors(p => ({ ...p, [short.id]: true }))}
                  />
                )}

                {heartBurst[short.id] && (
                  <div
                    key={heartBurst[short.id]}
                    className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"
                  >
                    <Heart className="h-32 w-32 fill-red-500 text-red-500 drop-shadow-2xl" style={{ animation: 'scale-in 0.4s ease-out, fade-out 0.6s ease-out 0.4s forwards' }} />
                  </div>
                )}

                <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />

                <div className="absolute right-2 bottom-28 flex flex-col items-center gap-4 z-10">
                  <button onClick={() => toggleLike(short, idx)} className="flex flex-col items-center text-white">
                    <div className="bg-black/40 backdrop-blur-sm rounded-full p-2.5">
                      <Heart className={`h-6 w-6 transition-transform ${short.liked ? 'fill-red-500 text-red-500 scale-110' : ''}`} />
                    </div>
                    <span className="text-xs mt-1 font-semibold">{short.likes || 0}</span>
                  </button>
                  <button onClick={() => openComments(short)} className="flex flex-col items-center text-white">
                    <div className="bg-black/40 backdrop-blur-sm rounded-full p-2.5">
                      <MessageCircle className="h-6 w-6" />
                    </div>
                    <span className="text-xs mt-1 font-semibold">{short.comments_count || 0}</span>
                  </button>
                  <ShareMenu url={`${window.location.origin}/media?tab=shorts&v=${short.realId}`} title={short.title || 'Short'}>
                    <button className="flex flex-col items-center text-white">
                      <div className="bg-black/40 backdrop-blur-sm rounded-full p-2.5">
                        <Share2 className="h-6 w-6" />
                      </div>
                      <span className="text-xs mt-1 font-semibold">Partager</span>
                    </button>
                  </ShareMenu>
                  <button onClick={() => setMuted(m => !m)} className="flex flex-col items-center text-white">
                    <div className="bg-black/40 backdrop-blur-sm rounded-full p-2.5">
                      {muted ? <VolumeX className="h-6 w-6" /> : <Volume2 className="h-6 w-6" />}
                    </div>
                  </button>
                </div>

                <div className="absolute left-3 right-16 bottom-8 text-white z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <Link to={`/talent/${short.user_id}`} className="relative">
                      <Avatar className="h-10 w-10 border-2 border-white">
                        <AvatarImage src={short.profile?.avatar_url || undefined} />
                        <AvatarFallback>{short.profile?.name?.[0] || 'U'}</AvatarFallback>
                      </Avatar>
                      {!isSelf && (
                        <button
                          onClick={(e) => { e.preventDefault(); toggleFollow(short.user_id); }}
                          className={`absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded-full h-5 w-5 flex items-center justify-center border-2 border-black ${isFollowing ? 'bg-emerald-500' : 'bg-red-500'}`}
                        >
                          {isFollowing ? <Check className="h-3 w-3 text-white" /> : <Plus className="h-3 w-3 text-white" />}
                        </button>
                      )}
                    </Link>
                    <Link to={`/talent/${short.user_id}`} className="font-semibold text-sm hover:underline">
                      @{short.profile?.name || 'user'}
                    </Link>
                  </div>
                  {short.title && <p className="text-sm font-semibold mb-1 line-clamp-1">{short.title}</p>}
                  {short.description && <p className="text-xs opacity-90 line-clamp-2">{short.description}</p>}
                  <div className="flex items-center gap-1.5 mt-2 text-xs opacity-90">
                    <Music className="h-3 w-3 animate-spin" style={{ animationDuration: '4s' }} />
                    <span className="truncate">Audio original · @{short.profile?.name || 'user'}</span>
                  </div>
                </div>

                <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20 z-10">
                  <div className="h-full bg-white transition-all" style={{ width: `${prog}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Comments overlay — video keeps playing behind */}
      <Sheet open={!!commentsOpen} onOpenChange={(o) => { if (!o) { setCommentsOpen(null); setReplyTo(null); } }}>
        <SheetContent side="bottom" className="h-[70vh] flex flex-col p-0 rounded-t-2xl">
          <SheetHeader className="px-4 py-3 border-b flex flex-row items-center justify-between space-y-0">
            <SheetTitle>{comments.length} commentaire{comments.length > 1 ? 's' : ''}</SheetTitle>
            <Button
              size="icon" variant="ghost" className="h-8 w-8"
              onClick={() => commentsOpen && loadComments(commentsOpen)}
              title="Recharger"
            >
              <RefreshCw className={`h-4 w-4 ${commentsLoading ? 'animate-spin' : ''}`} />
            </Button>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {commentsLoading && comments.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">Chargement...</p>
            )}
            {!commentsLoading && comments.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">Soyez le premier à commenter.</p>
            )}
            {comments.map(c => {
              const replyCount = (c.replies || []).length;
              return (
                <div key={c.id} className="flex gap-2">
                  <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarImage src={c.profile?.avatar_url || undefined} />
                    <AvatarFallback>{c.profile?.name?.[0] || 'U'}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold">@{c.profile?.name || 'user'}</p>
                    <p className="text-sm break-words">{c.content}</p>
                    <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                      <button onClick={() => toggleCommentLike(c)} className="flex items-center gap-1 hover:text-foreground">
                        <Heart className={`h-3.5 w-3.5 ${c.liked ? 'fill-red-500 text-red-500' : ''}`} />
                        {c.likes || 0}
                      </button>
                      <button onClick={() => { setReplyTo(c); }} className="hover:text-foreground">Répondre</button>
                    </div>

                    {replyCount > 0 && !c.repliesLoaded && (
                      <button
                        onClick={() => loadReplies(c)}
                        className="text-xs text-primary mt-2 flex items-center gap-1 hover:underline"
                      >
                        <CornerDownRight className="h-3 w-3" /> Voir {replyCount} réponse{replyCount > 1 ? 's' : ''}
                      </button>
                    )}

                    {c.repliesLoaded && (c.replies || []).length > 0 && (
                      <div className="mt-3 space-y-3 border-l-2 border-muted pl-3">
                        {(c.replies || []).filter(r => r).map(r => (
                          <div key={r.id} className="flex gap-2">
                            <Avatar className="h-7 w-7 flex-shrink-0">
                              <AvatarImage src={r.profile?.avatar_url || undefined} />
                              <AvatarFallback>{r.profile?.name?.[0] || 'U'}</AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold">@{r.profile?.name || 'user'}</p>
                              <p className="text-sm break-words">{r.content}</p>
                              <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                                <button onClick={() => toggleCommentLike(r, c.id)} className="flex items-center gap-1 hover:text-foreground">
                                  <Heart className={`h-3.5 w-3.5 ${r.liked ? 'fill-red-500 text-red-500' : ''}`} />
                                  {r.likes || 0}
                                </button>
                                <button onClick={() => setReplyTo(c)} className="hover:text-foreground">Répondre</button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {replyTo && (
            <div className="px-4 py-1.5 text-xs text-muted-foreground bg-muted/50 flex items-center justify-between">
              <span>Réponse à @{replyTo.profile?.name || 'user'}</span>
              <button onClick={() => setReplyTo(null)} className="text-primary hover:underline">Annuler</button>
            </div>
          )}
          <div className="border-t p-3 flex gap-2">
            <Input
              value={newComment}
              onChange={e => setNewComment(e.target.value)}
              placeholder={replyTo ? 'Écrire une réponse...' : 'Ajouter un commentaire...'}
              onKeyDown={e => e.key === 'Enter' && submitComment()}
            />
            <Button size="icon" onClick={submitComment} disabled={!newComment.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default ShortsPage;
