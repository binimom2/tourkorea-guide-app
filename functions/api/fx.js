/* ══════════════════════════════════════════════════════════════════
   환율 가져오기 (Cloudflare Pages Function) — 네이버 금융(하나은행 고시)
   브라우저에서 네이버를 직접 부르면 CORS로 막힌다. 서버(이 함수)가 대신 받아 넘긴다.

   경로: GET /api/fx?code=FX_THBKRW      (code 생략 시 태국 바트)
   응답: { ok:true, code, name, date, base, cashBuy, cashSell, send, receive, source }
     base     매매기준율      cashBuy  현찰 사실 때(살때)
     cashSell 현찰 파실 때(팔때)       send/receive 송금 보내실/받으실 때
   ══════════════════════════════════════════════════════════════════ */
const NAVER = 'https://api.stock.naver.com/marketindex/exchange/';
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : null; };

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'content-type': 'application/json;charset=utf-8',
      // 네이버는 은행 고시회차 단위로 바뀐다 — 5분 캐시로 충분하고 과호출도 막는다
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || 'FX_THBKRW').toUpperCase();
  // 코드 형식을 고정해 둔다 — 임의 주소를 대신 받아오는 통로가 되지 않게
  if (!/^FX_[A-Z]{6}$/.test(code)) return json({ ok: false, error: '지원하지 않는 통화코드' }, 400);

  const opt = { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }, cf: { cacheTtl: 300, cacheEverything: true } };
  try {
    // 일별시세: 매매기준율 + 현찰 살때/팔때 + 송금 보내실/받으실 때가 한 번에 온다
    const r = await fetch(`${NAVER}${code}/prices?page=1&pageSize=1`, opt);
    if (!r.ok) throw new Error('naver ' + r.status);
    const rows = await r.json();
    const d = Array.isArray(rows) ? rows[0] : null;
    if (!d || !num(d.closePrice)) throw new Error('빈 응답');

    // 통화 이름은 별도 호출 — 실패해도 환율 값은 그대로 쓴다
    let name = code.slice(3, 6);
    try {
      const r2 = await fetch(`${NAVER}${code}`, opt);
      if (r2.ok) { const j = await r2.json(); name = (j.exchangeInfo && j.exchangeInfo.name) || name; }
    } catch (e) {}

    return json({
      ok: true, code, name,
      date: d.localTradedAt || '',
      base: num(d.closePrice),
      cashBuy: num(d.cashBuyValue),
      cashSell: num(d.cashSellValue),
      send: num(d.sendValue),
      receive: num(d.receiveValue),
      source: '네이버 금융(하나은행 고시)',
    });
  } catch (e) {
    return json({ ok: false, error: '네이버 환율을 가져오지 못했습니다 (' + (e.message || e) + ')' }, 502);
  }
}
