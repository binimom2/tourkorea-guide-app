/* ══════════════════════════════════════════════════════════════════
   SuperRich Thailand 환율 (Cloudflare Pages Function)
   가이드 정산서의 「🔄 환율 자동」이 쓴다 — 사장님 기준: https://www.superrichthailand.com/exchange-rate
     · 달러 = 100$권 Buying Rate
     · 원화 = 50,000권(50000 - 5000) Buying Rate

   SuperRich의 옛 JSON API(/web/api/v1/rates)는 봇차단·404라 못 쓴다. 대신 환율 페이지가
   서버에서 그려져(Next.js) 환율 표가 HTML 안에 JSON으로 박혀 있으므로, 이 함수가 페이지를
   받아 그 JSON 조각에서 값을 뽑는다. 브라우저에서 직접 부르면 CORS로 막혀 서버가 대신 받는다.

   경로: GET /api/superrich
   응답: { ok:true, usd:{denom,buy,sell}, krw:{denom,buy,sell}, fetchedAt, source }
   ══════════════════════════════════════════════════════════════════ */
const PAGE = 'https://www.superrichthailand.com/exchange-rate';
const WANT = { usd: { unit: 'USD', denom: '100' }, krw: { unit: 'KRW', denom: '50000 - 5000' } };

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'content-type': 'application/json;charset=utf-8',
      // 환율은 하루 몇 번 바뀐다 — 5분 캐시로 충분하고 SuperRich 과호출도 막는다
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* 페이지 안의 JSON은 \" 로 이스케이프돼 있다 → 풀고 나서 "USD":[{ ... }] 블록만 잘라 권종별 값을 찾는다 */
function pick(txt, unit, denom) {
  const i = txt.indexOf('"' + unit + '":[{');
  if (i < 0) return null;
  const j = txt.indexOf('}]', i);
  const block = txt.slice(i, j > 0 ? j + 2 : i + 4000);
  const m = block.match(new RegExp('"denomRem":"' + esc(denom) + '","buyText":"([0-9.]+)","sellText":"([0-9.]+)"'));
  if (!m) return null;
  const buy = parseFloat(m[1]), sell = parseFloat(m[2]);
  if (!isFinite(buy) || !isFinite(sell)) return null;
  return { denom, buy, sell };
}

export async function onRequestGet() {
  try {
    const r = await fetch(PAGE, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9,th;q=0.8',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!r.ok) throw new Error('superrich ' + r.status);
    const html = await r.text();
    const txt = html.replace(/\\"/g, '"');
    const usd = pick(txt, WANT.usd.unit, WANT.usd.denom);
    const krw = pick(txt, WANT.krw.unit, WANT.krw.denom);
    if (!usd || !krw) throw new Error('환율 표를 찾지 못함 (페이지 구조가 바뀌었을 수 있음)');
    // 상식 범위 밖이면 페이지가 바뀐 것 — 엉뚱한 값을 정산에 넣지 않게 막는다
    if (usd.buy < 25 || usd.buy > 55 || krw.buy < 0.01 || krw.buy > 0.05) throw new Error('환율 값이 비정상 범위');
    return json({ ok: true, usd, krw, fetchedAt: new Date().toISOString(), source: 'SuperRich Thailand (exchange-rate 페이지)' });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 502);
  }
}
