/* ══════════════════════════════════════════════════════════════════
   손님용 실시간 골프 견적 (Cloudflare Pages Function)

   왜 서버에서 계산하는가 —
   요금표(golf_pricing)에는 그린피·캐디피·카트피 원가가 그대로 들어 있다.
   손님 브라우저로 요금표를 내려보내면 원가가 통째로 노출되고, 마진이 100밧이면
   표시금액에서 100을 빼는 것만으로 원가가 드러난다. 그래서 요금표는 이 서버에서만
   읽고, 손님에게는 «요청한 일정의 총액»만 돌려준다. 항목별 밧 금액은 내려보내지 않는다.

   경로: POST /api/golf-quote
   본문(JSON):
     { pax, amDep, vehicle, vehicleGroup, guide,
       route:  [{region, nights}],
       rounds: [{date:'2026-11-10', region, course, holes:'18'|'9'|'27'|'36'}],
       hotels: [{region, name, nights, room:'twin'|'single'|'triple'}] }
   응답:
     { ok, pax, nights, days, perKrw, totalKrw, fx:{rate,date,basis}, includes[], warnings[] }

   계산 규칙은 직원용 견적기(/golf/ 의 calc())와 같다. 두 곳의 금액이 어긋나면
   손님이 받은 견적과 직원이 만든 견적서가 달라지므로, 저쪽을 고치면 여기도 같이 고칠 것.
   ══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL = 'https://aplevsrmxkzghutihyvs.supabase.co';
const NAVER = 'https://api.stock.naver.com/marketindex/exchange/';

/* 손님 화면에 그대로 붙는 값이라 캐시를 두지 않는다 — 요금을 고치면 바로 반영돼야 한다 */
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'content-type': 'application/json;charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });

/* ── 요금표 읽기 (service_role — 이 키는 브라우저로 절대 안 나간다) ── */
async function readKey(env, key) {
  const sr = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sr) throw new Error('서버에 SUPABASE_SERVICE_ROLE_KEY가 등록되어 있지 않습니다');
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/guide_data?data_key=eq.' + encodeURIComponent(key) + '&select=data',
    { headers: { apikey: sr, Authorization: 'Bearer ' + sr } }
  );
  if (!r.ok) throw new Error(key + ' 읽기 실패 (' + r.status + ')');
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0] && rows[0].data) || null;
}

/* ── 환율: 네이버 금융(하나은행 고시) 현찰 살때 ──
   손님에게 나가는 한화는 «현찰 살때» 기준이다(사장님 지정). 못 가져오면 견적을 내지 않는다 —
   틀린 환율로 안내하느니 잠시 후 다시 시도해 달라고 하는 편이 낫다. */
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

/* ── 직원용 견적기와 같은 헬퍼 ── */
const krwUp = (n) => Math.ceil(n / 1000) * 1000;   // 한화는 천원 단위 올림(내리지 않는다)
/* 요일은 표준시(Z)로 고정해 읽는다 — 서버 시간대에 따라 주중/주말이 뒤집히면 안 된다 */
const isWeekendDate = (ds) => [0, 6].includes(new Date(ds + 'T00:00:00Z').getUTCDay());
const roomCount = (pax, rt) =>
  rt === 'single' ? pax : rt === 'triple' ? Math.ceil(pax / 3) : Math.ceil(pax / 2);

/* 마진: 요금표의 각 줄에 적어 둔 값을 쓰고, 비어 있으면 기본 100밧 */
const DEFAULT_MARGIN = 100;
const marginOf = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : DEFAULT_MARGIN);

/* 기간 요금 확장: 등록된 최고 기간 + 초과 박수 × '1박추가시' */
function tierValue(obj, N, key, full) {
  const NORMAL = [['1일', 0], ['1박2일', 1], ['2박3일', 2], ['3박4일', 3]];
  const FULL = [['풀1박2일', 1], ['풀2박3일', 2], ['풀3박4일', 3]];
  const pick = (order) => {
    const oneMore = ((obj || {})['1박추가시'] || {})[key] || 0;
    let base = null, bn = 0;
    order.forEach(([nm, pn]) => {
      const v = ((obj || {})[nm] || {})[key];
      if (v != null && v > 0 && pn <= N) { base = v; bn = pn; }
    });
    if (base === null) {
      for (const [nm, pn] of order) {
        const v = ((obj || {})[nm] || {})[key];
        if (v != null && v > 0) { base = v; bn = pn; break; }
      }
    }
    if (base === null) return null;
    return { value: base + oneMore * Math.max(0, N - bn) };
  };
  return full ? (pick(FULL) || pick(NORMAL)) : pick(NORMAL);
}

/* golf_pricing의 regions → 계산용 골프장 표로 편다 (직원용 loadPricing()과 같은 변환) */
function coursesOf(P) {
  const out = {};
  Object.entries(P.regions || {}).forEach(([reg, rv]) => {
    out[reg] = (rv.courses || []).map((c) => ({
      n: c.name,
      s: (c.seasons || []).map((s) => ({
        from: s.from, to: s.to,
        g18: [
          s.gf18 && s.gf18.wd != null ? s.gf18.wd : null,
          s.gf18 && s.gf18.we != null ? s.gf18.we : null,
        ],
        cad: s.caddie || 0, crt: s.cart || 0,
        g9: s.gf9 && (s.gf9.wd != null || s.gf9.we != null)
          ? [s.gf9.wd != null ? s.gf9.wd : null, s.gf9.we != null ? s.gf9.we : null]
          : null,
        cad9: s.caddie9 || 0, crt9: s.cart9 || 0,
        margin: s.margin,          // 요금표 '마진' 칸 — 비어 있으면 기본 100밧
      })),
    }));
  });
  return out;
}
function hotelsOf(P) {
  const out = {};
  Object.entries(P.regions || {}).forEach(([reg, rv]) => {
    if (rv.hotels && rv.hotels.length) out[reg] = rv.hotels;
  });
  return out;
}

export async function onRequestPost({ request, env }) {
  let B;
  try { B = await request.json(); }
  catch (e) { return json({ ok: false, error: '요청을 읽지 못했습니다' }, 400); }

  /* 상한을 둬서 장난 요청으로 서버가 오래 도는 일을 막는다 */
  const pax = Math.max(1, Math.min(60, Math.round(+B.pax || 1)));
  const route = Array.isArray(B.route) ? B.route : [];
  const rounds = Array.isArray(B.rounds) ? B.rounds.slice(0, 30) : [];
  const hotelsIn = Array.isArray(B.hotels) ? B.hotels.slice(0, 20) : [];
  const nights = route.reduce((a, r) => a + Math.max(0, Math.round(+r.nights || 0)), 0);
  const amDep = !!B.amDep;

  let P, fx;
  try {
    const got = await Promise.all([readKey(env, 'golf_pricing'), cashBuyRate()]);
    P = got[0]; fx = got[1];
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 502);
  }
  if (!P) return json({ ok: false, error: '요금표가 아직 등록되지 않았습니다' }, 503);

  const COURSES = coursesOf(P);
  const HOTELS = hotelsOf(P);
  const holidays = Array.isArray(P.holidays) ? P.holidays : [];
  const warnings = [];
  let total = 0, golfCount = 0, hotelNights = 0;

  /* 1) 골프 — 체크한 날마다 (그린피 + 캐디 + 카트 + 마진) × 인원 */
  rounds.forEach((st) => {
    if (!st || !st.date || !st.course) return;
    const c = (COURSES[st.region] || []).find((x) => x.n === st.course);
    if (!c) { warnings.push(st.course + ' 요금이 등록되어 있지 않습니다'); return; }
    const ss = (c.s || []).find((x) => st.date >= x.from && st.date <= x.to);
    if (!ss) { warnings.push(c.n + ' ' + st.date + ' 해당일 요금이 등록되어 있지 않습니다'); return; }
    const wk = (isWeekendDate(st.date) || holidays.includes(st.date)) ? 1 : 0;
    const u18 = ss.g18 && ss.g18[wk] != null ? ss.g18[wk] + ss.cad + ss.crt : null;
    const u9 = ss.g9 && ss.g9[wk] != null ? ss.g9[wk] + ss.cad9 + ss.crt9 : null;
    const holes = String(st.holes || '18');
    let unit = null;
    if (holes === '18') unit = u18;
    else if (holes === '9') unit = u9;
    else if (holes === '27') unit = (u18 != null && u9 != null) ? u18 + u9 : null;
    else if (holes === '36') unit = u18 != null ? u18 * 2 : null;
    if (unit == null) {
      warnings.push(c.n + ' ' + st.date + ' ' + (wk ? '주말' : '주중') + ' 요금이 등록되어 있지 않습니다');
      return;
    }
    total += (unit + marginOf(ss.margin)) * pax;
    golfCount++;
  });

  /* 2) 차량 */
  if (B.vehicle !== false) {
    const groups = Array.isArray(P.vehicleGroups) && P.vehicleGroups.length
      ? P.vehicleGroups
      : [{ periods: P.vehiclePeriods || {} }];
    const gi = Math.max(0, Math.min(groups.length - 1, Math.round(+B.vehicleGroup || 0)));
    const g = groups[gi];
    const vt = tierValue((g && g.periods) || {}, nights, 'amount', amDep);
    if (vt) total += vt.value * Math.ceil(pax / (+(g && g.maxPax) > 0 ? +g.maxPax : 7));
    else warnings.push('차량 요금이 등록되어 있지 않습니다');
  }

  /* 3) 핸들링 차지 — 직원용 견적기와 같이 항상 붙는다 */
  const ht = tierValue(P.handlingPeriods || {}, nights, 'amount');
  if (ht) total += ht.value * pax;
  else warnings.push('핸들링 요금이 등록되어 있지 않습니다');

  /* 4) 가이드 — 고른 종류가 있을 때만 */
  const gt = String(B.guide || '');
  if (gt) {
    const gv = tierValue((P.guidePeriods || {})[gt] || {}, nights, 'bkk', amDep);
    if (gv) total += gv.value;
    else warnings.push(gt + ' 요금이 등록되어 있지 않습니다');
  }

  /* 5) 숙소 — (1박 요금 + 마진) × 박수 × 실수. 마진은 인원과 무관하게 «1실 1박당». */
  hotelsIn.forEach((h) => {
    if (!h || !h.name) return;
    const nn = Math.max(0, Math.round(+h.nights || 0));
    if (!nn) return;
    const rec = (HOTELS[h.region] || []).find((x) => x.name === h.name);
    if (!rec) { warnings.push(h.name + ' 요금이 등록되어 있지 않습니다'); return; }
    const rms = roomCount(pax, String(h.room || 'twin'));
    total += ((+rec.perNight || 0) + marginOf(rec.margin)) * nn * rms;
    hotelNights += nn;
  });

  if (!golfCount && !hotelNights) {
    return json({ ok: false, error: '라운딩할 날이나 숙소를 하나 이상 골라 주세요' }, 400);
  }

  /* 한화 — 1인 요금을 천원 단위로 올린 뒤 인원수를 곱한다.
     총액을 환산해서 올리면 «1인 요금 × 인원수»와 어긋나 손님이 직접 곱했을 때 안 맞는다. */
  const per = Math.round(total / pax);
  const perKrw = krwUp(per * fx.rate);
  const totalKrw = perKrw * pax;

  const includes = [];
  if (golfCount) includes.push('골프 ' + golfCount + '회 (그린피·캐디피·카트비 포함)');
  if (hotelNights) includes.push('숙소 ' + hotelNights + '박');
  if (B.vehicle !== false) includes.push('전용 차량 · 기사');
  if (gt) includes.push(gt);

  return json({
    ok: true,
    pax, nights, days: nights + 1,
    perKrw, totalKrw,
    fx: { rate: fx.rate, date: fx.date, basis: '현찰 살때 (하나은행 고시)' },
    includes, warnings,
  });
}

/* 손님 페이지에서 바로 부르므로 프리플라이트를 허용한다 */
export const onRequestOptions = () =>
  new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
