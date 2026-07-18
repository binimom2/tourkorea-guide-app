/* ══════════════════════════════════════════════════════════════════
   자료실 백엔드 (Cloudflare Pages Function) — R2 파일 저장소
   - 로그인(Supabase Auth) 토큰을 검증한 뒤에만 동작
   - R2 바인딩 이름: FILES_BUCKET  (Cloudflare Pages 설정에서 연결)
   경로: /api/files/<action>
     GET    list?prefix=폴더/           → 목록(폴더+파일)
     PUT    put?key=폴더/파일명          → 업로드(본문=파일 바이트)
     POST   folder  {path:"폴더/이름"}   → 빈 폴더 만들기
     GET    get?key=...  (&dl=1)         → 다운로드/미리보기
     DELETE del?key=...  (&folder=1)     → 삭제(폴더면 하위 전체)
   ══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://aplevsrmxkzghutihyvs.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FVavEEBxGZRRvU19F27koA_a4hJUiRl';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json;charset=utf-8' } });

// 로그인한 사용자 확인: Authorization: Bearer <access_token> 을 Supabase에 물어봄
async function getUser(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) {
    return null;
  }
}
const roleOf = (u) => (u && u.user_metadata && u.user_metadata.role) || 'staff';

// 경로 안전화: 상위이동(..)/역슬래시/선행 슬래시 차단
function safeKey(k) {
  k = String(k || '').replace(/^\/+/, '');
  if (!k || k.indexOf('..') >= 0 || k.indexOf('\\') >= 0) return null;
  return k;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const bucket = env.FILES_BUCKET;
  const url = new URL(request.url);
  const seg = params.path || [];
  const action = Array.isArray(seg) ? seg[0] : seg;

  if (!bucket)
    return json({ error: '저장소(R2)가 아직 연결되지 않았습니다. Cloudflare Pages 설정에서 FILES_BUCKET 바인딩을 추가하세요.' }, 500);

  const user = await getUser(request);
  if (!user) return json({ error: '로그인이 필요합니다.' }, 401);

  try {
    // ── 목록 ──
    if (action === 'list' && request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      const out = await bucket.list({ prefix, delimiter: '/', include: ['httpMetadata', 'customMetadata'] });
      const folders = (out.delimitedPrefixes || []).map((p) => ({ prefix: p, name: p.slice(prefix.length).replace(/\/$/, '') }));
      const files = (out.objects || [])
        .filter((o) => !o.key.endsWith('.keep'))
        .map((o) => ({
          key: o.key,
          name: o.key.slice(prefix.length),
          size: o.size,
          uploaded: o.uploaded,
          type: (o.httpMetadata && o.httpMetadata.contentType) || '',
          by: (o.customMetadata && o.customMetadata.by) || '',
        }));
      return json({ prefix, folders, files });
    }

    // ── 업로드 ──
    if (action === 'put' && request.method === 'PUT') {
      const key = safeKey(url.searchParams.get('key'));
      if (!key) return json({ error: '잘못된 파일 경로' }, 400);
      const ct = request.headers.get('x-file-type') || 'application/octet-stream';
      await bucket.put(key, request.body, {
        httpMetadata: { contentType: ct },
        customMetadata: { by: user.email || user.id },
      });
      return json({ ok: true, key });
    }

    // ── 빈 폴더 만들기 ──
    if (action === 'folder' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      let key = safeKey(body.path);
      if (!key) return json({ error: '잘못된 폴더 경로' }, 400);
      if (!key.endsWith('/')) key += '/';
      await bucket.put(key + '.keep', new Uint8Array(0));
      return json({ ok: true });
    }

    // ── 다운로드 / 미리보기 ──
    if (action === 'get' && request.method === 'GET') {
      const key = safeKey(url.searchParams.get('key'));
      if (!key) return json({ error: '잘못된 파일 경로' }, 400);
      const obj = await bucket.get(key);
      if (!obj) return json({ error: '파일을 찾을 수 없습니다.' }, 404);
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set('etag', obj.httpEtag);
      h.set('Cache-Control', 'private, max-age=60');
      if (url.searchParams.get('dl')) {
        const fn = key.split('/').pop();
        h.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fn));
      }
      return new Response(obj.body, { headers: h });
    }

    // ── 삭제 (폴더면 하위 전체) ──
    if (action === 'del' && request.method === 'DELETE') {
      const r = roleOf(user);
      if (r !== 'admin' && r !== 'manager') return json({ error: '삭제 권한이 없습니다. (관리자/매니저만 가능)' }, 403);
      const key = safeKey(url.searchParams.get('key'));
      if (!key) return json({ error: '잘못된 경로' }, 400);
      if (url.searchParams.get('folder')) {
        let p = key.endsWith('/') ? key : key + '/';
        let cursor,
          n = 0;
        do {
          const l = await bucket.list({ prefix: p, cursor });
          for (const o of l.objects) {
            await bucket.delete(o.key);
            n++;
          }
          cursor = l.truncated ? l.cursor : null;
        } while (cursor);
        return json({ ok: true, deleted: n });
      }
      await bucket.delete(key);
      return json({ ok: true });
    }

    return json({ error: '알 수 없는 요청입니다.' }, 404);
  } catch (e) {
    return json({ error: '서버 오류: ' + ((e && e.message) || e) }, 500);
  }
}
