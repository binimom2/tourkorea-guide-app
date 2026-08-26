/* ══════════════════════════════════════════════════════════════════
   손님 사이트용 골프장 요금 (Cloudflare Pages Function)

   GET  /api/golf-price
     → 골프장 목록 + «최저가»(1인 18홀 / 9홀, 원). 카드에 「96,100원~」으로 붙는다.
   POST /api/golf-price   { region, course, holes:'18'|'9'|'27'|'36', date, pax }
     → 그 날짜·인원의 정확한 1인가·합계(원). 상세페이지 오른쪽 견적 패널이 쓴다.

   ⚠ 요금표(golf_pricing)는 이 서버에서만 읽는다. 손님 브라우저로는 «원화 결과»만 내려간다.
      밧 금액·그린피/캐디/카트 내역·마진은 응답에 넣지 않는다.
      (마진이 100밧이라 항목별로 내려보내면 원가가 그대로 드러난다.)

   한화 = 네이버 금융(하나은행 고시) «현찰 살때» × 밧 금액, 천원 단위 올림.
   계산 규칙은 직원용 견적기(/golf/ 의 calc())와 같아야 한다 — 어긋나면 손님이 사이트에서 본
   금액과 직원이 뽑아 준 견적서가 달라진다.
   ══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://aplevsrmxkzghutihyvs.supabase.co';
const NAVER = 'https://api.stock.naver.com/marketindex/exchange/';

const json = (o, s = 200, cache = 'no-store') =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'content-type': 'application/json;charset=utf-8',
      'cache-control': cache,
      'access-control-allow-origin': '*',
    },
  });

async function readPricing(env) {
  const sr = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sr) throw new Error('서버에 SUPABASE_SERVICE_ROLE_KEY가 등록되어 있지 않습니다');
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/guide_data?data_key=eq.golf_pricing&select=data',
    { headers: { apikey: sr, Authorization: 'Bearer ' + sr } }
  );
  if (!r.ok) throw new Error('요금표 읽기 실패 (' + r.status + ')');
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0] && rows[0].data) || null;
}

/* 현찰 살때 — 손님에게 나가는 한화 기준(사장님 지정) */
async function cashBuyRate() {
  const opt = {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
    cf: { cacheTtl: 300, cacheEverything: true },
  };
  const r = await fetch(NAVER + 'FX_THBKRW/prices?page=1&pageSize=1', opt);
  if (!r.ok) throw new Error('네이버 환율 응답 ' + r.status);
  const rows = await r.json();
  const d = Array.isArray(rows) ? rows[0] : null;
  const v = parseFloat(String((d && d.cashBuyValue) || '').replace(/,/g, ''));
  if (!isFinite(v) || v <= 0) throw new Error('네이버 환율이 비어 있습니다');
  return { rate: v, date: (d && d.localTradedAt) || '' };
}

const krwUp = (n) => Math.ceil(n / 1000) * 1000;
/* 요일은 표준시(Z)로 고정해 읽는다 — 서버 시간대에 따라 주중/주말이 뒤집히면 안 된다 */
const isWeekendDate = (ds) => [0, 6].includes(new Date(ds + 'T00:00:00Z').getUTCDay());
const DEFAULT_MARGIN = 100;
const marginOf = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : DEFAULT_MARGIN);

/* 한 시즌 줄에서 «1인 18홀 / 1인 9홀» 손님가(밧)를 뽑는다. wk: 0=주중 1=주말 */
function unitsOf(s, wk) {
  const m = marginOf(s.margin);
  const g18 = s.gf18 && s.gf18[wk === 1 ? 'we' : 'wd'];
  const g9 = s.gf9 && s.gf9[wk === 1 ? 'we' : 'wd'];
  return {
    u18: g18 != null ? g18 + (s.caddie || 0) + (s.cart || 0) + m : null,
    u9: g9 != null ? g9 + (s.caddie9 || 0) + (s.cart9 || 0) + m : null,
  };
}

/* ── GET: 카드에 붙는 최저가 ── */
export async function onRequestGet({ env }) {
  let P, fx;
  try {
    const got = await Promise.all([readPricing(env), cashBuyRate()]);
    P = got[0]; fx = got[1];
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 502);
  }
  if (!P) return json({ ok: false, error: '요금표가 아직 등록되지 않았습니다' }, 503);

  const courses = [];
  Object.entries(P.regions || {}).forEach(([region, rv]) => {
    (rv.courses || []).forEach((c) => {
      /* 최저가 = 등록된 모든 시즌 × 주중/주말 중 가장 싼 값. 카드의 「~」가 이 뜻이다. */
      let lo18 = null, lo9 = null;
      (c.seasons || []).forEach((s) => {
        [0, 1].forEach((wk) => {
          const u = unitsOf(s, wk);
          if (u.u18 != null && (lo18 == null || u.u18 < lo18)) lo18 = u.u18;
          if (u.u9 != null && (lo9 == null || u.u9 < lo9)) lo9 = u.u9;
        });
      });
      if (lo18 == null && lo9 == null) return;   // 요금이 하나도 없는 골프장은 값을 안 내보낸다
      courses.push({
        region, name: c.name,
        from18: lo18 == null ? null : krwUp(lo18 * fx.rate),
        from9: lo9 == null ? null : krwUp(lo9 * fx.rate),
      });
    });
  });

  const hotels = [];
  Object.entries(P.regions || {}).forEach(([region, rv]) => {
    (rv.hotels || []).forEach((h) => {
      const v = (+h.perNight || 0) + marginOf(h.margin);
      if (!(v > 0)) return;
      hotels.push({ region, name: h.name, fromKrw: krwUp(v * fx.rate) });   // 1실 1박
    });
  });

  /* 요금을 고치면 곧 반영돼야 하지만, 카드 목록은 손님마다 매번 계산할 필요가 없다 */
  return json(
    { ok: true, courses, hotels, fx: { rate: fx.rate, date: fx.date, basis: '현찰 살때 (하나은행 고시)' } },
    200,
    'public, max-age=60'
  );
}

/* ── POST: 날짜·인원을 넣은 정확한 금액 ── */
export async function onRequestPost({ request, env }) {
  let B;
  try { B = await request.json(); }
  catch (e) { return json({ ok: false, error: '요청을 읽지 못했습니다' }, 400); }

  const region = String(B.region || '');
  const name = String(B.course || '');
  const holes = String(B.holes || '18');
  const date = String(B.date || '');
  const pax = Math.max(1, Math.min(60, Math.round(+B.pax || 1)));
  if (!name) return json({ ok: false, error: '골프장을 골라 주세요' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: '날짜를 골라 주세요' }, 400);

  let P, fx;
  try {
    const got = await Promise.all([readPricing(env), cashBuyRate()]);
    P = got[0]; fx = got[1];
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 502);
  }
  if (!P) return json({ ok: false, error: '요금표가 아직 등록되지 않았습니다' }, 503);

  /* 지역이 안 맞아도 이름으로 찾는다 — 사이트의 지역 표기와 요금표가 조금 달라도 견적이 나와야 한다 */
  let course = null;
  const inReg = ((P.regions || {})[region] || {}).courses || [];
  course = inReg.find((c) => c.name === name) || null;
  if (!course) {
    Object.values(P.regions || {}).forEach((rv) => {
      if (!course) course = (rv.courses || []).find((c) => c.name === name) || null;
    });
  }
  if (!course) return json({ ok: false, error: '이 골프장은 요금이 등록되어 있지 않습니다' }, 404);

  const season = (course.seasons || []).find((s) => s.from && s.to && date >= s.from && date <= s.to);
  if (!season) return json({ ok: false, error: '고르신 날짜의 요금이 아직 등록되어 있지 않습니다', needAsk: true }, 200);

  const holidays = Array.isArray(P.holidays) ? P.holidays : [];
  const we = isWeekendDate(date) || holidays.includes(date);
  const u = unitsOf(season, we ? 1 : 0);

  let baht = null;
  if (holes === '18') baht = u.u18;
  else if (holes === '9') baht = u.u9;
  else if (holes === '27') baht = (u.u18 != null && u.u9 != null) ? u.u18 + u.u9 : null;
  else if (holes === '36') baht = u.u18 != null ? u.u18 * 2 : null;
  if (baht == null) {
    return json({ ok: false, error: '고르신 날짜·홀수의 요금이 아직 등록되어 있지 않습니다', needAsk: true }, 200);
  }

  const perKrw = krwUp(baht * fx.rate);
  return json({
    ok: true,
    course: course.name, region, holes, date, pax, we,
    season: season.label || '',
    perKrw, totalKrw: perKrw * pax,
    includes: ['그린피', '캐디피', '카트비'],
    excludes: ['캐디팁', '개인 경비'],
    fx: { rate: fx.rate, date: fx.date, basis: '현찰 살때 (하나은행 고시)' },
  });
}

export const onRequestOptions = () =>
  new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
