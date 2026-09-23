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
     confirm  〃  직원이 컨펌 → 바우처(예약 확정서)가 자동으로 만들어진다 (2026-09-10 사장님)
     send     〃  그 바우처를 손님 이메일로 보낸다 (Resend — 서버 환경 변수 RESEND_API_KEY 필요)
     voucher  손님(로그인 없음) — 접수번호 + 바우처 토큰이 맞아야 한 건만 읽어 준다.
              카톡·이메일로 받은 링크(/golf/site/voucher/?no=…&t=…)가 이 요청을 보낸다.
   service_role 키는 이 서버에서만 쓰고 브라우저로 내려가지 않는다.

   ── 바우처(예약 확정서)
     rec.voucher = { cno, token, at, by, memo, sent:[…] }
       cno    확정번호(Confirm No.) — 컨펌한 순간의 초 단위 시각(10자리). 손님이 호텔에 댈 번호.
       token  바우처 링크에 붙는 열쇠. 접수번호만 알아서는 남의 바우처를 못 연다.
       memo   바우처에 실리는 「Agent Memo」(호텔 컨펌번호 등). 직원 메모(staff.memo)와는 다르다.
     회사 정보·업체 주소/전화는 저장해 두지 않고 읽을 때마다 golf_site 에서 붙인다 —
     관리 화면에서 고치면 이미 발급한 바우처에도 바로 반영된다.

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
    /* 어드민·매니저1·매니저2 모두 예약요청을 다룬다(옛 'agent'는 매니저2) — 사장님 2026-09-16 */
    return ['admin', 'manager', 'manager2', 'agent'].includes(roles[id]);
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
async function srDelete(key, dataKey) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/guide_data?data_key=eq.' + encodeURIComponent(dataKey), {
    method: 'DELETE', headers: srHeaders(key, { Prefer: 'return=minimal' }),
  });
  if (!r.ok) throw new Error('DB 삭제 실패 (HTTP ' + r.status + ')');
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

/* ── 바우처 토큰 — 링크에 붙는 열쇠. 접수번호와 같은 글자판으로 12자 ── */
function voucherToken() {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let t = '';
  for (const b of buf) t += CODE_CHARS[b % CODE_CHARS.length];
  return t;
}

/* ── 바우처에 실을 회사 정보·업체(골프장/호텔) 주소·전화 — golf_site 에서 읽는다 ──
   관리 화면 「연락처 · 푸터 → 바우처 발행 정보」에서 적는다. 비어 있으면 기본 문구. */
const VOUCHER_DEFAULT = {
  name: '투어코리아 (TOURKOREA)', en: 'We\'ve Tour Thailand', regNo: '', tel: '', tel2: '', email: '',
  issuer: '', emergency: '',
  bank: '', invoiceNote: '',   // 인보이스(여행사 건) — 입금 계좌 · 안내 문구(사장님 2026-09-21)
  notes: '',
  terms: [
    '호텔 체크인 시 프론트 데스크에 여권과 함께 예약확정서(바우처)를 제시해 주세요.',
    '이 바우처는 휴대폰으로 찍은 화면(캡처)으로도 제시하실 수 있습니다.',
    '객실 요금은 모두 지불되었으며 호텔의 디파짓 결제 요구는 부대시설 이용에 대한 보증금 목적입니다.',
    '침대 타입(더블 또는 트윈)·고층·커넥팅 룸 등의 요청은 보장되지 않는 요청사항입니다. 객실 배정은 호텔의 고유 권한으로 체크인 시점의 호텔 상황에 따라 제공됩니다.',
    '바우처에 표기된 인원 외에 추가 인원으로는 체크인이 불가능할 수 있습니다.',
    '체크인 날짜에 도착하지 못할 경우 예약은 취소되며 호텔 규정에 따라 위약금이 부과됩니다.',
    '예약에 문제가 있거나 급한 도움이 필요할 땐 아래 비상전화로 연락 주세요.',
  ].join('\n'),
};
async function readSite(key) {
  try {
    const rows = await srSelect(key, 'data_key=eq.golf_site&select=data');
    return (Array.isArray(rows) && rows[0] && rows[0].data) || {};
  } catch (e) { return {}; }
}
function siteItems(site, kind) {
  if (kind === 'courses') return Array.isArray(site.courses) ? site.courses : [];
  if (kind === 'hotels')  return Array.isArray(site.hotels)  ? site.hotels  : [];
  const it = site.items && site.items[kind];
  return Array.isArray(it) ? it : [];
}
/* 담긴 줄마다 업체 정보(영문 이름·주소·전화·침대·조식)를 붙인다 */
function venueOf(site, it) {
  const x = siteItems(site, it.kind).find(v => v && v.n === it.name) || {};
  const out = { en: s(x.e, 120), addr: s(x.addr, 200), tel: s(x.tel, 60) };
  if (it.kind === 'hotels' && Array.isArray(x.rooms)) {
    const r = x.rooms.find(r => r && r.t === it.option);
    if (r) { out.bed = s(r.bed, 80); out.bf = !!r.bf; }
  }
  return out;
}
function companyOf(site) {
  const v = Object.assign({}, VOUCHER_DEFAULT, (site && site.voucher) || {});
  const o = {};
  for (const k of Object.keys(VOUCHER_DEFAULT)) o[k] = s(v[k], k === 'notes' || k === 'terms' || k === 'invoiceNote' ? 4000 : k === 'bank' ? 600 : 200);
  return o;
}
/* ── 인보이스(사장님 2026-09-21) — 실시간 견적으로 들어온 여행사 수배 건(rec.agency)은 컨펌하면 바우처 대신 인보이스가 나간다.
   rec.items 는 원가 줄(핸들링 차지·항목별 원가)이라 여행사에게 보이면 안 된다 → 인보이스에는 견적 내용(rec.quote)과 총액만 싣는다.
   rec.quote 는 /api/agency quoteBook 이 담아 둔다. 그 전에 들어온 건은 여행사 보관함(golf_aquotes_<아이디>)에서 찾아 쓴다 ── */
const isAgencyRec = (rec) => !!(rec && rec.agency && rec.agency.quoteNo);
async function quoteOfRec(key, rec) {
  if (rec.quote && typeof rec.quote === 'object') return rec.quote;
  let Q = null;
  try {
    const rows = await srSelect(key, 'data_key=eq.' + encodeURIComponent('golf_aquotes_' + rec.agency.id) + '&select=data');
    const list = (Array.isArray(rows) && rows[0] && Array.isArray(rows[0].data)) ? rows[0].data : [];
    Q = list.find(x => x && x.quoteNo === rec.agency.quoteNo) || null;
  } catch (e) {}
  const pax = Q ? num(Q.pax) : num(((rec.items || [])[0] || {}).pax);
  const fx = Q ? (+Q.fx || 0) : 0;
  const perKrw = (Q && fx > 0) ? Math.ceil((+Q.per || 0) * fx / 1000) * 1000 : 0;
  return {
    quoteNo: rec.agency.quoteNo, team: s(Q && Q.team, 60), start: s(Q && Q.start, 10), end: s(Q && Q.end, 10), pax,
    nights: num(Q && Q.nights), tripDays: num(Q && Q.tripDays), route: s(Q && Q.route, 120), flight: s(Q && Q.flight, 80),
    days: ((Q && Array.isArray(Q.days)) ? Q.days : []).slice(0, 40).map(d => ({
      date: s(d.date, 10), region: s(d.region, 40), hotel: s(d.hotel, 120), course: s(d.course, 120), holes: s(d.holes, 4), round: !!d.round })),
    includes: ((Q && Q.includes && Array.isArray(Q.includes.customer)) ? Q.includes.customer : []).slice(0, 30).map(x => s(x, 300)).filter(Boolean),
    noHotel: !!(Q && Q.noHotel), noGuide: !!(Q && Q.noGuide), noVeh: !!(Q && Q.noVeh),
    perKrw, totalKrw: perKrw ? perKrw * pax : num(rec.total),
    requests: (Q && Q.book && Q.book.memo) ? String(Q.book.memo).split('\n').map(x => s(x, 500)).filter(Boolean).slice(0, 80) : [],
    notes: (Q && Q.book && Q.book.notes && typeof Q.book.notes === 'object') ? Q.book.notes : {},
  };
}
/* ── 인보이스 고쳐 쓰기(사장님 2026-09-23) — 발행 전에 어드민이 칸을 고친다. rec.voucher.inv 에 고친 값만 담고,
   화면을 만들 때 견적 내용 위에 덮어쓴다. 계좌·디파짓(1인·기한)·잔금(1인·기한)도 여기 ── */
function cleanInv(x) {
  if (!x || typeof x !== 'object') return null;
  const lines = (v, n) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(t => s(t, 300)).filter(Boolean).slice(0, n);
  const amt = (v) => (v === '' || v == null) ? '' : Math.max(0, Math.round(+v || 0));
  const day = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '';
  const q = x.q || {};
  return {
    to: { company: s(x.to && x.to.company, 80), contact: s(x.to && x.to.contact, 60) },
    q: {
      team: s(q.team, 60), start: day(q.start), end: day(q.end), pax: amt(q.pax),
      perKrw: amt(q.perKrw), totalKrw: amt(q.totalKrw),
      includes: lines(q.includes, 30), requests: lines(q.requests, 80),
      days: (Array.isArray(q.days) ? q.days : []).slice(0, 40).map(d => ({
        date: day(d && d.date), region: s(d && d.region, 40), hotel: s(d && d.hotel, 120), course: s(d && d.course, 120), holes: s(d && d.holes, 4), round: !!(d && d.course) })),
    },
    bank: s(x.bank, 600),
    dep: { per: amt(x.dep && x.dep.per), due: day(x.dep && x.dep.due) },
    bal: { per: amt(x.bal && x.bal.per), due: day(x.bal && x.bal.due) },
  };
}
async function invoiceView(request, rec, site, key) {
  const inv = rec.voucher.inv || null;
  const quote = Object.assign({}, await quoteOfRec(key, rec));
  const company = companyOf(site);
  const to = { company: s(rec.agency.company, 60) || s((rec.customer && rec.customer.name) || '', 80), contact: s(rec.agency.contact, 30) };
  let pay = null;
  if (inv) {
    const q = inv.q || {};
    ['team', 'start', 'end'].forEach(k => { if (q[k]) quote[k] = q[k]; });
    ['pax', 'perKrw', 'totalKrw'].forEach(k => { if (q[k] !== '' && q[k] != null) quote[k] = q[k]; });
    ['includes', 'requests', 'days'].forEach(k => { if (Array.isArray(q[k]) && q[k].length) quote[k] = q[k]; });
    if (inv.to && inv.to.company) to.company = inv.to.company;
    if (inv.to && inv.to.contact) to.contact = inv.to.contact;
    if (inv.bank) company.bank = inv.bank;
    const pax = +quote.pax || 0;
    const part = (p) => (p && p.per !== '' && p.per != null) ? { per: p.per, due: p.due || '', total: p.per * pax } : null;
    const dep = part(inv.dep), bal = part(inv.bal);
    if (dep || bal) pay = { dep, bal };
  }
  return {
    type: 'invoice',
    no: rec.no, at: rec.at, status: rec.status,
    cno: rec.voucher.cno, confirmedAt: rec.voucher.at, memo: rec.voucher.memo || '',
    to,
    guest: (rec.customer && rec.customer.name) || '',
    quote, pay,
    items: [],                                   // 원가 줄은 싣지 않는다
    company,
    url: voucherUrl(request, rec),
  };
}
/* 바우처 링크 — 손님 사이트가 나중에 딴 도메인으로 가면 골프 사이트 쪽 주소로 바꾼다 */
function voucherUrl(request, rec) {
  const origin = new URL(request.url).origin;
  return origin + '/golf/site/voucher/?no=' + encodeURIComponent(rec.no) + '&t=' + encodeURIComponent(rec.voucher.token);
}
/* 손님에게 보여 줄 만큼만 — 연락처·직원 메모는 빼고 */
function voucherView(request, rec, site) {
  return {
    no: rec.no, at: rec.at, status: rec.status,
    cno: rec.voucher.cno, confirmedAt: rec.voucher.at, memo: rec.voucher.memo || '',
    guest: (rec.customer && rec.customer.name) || '',
    items: (rec.items || []).map(it => Object.assign({}, it, { venue: venueOf(site, it) })),
    company: companyOf(site),
    url: voucherUrl(request, rec),
  };
}

/* ── 이메일 — Resend (https://resend.com). 서버 환경 변수:
     RESEND_API_KEY   필수. 없으면 「설정 필요」로 돌려주고 관리 화면이 메일 앱으로 대신 연다.
     VOUCHER_FROM     보내는 주소. Resend에 도메인을 등록해야 그 주소로 나간다.
                      예) 투어코리아 <voucher@tourkorea.biz>   (없으면 onboarding@resend.dev — 시험용) ── */
function mailHtml(v) {
  const e = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = v.items.map(it => {
    const d = it.date + (it.dateEnd && it.dateEnd !== it.date ? ' ~ ' + it.dateEnd : '');
    return '<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e5e5"><b>' + e(it.name) + '</b>'
      + (it.option ? ' · ' + e(it.option) : '') + '<br><span style="color:#666;font-size:13px">' + e(d)
      + (it.label ? ' · ' + e(it.label) : '') + '</span></td></tr>';
  }).join('');
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Apple SD Gothic Neo,Malgun Gothic,sans-serif;max-width:560px;margin:0 auto;color:#222">'
    + '<h2 style="margin:18px 0 4px">' + e(v.company.name) + ' 예약 확정서 (Voucher)</h2>'
    + '<p style="margin:0 0 14px;color:#555">' + e(v.guest) + ' 님, 예약이 확정되었습니다. 아래 단추를 눌러 바우처를 여시고, 이용 시 제시해 주세요.</p>'
    + '<table style="border-collapse:collapse;width:100%;margin-bottom:12px"><tr><td style="padding:6px 8px;background:#f3f3f3">예약번호 (Booking No.)</td><td style="padding:6px 8px;background:#f3f3f3"><b>' + e(v.no) + '</b></td></tr>'
    + '<tr><td style="padding:6px 8px">확정번호 (Confirm No.)</td><td style="padding:6px 8px"><b>' + e(v.cno) + '</b></td></tr></table>'
    + '<table style="border-collapse:collapse;width:100%;margin-bottom:18px">' + rows + '</table>'
    + '<p style="margin:0 0 22px"><a href="' + e(v.url) + '" style="display:inline-block;background:#123A2B;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">바우처 열기 / Open Voucher</a></p>'
    + '<p style="font-size:12px;color:#777;line-height:1.6">링크: ' + e(v.url) + '<br>'
    + e(v.company.name) + (v.company.tel ? ' · ' + e(v.company.tel) : '') + (v.company.email ? ' · ' + e(v.company.email) : '') + '</p></div>';
}
/* 인보이스 메일 — 원가 줄 없이 일정·총액만 */
function invoiceMailHtml(v) {
  const e = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const q = v.quote || {};
  const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
  const row = (k, val, bg) => '<tr><td style="padding:6px 8px;' + (bg ? 'background:#f3f3f3;' : '') + 'white-space:nowrap">' + k + '</td><td style="padding:6px 8px;' + (bg ? 'background:#f3f3f3' : '') + '"><b>' + e(val) + '</b></td></tr>';
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Apple SD Gothic Neo,Malgun Gothic,sans-serif;max-width:560px;margin:0 auto;color:#222">'
    + '<h2 style="margin:18px 0 4px">' + e(v.company.name) + ' 인보이스 (Invoice)</h2>'
    + '<p style="margin:0 0 14px;color:#555">' + e(v.to.company) + ' 담당자님, 요청하신 수배가 확정되었습니다. 아래 단추를 눌러 인보이스를 확인해 주세요.</p>'
    + '<table style="border-collapse:collapse;width:100%;margin-bottom:18px">'
    + row('Invoice No.', v.cno, true) + row('견적번호', q.quoteNo || '')
    + row('팀명', q.team || '-', true) + row('일정', (q.start || '') + ' ~ ' + (q.end || '') + ' · ' + (q.pax || 0) + '명')
    + row('총액 (Total)', q.totalKrw ? won(q.totalKrw) : '-', true)
    + (v.pay && v.pay.dep ? row('디파짓', won(v.pay.dep.total) + (v.pay.dep.due ? ' · ' + v.pay.dep.due + '까지' : '')) : '')
    + (v.pay && v.pay.bal ? row('잔금', won(v.pay.bal.total) + (v.pay.bal.due ? ' · ' + v.pay.bal.due + '까지' : ''), true) : '')
    + '</table>'
    + '<p style="margin:0 0 22px"><a href="' + e(v.url) + '" style="display:inline-block;background:#123A2B;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">인보이스 열기 / Open Invoice</a></p>'
    + '<p style="font-size:12px;color:#777;line-height:1.6">링크: ' + e(v.url) + '<br>'
    + e(v.company.name) + (v.company.tel ? ' · ' + e(v.company.tel) : '') + (v.company.email ? ' · ' + e(v.company.email) : '') + '</p></div>';
}
async function sendMail(env, to, subject, html) {
  const key = env.RESEND_API_KEY;
  if (!key) return { setup: true };
  const from = env.VOUCHER_FROM || 'onboarding@resend.dev';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: '메일 발송 실패 (HTTP ' + r.status + ') ' + ((j && (j.message || j.error)) || '') };
  return { ok: true, id: j && j.id };
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
    time:    s(x.time, 80),          // 희망 시간·티타임·차량 미팅장소 — 손님이 자유롭게 적은 요청사항(2026-09-09, 차량은 장소까지 09-10)
    riders:  num(x.riders),          // 차량 탑승 인원수(2026-09-11) — pax 는 차량 «대수»라 따로 둔다
    nights:  num(x.nights),
    rooms:   num(x.rooms),
    pax:     num(x.pax),
    adult:   num(x.adult),
    child:   num(x.child),
    ages:    Array.isArray(x.ages) ? x.ages.slice(0, 10).map(num) : [],
    /* 아동 생년월일(여덟 자리, 2026-09-19) — 아동 요금은 만 11세까지라 호텔에 생년월일로 확인해 줘야 한다 */
    births:  Array.isArray(x.births) ? x.births.slice(0, 10).map((b) => s(b, 8)).filter((b) => /^\d{8}$/.test(b)) : [],
    noBed:   !!x.noBed,              // 아동 엑스트라 베드 «추가 안 함»(조식만, 2026-09-19) — 성인 3인째는 해당 없음
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

    /* ══ 손님이 바우처를 연다 — 접수번호 + 토큰이 둘 다 맞아야 한다 ══ */
    if (action === 'voucher') {
      const no = s(body.no, 40), token = s(body.t, 40);
      if (!no || !token) return json({ error: '바우처 주소가 올바르지 않습니다.' }, 400);
      const rows = await srSelect(KEY, 'data_key=eq.' + encodeURIComponent(PREFIX + no) + '&select=data');
      const rec = Array.isArray(rows) && rows[0] && rows[0].data;
      if (!rec || !rec.voucher || rec.voucher.token !== token)
        return json({ error: '바우처를 찾지 못했습니다. 주소를 다시 확인해 주세요.' }, 404);
      if (rec.status === 'cancel') return json({ error: '취소된 예약입니다. 문의는 아래 연락처로 주세요.', cancelled: true }, 410);
      const site = await readSite(KEY);
      return json({ ok: true, v: isAgencyRec(rec) ? await invoiceView(request, rec, site, KEY) : voucherView(request, rec, site) });
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
      /* 여행사 수배 건 중 견적 내용(quote)이 안 담긴 옛 건 — 보관함에서 찾아 붙여 준다(관리 화면 「📄 수배요청서」용, 저장은 안 한다) */
      for (const rec of list) {
        if (isAgencyRec(rec) && !rec.quote) { try { rec.quote = await quoteOfRec(KEY, rec); } catch (e) {} }
      }
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
      if (['new', 'confirmed', 'doing', 'paid', 'done', 'cancel'].includes(st)) rec.status = st;   // paid = 입금완료(사장님 2026-09-21, 여행사 보관함에도 이 상태가 보인다)
      if (body.msgRead === true) rec.msgUnread = 0;                // 여행사 「추가 요청 메시지」를 직원이 확인함
      if (body.memo != null) rec.staff = { memo: s(body.memo, MAX_TEXT), by: loginIdOf(user), at: new Date().toISOString() };
      await srUpsert(KEY, { data_key: PREFIX + no, data: rec, updated_at: new Date().toISOString() });
      return json({ ok: true, rec });
    }

    /* ══ 컨펌 → 바우처 발급. 이미 발급된 건이면 번호·링크는 그대로 두고 메모만 고친다
          (손님에게 이미 보낸 링크가 죽으면 안 된다) ══ */
    if (action === 'confirm') {
      const no = s(body.no, 40);
      if (!no) return json({ error: '접수번호가 없습니다.' }, 400);
      const rows = await srSelect(KEY, 'data_key=eq.' + encodeURIComponent(PREFIX + no) + '&select=data');
      const rec = Array.isArray(rows) && rows[0] && rows[0].data;
      if (!rec) return json({ error: '그 접수번호를 찾지 못했습니다.' }, 404);
      const now = new Date().toISOString();
      /* 여행사 건 인보이스는 «초안»으로 만든다(사장님 2026-09-23) — 어드민이 화면으로 확인하고 「발행」(release)을 눌러야
         여행사 보관함에 링크가 뜨고 상태가 컨펌이 된다. released 가 없는 옛 건은 이미 발행된 것으로 본다. */
      const draft = isAgencyRec(rec);
      if (!rec.voucher || !rec.voucher.token) {
        rec.voucher = { cno: String(Math.floor(Date.now() / 1000)), token: voucherToken(), at: now, by: loginIdOf(user), memo: '', sent: [] };
        if (draft) rec.voucher.released = false;
      }
      if (body.memo != null) rec.voucher.memo = s(body.memo, MAX_TEXT);
      if ((rec.status === 'new' || rec.status === 'doing') && rec.voucher.released !== false) rec.status = 'confirmed';
      await srUpsert(KEY, { data_key: PREFIX + no, data: rec, updated_at: now });
      return json({ ok: true, rec, url: voucherUrl(request, rec) });
    }

    /* ══ 예약요청 삭제 — 테스트 기간용(사장님 2026-09-23: 나중에 막는다). 지우기 전 golf_booktrash_<번호> 로 옮겨 둔다
          (목록은 golf_book_* 만 읽으므로 여기 옮긴 것은 안 보인다 — 되살릴 때 키만 바꿔 넣으면 된다) ══ */
    if (action === 'delete') {
      const no = s(body.no, 40);
      if (!no) return json({ error: '접수번호가 없습니다.' }, 400);
      const rows = await srSelect(KEY, 'data_key=eq.' + encodeURIComponent(PREFIX + no) + '&select=data');
      const rec = Array.isArray(rows) && rows[0] && rows[0].data;
      if (!rec) return json({ error: '그 접수번호를 찾지 못했습니다.' }, 404);
      const now = new Date().toISOString();
      await srUpsert(KEY, { data_key: 'golf_booktrash_' + no, data: Object.assign({}, rec, { deletedAt: now, deletedBy: loginIdOf(user) }), updated_at: now });
      await srDelete(KEY, PREFIX + no);
      return json({ ok: true, no });
    }

    /* ══ 인보이스 고쳐 쓰기 — 칸마다 고친 값(inv)과 메모를 담는다. 링크·번호는 그대로 ══ */
    if (action === 'invEdit') {
      const no = s(body.no, 40);
      const rows = await srSelect(KEY, 'data_key=eq.' + encodeURIComponent(PREFIX + no) + '&select=data');
      const rec = Array.isArray(rows) && rows[0] && rows[0].data;
      if (!rec) return json({ error: '그 접수번호를 찾지 못했습니다.' }, 404);
      if (!rec.voucher || !rec.voucher.token) return json({ error: '먼저 컨펌해서 인보이스를 만들어 주세요.' }, 400);
      rec.voucher.inv = cleanInv(body.inv);
      if (body.memo != null) rec.voucher.memo = s(body.memo, MAX_TEXT);
      rec.voucher.editBy = loginIdOf(user); rec.voucher.editAt = new Date().toISOString();
      await srUpsert(KEY, { data_key: PREFIX + no, data: rec, updated_at: rec.voucher.editAt });
      return json({ ok: true, rec });
    }

    /* ══ 인보이스 발행 — 어드민이 초안을 화면으로 확인한 뒤 누른다 ══ */
    if (action === 'release') {
      const no = s(body.no, 40);
      const rows = await srSelect(KEY, 'data_key=eq.' + encodeURIComponent(PREFIX + no) + '&select=data');
      const rec = Array.isArray(rows) && rows[0] && rows[0].data;
      if (!rec) return json({ error: '그 접수번호를 찾지 못했습니다.' }, 404);
      if (!rec.voucher || !rec.voucher.token) return json({ error: '먼저 컨펌해서 인보이스를 만들어 주세요.' }, 400);
      const now = new Date().toISOString();
      rec.voucher.released = now; rec.voucher.relBy = loginIdOf(user);
      if (rec.status === 'new' || rec.status === 'doing') rec.status = 'confirmed';
      await srUpsert(KEY, { data_key: PREFIX + no, data: rec, updated_at: now });
      return json({ ok: true, rec, url: voucherUrl(request, rec) });
    }

    /* ══ 바우처를 손님 이메일로 보낸다 ══ */
    if (action === 'send') {
      const no = s(body.no, 40);
      const rows = await srSelect(KEY, 'data_key=eq.' + encodeURIComponent(PREFIX + no) + '&select=data');
      const rec = Array.isArray(rows) && rows[0] && rows[0].data;
      if (!rec) return json({ error: '그 접수번호를 찾지 못했습니다.' }, 404);
      if (!rec.voucher || !rec.voucher.token) return json({ error: '먼저 컨펌해서 바우처를 발급해 주세요.' }, 400);
      if (rec.voucher.released === false) return json({ error: '인보이스를 먼저 확인하고 「발행」을 눌러 주세요.' }, 400);
      const to = s(body.to, 120) || (rec.customer && rec.customer.email) || '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: '보낼 이메일 주소가 없습니다.' }, 400);
      const site = await readSite(KEY);
      const inv = isAgencyRec(rec);                 // 여행사 수배 건은 인보이스로 나간다(사장님 2026-09-21)
      const v = inv ? await invoiceView(request, rec, site, KEY) : voucherView(request, rec, site);
      const r = inv
        ? await sendMail(env, to, '[' + v.company.name + '] 인보이스 (Invoice) · ' + (v.quote.quoteNo || v.no), invoiceMailHtml(v))
        : await sendMail(env, to, '[' + v.company.name + '] 예약 확정서 (Voucher) · ' + v.no, mailHtml(v));
      if (r.setup) return json({ ok: false, setup: true, url: v.url, error: '서버에 RESEND_API_KEY 가 없어 자동 발송을 못 합니다.' });
      if (r.error) return json({ error: r.error }, 502);
      rec.voucher.sent = (rec.voucher.sent || []).concat([{ via: 'email', to, at: new Date().toISOString(), by: loginIdOf(user) }]).slice(-20);
      await srUpsert(KEY, { data_key: PREFIX + no, data: rec, updated_at: new Date().toISOString() });
      return json({ ok: true, rec, to });
    }

    return json({ error: '알 수 없는 요청입니다.' }, 404);
  } catch (e) {
    return json({ error: '서버 오류: ' + ((e && e.message) || e) }, 500);
  }
}
