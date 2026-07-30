/* ══════════════════════════════════════════════════════════════════
   계정 관리 백엔드 (Cloudflare Pages Function)
   — 가이드정산서(/) · 여행사 상세예약(/travel/) 공용
   — Supabase Auth 계정을 "관리자 권한"으로 직접 생성/삭제/비번변경한다.
   — service_role 키는 절대 브라우저로 내려가지 않고 이 서버에서만 쓴다.
     Cloudflare Pages → 설정 → 환경 변수(암호화)에 아래 이름으로 등록:
        SUPABASE_SERVICE_ROLE_KEY = (Supabase 프로젝트의 service_role 키)

   경로: POST /api/account   본문(JSON):
     { action:'create',      email, password, metadata:{...} }
     { action:'delete',      id }                     // id = Auth user uuid
     { action:'setPassword', id, password }
     { action:'find',        email }                  // 이메일로 uuid 조회

   호출하는 브라우저는 반드시 로그인 상태여야 하고(Authorization: Bearer <access_token>),
   그 사용자가 관리자여야만 동작한다.
   ══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://aplevsrmxkzghutihyvs.supabase.co';
const SUPABASE_ANON = 'sb_publishable_FVavEEBxGZRRvU19F27koA_a4hJUiRl';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json;charset=utf-8' } });

// 호출자(로그인 사용자) 확인
async function getUser(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

// 관리자 판별: user_metadata.role === 'admin' 이거나, 이메일 아이디가 admin/lds1207
function isAdmin(u) {
  const meta = (u && u.user_metadata) || {};
  if (meta.role === 'admin') return true;
  const local = ((u.email || '').toLowerCase().split('@')[0]) || '';
  return ['admin', 'lds1207'].includes(local);
}

// service_role 로 Auth Admin API 호출
function adminHeaders(key) {
  return { apikey: key, Authorization: 'Bearer ' + key, 'content-type': 'application/json' };
}

async function findUserByEmail(key, email) {
  const target = (email || '').toLowerCase();
  // GoTrue admin 목록은 페이지네이션. 넉넉히 몇 페이지만 훑는다.
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users?page=' + page + '&per_page=200', { headers: adminHeaders(key) });
    if (!r.ok) break;
    const data = await r.json();
    const users = (data && (data.users || data)) || [];
    if (!users.length) break;
    const hit = users.find((x) => (x.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 200) break;
  }
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ error: 'POST 요청만 허용됩니다.' }, 405);

  const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) return json({ error: '서버에 SUPABASE_SERVICE_ROLE_KEY 환경 변수가 설정되지 않았습니다. (Cloudflare Pages 설정에서 등록하세요)' }, 500);

  const caller = await getUser(request);
  if (!caller) return json({ error: '로그인이 필요합니다. 다시 로그인해 주세요.' }, 401);
  if (!isAdmin(caller)) return json({ error: '관리자만 계정을 관리할 수 있습니다.' }, 403);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: '잘못된 요청 형식입니다.' }, 400); }
  const action = body.action;

  try {
    if (action === 'create') {
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      if (!email || !password) return json({ error: '이메일과 비밀번호가 필요합니다.' }, 400);
      const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
        method: 'POST',
        headers: adminHeaders(KEY),
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: body.metadata || {} }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (data && (data.msg || data.message || data.error_description || data.error)) || '';
        if (/already|registered|exists|duplicate/i.test(msg)) return json({ error: '이미 등록된 계정(이메일)입니다.' }, 409);
        return json({ error: '계정 생성 실패: ' + (msg || ('HTTP ' + r.status)) }, 400);
      }
      return json({ ok: true, id: data.id, email });
    }

    if (action === 'find') {
      const email = (body.email || '').trim().toLowerCase();
      if (!email) return json({ error: '이메일이 필요합니다.' }, 400);
      const hit = await findUserByEmail(KEY, email);
      return json({ ok: true, id: hit ? hit.id : null });
    }

    if (action === 'delete') {
      let id = body.id;
      if (!id && body.email) { const hit = await findUserByEmail(KEY, body.email); id = hit && hit.id; }
      if (!id) return json({ error: '삭제할 계정을 찾지 못했습니다.' }, 404);
      const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + id, { method: 'DELETE', headers: adminHeaders(KEY) });
      if (!r.ok && r.status !== 404) {
        const data = await r.json().catch(() => ({}));
        return json({ error: '계정 삭제 실패: ' + ((data && (data.msg || data.message)) || ('HTTP ' + r.status)) }, 400);
      }
      return json({ ok: true });
    }

    if (action === 'setPassword') {
      let id = body.id;
      if (!id && body.email) { const hit = await findUserByEmail(KEY, body.email); id = hit && hit.id; }
      if (!id) return json({ error: '대상 계정을 찾지 못했습니다.' }, 404);
      const password = body.password || '';
      if (!password) return json({ error: '새 비밀번호가 필요합니다.' }, 400);
      const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + id, {
        method: 'PUT', headers: adminHeaders(KEY), body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return json({ error: '비밀번호 변경 실패: ' + ((data && (data.msg || data.message)) || ('HTTP ' + r.status)) }, 400);
      }
      return json({ ok: true });
    }

    if (action === 'update') {
      let id = body.id;
      if (!id && body.oldEmail) { const hit = await findUserByEmail(KEY, body.oldEmail); id = hit && hit.id; }
      if (!id) return json({ error: '대상 계정을 찾지 못했습니다.' }, 404);
      const patch = {};
      if (body.email) { patch.email = String(body.email).toLowerCase(); patch.email_confirm = true; }
      if (body.password) patch.password = body.password;
      if (body.metadata) patch.user_metadata = body.metadata;
      if (!Object.keys(patch).length) return json({ error: '변경할 내용이 없습니다.' }, 400);
      const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + id, {
        method: 'PUT', headers: adminHeaders(KEY), body: JSON.stringify(patch),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (data && (data.msg || data.message || data.error)) || ('HTTP ' + r.status);
        if (/already|registered|exists|duplicate/i.test(msg)) return json({ error: '이미 사용 중인 아이디(이메일)입니다.' }, 409);
        return json({ error: '변경 실패: ' + msg }, 400);
      }
      return json({ ok: true, id });
    }

    return json({ error: '알 수 없는 요청입니다.' }, 404);
  } catch (e) {
    return json({ error: '서버 오류: ' + ((e && e.message) || e) }, 500);
  }
}
