/* ══════════════════════════════════════════════════════════════════
   예약 요청 접수 (Cloudflare Pages Function)

   손님 사이트(/golf/site/)의 장바구니를 「예약 요청」으로 받아 두고,
   관리 화면(/golf/site/admin/ → 📋 예약요청 탭)에서 직원이 본다.

   ── 어디에 담기나
   Supabase `guide_data` 에 **요청 하나가 한 줄**이다.
       data_key = golf_book_<접수번호>     예) golf_book_WT260908-7K3M
       data     = { no, at, status, customer, items, total, staff }
   한 줄에 몰아 담고 통째로 덮어쓰는 방식은 쓰지 않는다 —
   그렇게 하면 두 손님이 같은 순간에 넣을 때 한쪽이 사라진다(전에 겪은 일).

   ── 누가 무엇을 할 수 있나
     create   손님(로그인 없음)도 넣을 수 있다. 다른 요청은 못 읽는다.
     list     로그인 + 어드민·매니저만. 남의 예약을 아무나 보면 안 된다.
     get      〃
     status   〃 (처리 상태·직원 메모 고치기)
   service_role 키는 이 서버에서만 쓰고 브라우저로 내려가지 않는다.

   ⚠ 금액은 «손님 화면에 그때 보이던 값»을 그대로 적어 둔 것이다.
      확정 금액이 아니다 — 직원이 요금표로 다시 확인하고 안내한다.
   ══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://aplevsrmxkzghutihyvs.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FVavEEBxGZRRvU19F27koA_a4hJUiRl';
const PREFIX = 'golf_book_';

const MAX_ITEMS = 20;          // 한 번에 담을 수 있는 줄 수
const MAX_TEXT  = 500;         // 요청사항 한 칸 길이
const MAX_BODY  = 64 * 1024;   // 본문 크기

/* 손님 사이트가 나중에 별도 도메인으로 옮겨가도 여기로 부를 수 있게 열어 둔다
   (요금 API /api/golf-price 와 같은 방식). 남의 예약을 읽는 쪽은 로그인으로 막혀 있다. */
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'content-type': 'application/json;charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
export const onRequestOptions = () =>
  new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });

/* ── 로그인·권한 (사진 저장소 /api/golf-img 와 같은 판정) ── */
const ELEVATED = ['lds1207', 'sooyoung', 'admin'];
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
function loginIdOf(u) {
  const m = (u && u.user_metadata) || {};
  return String(m.acc_id || m.login_name || ((u && u.email) || '').split('@')[0] || '').toLowerCase();
}
async function canSee(env, user) {
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
    return roles[id] === 'admin' || roles[id] === 'manager';
  } catch (e) { return false; }
}

/* ── guide_data 읽고 쓰기 (service_role — RLS를 지나간다) ── */
function srHeaders(key, extra) {
  return Object.assign(
    { apikey: key, Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    extra || {}
  );
}
async function srSelect(key, query) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/guide_data?' + query, { headers: srHeaders(key) });
  if (!r.ok) throw new Error('DB 조회 실패 (HTTP ' + r.status + ')');
  return await r.json();
}
async function srUpsert(key, row) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/guide_data', {
    method: 'POST',
    headers: srHeaders(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error('DB 저장 실패 (HTTP ' + r.status + ')');
}

/* ── 접수번호 — WT + 날짜(태국 시각) + 네 글자.
      헷갈리는 글자(0·O·1·I)는 빼서 전화로 불러 주기 좋게 한다. ── */
const CODE_CHARS = '23456789ACDEFGHJKLMNPQRSTUVWXYZ';
function bookingNo() {
  const t = new Date(Date.now() + 7 * 3600 * 1000);   // 태국(UTC+7) 기준 날짜
  const d = t.getUTCFullYear().toString().slice(2)
          + String(t.getUTCMonth() + 1).padStart(2, '0')
          + String(t.getUTCDate()).padStart(2, '0');
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let tail = '';
  for (const b of buf) tail += CODE_CHARS[b % CODE_CHARS.length];
  return 'WT' + d + '-' + tail;
}

/* ── 손님이 보낸 것을 그대로 믿지 않는다 — 길이를 자르고 쓸 칸만 골라 담는다 ── */
const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 120);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0; };

function cleanItem(x) {
  if (!x || typeof x !== 'object') return null;
  const name = s(x.name, 120);
  if (!name) return null;
  return {
    kind:    s(x.kind, 20),          // courses / hotels / …
    region:  s(x.region, 40),
    name,
    option:  s(x.option, 120),       // 18홀 · 디럭스 씨뷰 …
    date:    s(x.date, 10),
    dateEnd: s(x.dateEnd, 10),
    time:    s(x.time, 40),          // 희망 시간·티타임 — 손님이 자유롭게 적은 요청사항(2026-09-09)
    nights:  num(x.nights),
    rooms:   num(x.rooms),
    pax:     num(x.pax),
    adult:   num(x.adult),
    child:   num(x.child),
    ages:    Array.isArray(x.ages) ? x.ages.slice(0, 10).map(num) : [],
    krw:     num(x.krw),             // 손님 화면에 보이던 합계(원)
    baht:    num(x.baht),
    label:   s(x.label, 200),        // 「2026-09-17 · 4명 · 18홀」
    asked:   !!x.asked,              // 요금이 안 나와 「문의」로 담은 줄
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ error: 'POST 요청만 받습니다.' }, 405);

  const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) return json({ error: '서버에 SUPABASE_SERVICE_ROLE_KEY가 없습니다. (Cloudflare Pages 환경 변수)' }, 500);

  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ error: '요청 내용이 너무 깁니다.' }, 413);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: '잘못된 요청 형식입니다.' }, 400); }
  const action = s(body.action, 20) || 'create';

  try {
    /* ══ 손님이 예약 요청을 넣는다 — 로그인 없이 열려 있다 ══ */
    if (action === 'create') {
      const items = (Array.isArray(body.items) ? body.items : []).map(cleanItem).filter(Boolean);
      if (!items.length) return json({ error: '장바구니가 비어 있습니다.' }, 400);
      if (items.length > MAX_ITEMS) return json({ error: '한 번에 ' + MAX_ITEMS + '줄까지 보내실 수 있습니다.' }, 400);

      const c = body.customer || {};
      const customer = {
        name:  s(c.name, 40),
        tel:   s(c.tel, 40),
        kakao: s(c.kakao, 60),
        email: s(c.email, 120),
        memo:  s(c.memo, MAX_TEXT),
      };
      if (!customer.name) return json({ error: '성함을 적어 주세요.' }, 400);
      if (!customer.tel && !customer.kakao && !customer.email)
        return json({ error: '연락처 · 카카오톡 ID · 이메일 중 하나는 적어 주세요.' }, 400);

      /* 접수번호가 어쩌다 겹치면 앞 건을 덮어써 버린다 — 비어 있는 번호가 나올 때까지 다시 뽑는다 */
      let no = '';
      for (let i = 0; i < 6 && !no; i++) {
        const cand = bookingNo();
        const rows = await srSelect(KEY, 'data_key=eq.' + encodeURIComponent(PREFIX + cand) + '&select=data_key');
        if (!Array.isArray(rows) || !rows.length) no = cand;
      }
      if (!no) return json({ error: '접수번호를 만들지 못했습니다. 잠시 뒤 다시 보내 주세요.' }, 503);

      const total = items.reduce((a, x) => a + x.krw, 0);
      const rec = {
        no,
        at: new Date().toISOString(),
        status: 'new',                 // new(접수) · doing(진행) · done(완료) · cancel(취소)
        customer, items,
        total,
        totalBaht: items.reduce((a, x) => a + x.baht, 0),
        staff: { memo: '', by: '', at: '' },
      };
      await srUpsert(KEY, { data_key: PREFIX + rec.no, data: rec, updated_at: rec.at });
      /* 손님에게는 접수번호만 돌려준다 */
      return json({ ok: true, no: rec.no, at: rec.at });
    }

    /* ══ 여기부터는 직원만 ══ */
    const user = await getUser(request);
    if (!user) return json({ error: '로그인이 필요합니다.' }, 401);
    if (!await canSee(env, user)) return json({ error: '예약 요청은 어드민·매니저만 볼 수 있습니다.' }, 403);

    if (action === 'list') {
      const rows = await srSelect(KEY,
        'data_key=like.' + PREFIX + '*&select=data_key,data,updated_at&limit=1000');
      const list = (Array.isArray(rows) ? rows : [])
        .map(r => r && r.data)
        .filter(x => x && x.no)
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      return json({ ok: true, list });
    }

    if (action === 'status') {
      const no = s(body.no, 40);
      if (!no) return json({ error: '접수번호가 없습니다.' }, 400);
      const rows = await srSelect(KEY,
        'data_key=eq.' + encodeURIComponent(PREFIX + no) + '&select=data');
      const rec = Array.isArray(rows) && rows[0] && rows[0].data;
      if (!rec) return json({ error: '그 접수번호를 찾지 못했습니다.' }, 404);
      const st = s(body.status, 12);
      if (['new', 'doing', 'done', 'cancel'].includes(st)) rec.status = st;
      if (body.memo != null) rec.staff = { memo: s(body.memo, MAX_TEXT), by: loginIdOf(user), at: new Date().toISOString() };
      await srUpsert(KEY, { data_key: PREFIX + no, data: rec, updated_at: new Date().toISOString() });
      return json({ ok: true, rec });
    }

    return json({ error: '알 수 없는 요청입니다.' }, 404);
  } catch (e) {
    return json({ error: '서버 오류: ' + ((e && e.message) || e) }, 500);
  }
}
