/* ══════════════════════════════════════════════════════════════════
   골프 사이트 사진 저장소 (Cloudflare Pages Function) — R2

   손님 사이트(/golf/site/)의 골프장·호텔·스파 사진을 관리 화면에서 바로 올린다.
   전에는 img/ 폴더에 파일을 직접 넣고 배포해야 했다.

   R2 바인딩: FILES_BUCKET (직원 자료실 /api/files 와 같은 버킷, golfsite/ 아래에만 쓴다)

   경로: /api/golf-img/<action>
     GET    list                     → 올려 둔 사진 목록            (로그인·권한 필요)
     PUT    put?name=람차방.jpg       → 업로드(본문 = 파일 바이트)    (로그인·권한 필요)
     DELETE del?key=golfsite/...      → 삭제                        (로그인·권한 필요)
     GET    f/<key>                  → 사진 보기                    (손님이 봐야 하므로 공개)

   ⚠ f/ 는 로그인 없이 열린다 — 손님 브라우저가 <img>로 직접 부르기 때문이다.
      골프장 사진 말고 다른 것을 이 폴더에 올리지 말 것.

   파일 이름에는 올린 시각을 붙인다. 같은 사진을 다시 올리면 주소가 달라져서
   손님 브라우저가 옛 사진을 계속 보여 주는 일이 없다(그래서 1년 캐시를 걸 수 있다).
   ══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://aplevsrmxkzghutihyvs.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FVavEEBxGZRRvU19F27koA_a4hJUiRl';
const ROOT = 'golfsite/';
const MAX_BYTES = 8 * 1024 * 1024;   // 8MB — 관리 화면이 미리 줄여서 보내므로 넉넉하다
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' },
  });

async function getUser(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: auth },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

/* 관리 화면과 같은 판정 — 어드민·매니저만 사진을 올리고 지운다.
   ELEVATED는 명단이 비어도 잠기지 않게 두는 안전장치(관리 화면과 같은 목록). */
const ELEVATED = ['lds1207', 'sooyoung', 'admin'];
function loginIdOf(u) {
  const m = (u && u.user_metadata) || {};
  return String(m.acc_id || m.login_name || ((u && u.email) || '').split('@')[0] || '').toLowerCase();
}
async function canEdit(env, user) {
  const m = (user && user.user_metadata) || {};
  const id = loginIdOf(user);
  if (m.role === 'admin' || ELEVATED.includes(id)) return true;
  const sr = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sr) return false;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/guide_data?data_key=eq.golf_roles&select=data',
      { headers: { apikey: sr, Authorization: 'Bearer ' + sr } }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    const roles = (Array.isArray(rows) && rows[0] && rows[0].data) || {};
    const role = roles[id];
    return role === 'admin' || role === 'manager';
  } catch (e) { return false; }
}

/* 올린 이름을 파일명으로 쓸 수 있게 다듬는다. 한글은 그대로 두되(사장님이 알아보셔야 한다)
   경로를 벗어나게 하는 글자와 공백만 걸러 낸다. */
function makeKey(name) {
  const raw = String(name || 'photo').split(/[\\/]/).pop();
  const dot = raw.lastIndexOf('.');
  let base = (dot > 0 ? raw.slice(0, dot) : raw).trim();
  let ext = (dot > 0 ? raw.slice(dot + 1) : 'jpg').toLowerCase();
  if (!/^(jpg|jpeg|png|webp|gif)$/.test(ext)) ext = 'jpg';
  base = base.replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!base) base = 'photo';
  const stamp = Date.now().toString(36);
  return ROOT + base + '-' + stamp + '.' + ext;
}
/* 이 저장소 밖(자료실 등)을 건드리지 못하게 막는다 */
function safeKey(k) {
  k = String(k || '').replace(/^\/+/, '');
  if (!k || k.indexOf('..') >= 0 || k.indexOf('\\') >= 0) return null;
  if (!k.startsWith(ROOT)) return null;
  return k;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const bucket = env.FILES_BUCKET;
  const url = new URL(request.url);
  const seg = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const action = seg[0] || '';

  if (!bucket) {
    return json({ error: '저장소(R2)가 연결되지 않았습니다. Cloudflare Pages 설정에서 FILES_BUCKET 바인딩을 확인하세요.' }, 500);
  }

  /* ── 사진 보기 — 손님이 봐야 하므로 로그인 없이 연다 ── */
  if (action === 'f' && (request.method === 'GET' || request.method === 'HEAD')) {   /* HEAD도 받는다 — 링크 검사·크롤러가 HEAD로 물어본다 */
    const key = safeKey(ROOT + seg.slice(1).map(decodeURIComponent).join('/'));
    if (!key) return json({ error: '잘못된 경로' }, 400);
    const obj = await bucket.get(key);
    if (!obj) return new Response('not found', { status: 404 });
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set('etag', obj.httpEtag);
    /* 파일명에 올린 시각이 들어 있어 바뀌면 주소도 바뀐다 — 그래서 오래 캐시해도 안전하다 */
    h.set('Cache-Control', 'public, max-age=31536000, immutable');
    h.set('Access-Control-Allow-Origin', '*');
    return new Response(obj.body, { headers: h });
  }

  /* ── 여기부터는 로그인 + 권한 ── */
  const user = await getUser(request);
  if (!user) return json({ error: '로그인이 필요합니다.' }, 401);
  if (!(await canEdit(env, user))) return json({ error: '사진을 올릴 권한이 없습니다. (어드민·매니저만)' }, 403);

  try {
    if (action === 'list' && request.method === 'GET') {
      const out = await bucket.list({ prefix: ROOT, include: ['httpMetadata', 'customMetadata'] });
      const files = (out.objects || []).map((o) => ({
        key: o.key,
        name: o.key.slice(ROOT.length),
        url: '/api/golf-img/f/' + o.key.slice(ROOT.length).split('/').map(encodeURIComponent).join('/'),
        size: o.size,
        uploaded: o.uploaded,
        by: (o.customMetadata && o.customMetadata.by) || '',
      })).sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
      return json({ ok: true, files });
    }

    if (action === 'put' && request.method === 'PUT') {
      const type = (request.headers.get('x-file-type') || '').toLowerCase();
      if (type && !OK_TYPES.includes(type)) return json({ error: '사진 파일만 올릴 수 있습니다.' }, 400);
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_BYTES) return json({ error: '사진이 너무 큽니다(8MB 이하).' }, 413);
      const key = makeKey(url.searchParams.get('name'));
      const body = await request.arrayBuffer();     // 크기를 실제로 확인하려면 한 번 받아야 한다
      if (body.byteLength > MAX_BYTES) return json({ error: '사진이 너무 큽니다(8MB 이하).' }, 413);
      await bucket.put(key, body, {
        httpMetadata: { contentType: type || 'image/jpeg' },
        customMetadata: { by: user.email || user.id },
      });
      const name = key.slice(ROOT.length);
      return json({ ok: true, key, name, url: '/api/golf-img/f/' + encodeURIComponent(name) });
    }

    if (action === 'del' && request.method === 'DELETE') {
      const key = safeKey(url.searchParams.get('key'));
      if (!key) return json({ error: '잘못된 경로' }, 400);
      await bucket.delete(key);
      return json({ ok: true });
    }

    return json({ error: '알 수 없는 요청' }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
