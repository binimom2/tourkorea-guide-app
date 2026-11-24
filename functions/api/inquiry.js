/* ══════════════════════════════════════════════════════════════════
   💬 1:1 견적문의 (Cloudflare Pages Function) — 사장님 2026-11-24

   손님 사이트(tourkorea.biz)의 「1:1 견적문의」 창. 로그인한 «승인된 여행사»만 쓴다.
   글 + 첨부(사진·PDF·엑셀·워드·한글·텍스트).

   한 건 = guide_data 한 줄  golf_book_IQ<yymmdd>-<4자>-<여행사아이디>
     → 예약요청(golf-book.js)과 같은 모양이라 관리 화면 「📋 예약요청」에 「💬 견적문의」로 뜨고,
       직원 답장은 기존 1:1 메시지(golf-book msgReply: msgs[] from:'staff', agencyUnread+1)가 그대로 쓴다.
   첨부 = R2(FILES_BUCKET) inquiry/<아이디>/<시각>-<난수>.<확장자> — 공개 주소 없음.
     inqFile 로 «그 여행사 본인»과 «직원»만 받아 본다(브라우저가 토큰을 실어 받아서 화면에 띄운다).

   POST /api/inquiry  { action, ... }   (Authorization: Bearer <로그인 토큰>)
     inqNew  { text, title?, cty?, files:[{name,data(base64)}] } → 새 문의
     inqMsg  { no, text, files }                              → 같은 문의에 이어 쓰기
     inqList {}                                               → 내 문의 목록(직원 답장 포함)
     inqSeen { no }                                           → 직원 답장 읽음(agencyUnread 0)
     inqFile { k }                                            → 첨부 받기(파일 그대로)
   ══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://aplevsrmxkzghutihyvs.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FVavEEBxGZRRvU19F27koA_a4hJUiRl';
const ELEVATED = ['lds1207', 'sooyoung', 'admin'];
const BOOK = 'golf_book_';
const ROOT = 'inquiry/';
const FILE_MAX = 5 * 1024 * 1024, TOTAL_MAX = 10 * 1024 * 1024, FILES_MAX = 5;
const MAX_BODY = 15 * 1024 * 1024;   // base64 로 오므로 첨부 10MB ≒ 13.4MB
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  hwp: 'application/x-hwp', hwpx: 'application/haansofthwpx', txt: 'text/plain', csv: 'text/csv',
};

const json = (o, st = 200) => new Response(JSON.stringify(o), {
  status: st, headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' },
});
/* 한 줄 글자 정리 — 제어문자는 빈칸으로 */
const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
/* 여러 줄 본문 — 줄마다 300자, 40줄, 전체 3000자 */
const textOf = (v) => String(v == null ? '' : v).split(/\r?\n/).map((x) => s(x, 300)).slice(0, 40)
  .join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
const idOk = (id) => /^[a-z0-9][a-z0-9._-]{2,23}$/.test(id);

async function getUser(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: auth } });
      if (r.ok) { const u = await r.json(); return u && u.id ? u : null; }
      if (r.status < 500 && r.status !== 429) return null;
    } catch (e) { /* 한 번 더 */ }
  }
  return null;
}
function loginIdOf(u) {
  const m = (u && u.user_metadata) || {};
  return String(m.acc_id || m.login_name || ((u && u.email) || '').split('@')[0] || '').toLowerCase();
}
const isAgency = (u) => !!(u && u.user_metadata && u.user_metadata.kind === 'agency');
const approvedAgency = (u) => isAgency(u) && (u.user_metadata || {}).approved === true;
const srHeaders = (key, extra) => Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'content-type': 'application/json' }, extra || {});
async function srSelect(key, query) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/guide_data?' + query, { headers: srHeaders(key) });
  if (!r.ok) throw new Error('DB 읽기 실패 (HTTP ' + r.status + ')');
  return await r.json();
}
async function srUpsert(key, row) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/guide_data', {
    method: 'POST', headers: srHeaders(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error('DB 저장 실패 (HTTP ' + r.status + ')');
}
/* 직원 등급 — agency.js·golf-book.js 와 같은 판정. 여행사 계정은 절대 직원이 아니다 */
async function staffRole(env, user) {
  if (!user || isAgency(user)) return '';
  const m = user.user_metadata || {};
  const id = loginIdOf(user);
  if (m.role === 'admin' || ELEVATED.includes(id)) return 'admin';
  try {
    const rows = await srSelect(env.SUPABASE_SERVICE_ROLE_KEY, 'data_key=eq.golf_roles&select=data');
    const roles = (Array.isArray(rows) && rows[0] && rows[0].data) || {};
    const r = roles[id] === 'agent' ? 'manager2' : roles[id];
    return ['admin', 'manager', 'manager2'].includes(r) ? r : '';
  } catch (e) { return ''; }
}
function b64bytes(str) {
  const raw = String(str || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/* 첨부 저장 — [{name, data}] → [{k, name, type, size}]. 안 되는 파일은 이유를 던진다(하나라도 안 되면 하나도 안 올린다) */
async function putFiles(bucket, aid, files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return [];
  if (list.length > FILES_MAX) throw new Error('첨부는 한 번에 ' + FILES_MAX + '개까지입니다.');
  if (!bucket) throw new Error('첨부 저장소(R2)가 연결되지 않았습니다.');
  const ready = []; let total = 0;
  for (const f of list) {
    const name = s(f && f.name, 120) || 'file';
    const ext = ((name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '').toLowerCase();
    const type = TYPES[ext];
    if (!type) throw new Error('「' + name + '」 — 사진·PDF·엑셀·워드·한글·텍스트 파일만 올릴 수 있습니다.');
    let bytes;
    try { bytes = b64bytes(f.data); } catch (e) { throw new Error('「' + name + '」 파일을 읽지 못했습니다.'); }
    if (!bytes.length) throw new Error('「' + name + '」 파일이 비어 있습니다.');
    if (bytes.length > FILE_MAX) throw new Error('「' + name + '」 — 파일 하나는 5MB까지입니다.');
    total += bytes.length;
    if (total > TOTAL_MAX) throw new Error('첨부는 한 번에 합쳐서 10MB까지입니다.');
    ready.push({ name, ext, type, bytes });
  }
  const out = [];
  for (const f of ready) {
    const k = ROOT + aid + '/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + f.ext;
    await bucket.put(k, f.bytes, { httpMetadata: { contentType: f.type }, customMetadata: { agency: aid, name: encodeURIComponent(f.name) } });
    out.push({ k, name: f.name, type: f.type, size: f.bytes.length });
  }
  return out;
}
async function readBook(KEY, no) {
  const rows = await srSelect(KEY, 'data_key=eq.' + encodeURIComponent(BOOK + no) + '&select=data');
  return (Array.isArray(rows) && rows[0] && rows[0].data) || null;
}

export async function onRequestPost({ request, env }) {
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) return json({ error: '서버에 SUPABASE_SERVICE_ROLE_KEY가 등록되어 있지 않습니다.' }, 500);
  if (+(request.headers.get('content-length') || 0) > MAX_BODY) return json({ error: '첨부가 너무 큽니다(합쳐서 10MB까지).' }, 413);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: '잘못된 요청 형식입니다.' }, 400); }
  const action = String(body.action || '');
  const user = await getUser(request);
  if (!user) return json({ error: '로그인이 필요합니다.' }, 401);
  const now = new Date().toISOString();
  const aid = loginIdOf(user);

  try {
    /* ── 새 문의 / 이어 쓰기 ── */
    if (action === 'inqNew' || action === 'inqMsg') {
      if (!approvedAgency(user)) return json({ error: '승인된 여행사 회원만 쓸 수 있습니다.' }, 403);
      if (!idOk(aid)) return json({ error: '아이디를 확인할 수 없습니다.' }, 400);
      const text = textOf(body.text);
      const nFiles = Array.isArray(body.files) ? body.files.length : 0;
      if (!text && !nFiles) return json({ error: '문의 내용을 적거나 파일을 첨부해 주세요.' }, 400);
      let rec = null, no = '';
      if (action === 'inqMsg') {
        no = s(body.no, 60);
        if (!/^IQ[\w-]+$/.test(no)) return json({ error: '번호가 없습니다.' }, 400);
        rec = await readBook(KEY, no);
        if (!rec || !rec.from || rec.from.id !== aid) return json({ error: '문의를 찾지 못했습니다.' }, 404);
        if (rec.status === 'cancel') return json({ error: '종료된 문의입니다. 새 문의로 보내 주세요.' }, 409);
      }
      let files;
      try { files = await putFiles(env.FILES_BUCKET, aid, body.files); }
      catch (e) { return json({ error: (e && e.message) || '첨부를 저장하지 못했습니다.' }, 400); }
      const msg = { at: now, by: aid, text };
      if (files.length) msg.files = files;
      if (action === 'inqNew') {
        const d = new Date(Date.now() + 7 * 3600e3).toISOString();   // 방콕 날짜
        no = 'IQ' + d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + aid;
        const m = user.user_metadata || {};
        rec = {
          no, at: now, status: 'new', kind: 'inquiry', cty: s(body.cty, 20),
          title: s(body.title, 80) || s((text.split('\n')[0] || '견적문의'), 60) || '견적문의',
          from: { id: aid, company: s(m.company, 60) },
          customer: { name: s(m.contact || m.name, 30), tel: s(m.tel, 40), email: s(m.email, 80) },
          items: [], total: 0, msgs: [], msgUnread: 0, agencyUnread: 0,
        };
      }
      rec.msgs = (Array.isArray(rec.msgs) ? rec.msgs : []).concat([msg]).slice(-80);
      rec.msgUnread = Math.max(0, Math.round(+rec.msgUnread || 0)) + 1;
      /* 끝난 문의에 다시 쓰면 다시 처리할 것으로 */
      if (rec.status === 'done') rec.status = 'progress';
      await srUpsert(KEY, { data_key: BOOK + no, data: rec, updated_at: now });
      return json({ ok: true, no, msg });
    }

    /* ── 내 문의 목록 ── */
    if (action === 'inqList') {
      if (!approvedAgency(user)) return json({ error: '승인된 여행사 회원만 쓸 수 있습니다.' }, 403);
      if (!idOk(aid)) return json({ error: '아이디를 확인할 수 없습니다.' }, 400);
      const rows = await srSelect(KEY, 'data_key=like.' + encodeURIComponent(BOOK + 'IQ*-' + aid) + '&select=data&limit=300');
      const list = (Array.isArray(rows) ? rows : []).map((r) => r && r.data)
        .filter((r) => r && r.from && r.from.id === aid)
        .map((r) => ({
          no: r.no, at: r.at, title: r.title || '', status: r.status, agencyUnread: +r.agencyUnread || 0,
          msgs: (r.msgs || []).map((x) => ({ at: x.at, text: x.text || '', staff: x.from === 'staff', files: x.files || [] })),
        }))
        .sort((a, b) => String((b.msgs[b.msgs.length - 1] || b).at).localeCompare(String((a.msgs[a.msgs.length - 1] || a).at)));
      return json({ ok: true, list });
    }

    /* ── 직원 답장 읽음 ── */
    if (action === 'inqSeen') {
      if (!approvedAgency(user)) return json({ error: '승인된 여행사 회원만 쓸 수 있습니다.' }, 403);
      const no = s(body.no, 60);
      if (!/^IQ[\w-]+$/.test(no)) return json({ error: '번호가 없습니다.' }, 400);
      const rec = await readBook(KEY, no);
      if (!rec || !rec.from || rec.from.id !== aid) return json({ error: '문의를 찾지 못했습니다.' }, 404);
      if (+rec.agencyUnread) { rec.agencyUnread = 0; await srUpsert(KEY, { data_key: BOOK + no, data: rec, updated_at: now }); }
      return json({ ok: true });
    }

    /* ── 첨부 받기 — 그 여행사 본인 또는 직원만 ── */
    if (action === 'inqFile') {
      const k = String(body.k || '');
      if (!/^inquiry\/[a-z0-9._-]+\/[a-z0-9-]+\.[a-z0-9]{2,5}$/.test(k)) return json({ error: '파일이 없습니다.' }, 400);
      const own = approvedAgency(user) && k.startsWith(ROOT + aid + '/');
      if (!own && !(await staffRole(env, user))) return json({ error: '이 파일을 볼 권한이 없습니다.' }, 403);
      const obj = env.FILES_BUCKET && await env.FILES_BUCKET.get(k);
      if (!obj) return json({ error: '파일을 찾지 못했습니다.' }, 404);
      let name = 'file';
      try { name = decodeURIComponent((obj.customMetadata || {}).name || 'file'); } catch (e) {}
      const type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
      return new Response(obj.body, {
        headers: {
          'content-type': type, 'cache-control': 'private, no-store',
          'content-disposition': (/^image\/|^application\/pdf$|^text\//.test(type) ? 'inline' : 'attachment')
            + "; filename*=UTF-8''" + encodeURIComponent(name),
        },
      });
    }

    return json({ error: '알 수 없는 요청입니다.' }, 400);
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 500);
  }
}
