/* ══════════════════════════════════════════════════════════════════
   한글 마지막 글자 지킴이 — 공통  (사장님 2026-10-20: "모든 프로그램, 텍스트 찍는 칸 전부")

   증상: 「소파」까지 치고 마우스로 다른 곳을 누르거나 Tab·저장을 누르면 조합 중이던 마지막 글자(「파」)가 사라진다.
         키보드로 확정하지 않은 글자를 브라우저(IME)가 «확정»이 아니라 «취소»해 버리는 것이다.
   원리: 조합 중에 본 마지막 값(치던 글자 포함)을 기억해 두었다가, 조합이 끝난 직후 값이 그보다 «짧아졌으면»
         기억해 둔 값으로 되돌리고 input 이벤트를 다시 보내 페이지 자료에도 반영한다.
         지우는 키(Backspace·Delete·Esc)로 끝난 조합은 일부러 지운 것이라 건드리지 않는다.
         처음엔 골프 사이트 관리에만 있었다(2026-09-19, 7e025c0·7d7df1c) — 여기로 옮겨 모든 화면 <head>에서 불러온다.
   적용: 가이드 정산서 · 여행수배서(/travel/) · 골프 견적/관리/손님 사이트 · 자료실 · 양식 · 풀빌라 수배서.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__imeGuard) return;
  window.__imeGuard = true;
  var DEL = { Backspace: 1, Delete: 1, Escape: 1 };
  var ime = { el: null, val: null, valTs: 0, delTs: 0 };
  var pend = null;                                   // 조합이 막 끝난 칸 — {el,want,until}

  function isText(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'); }
  function note(lost) {
    /* 되살렸을 때 한 줄 알린다 — 이 알림이 뜨면 입력기 쪽에서 빠진 글자를 잡아 준 것이다 */
    var msg = '↩ 빠질 뻔한 마지막 글자 「' + lost + '」를 되살렸습니다';
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#173d2c;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;font-weight:700;z-index:2147483647;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none';
    (document.body || document.documentElement).appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  document.addEventListener('keydown', function (e) { if (DEL[e.code] || DEL[e.key]) { ime.delTs = Date.now(); pend = null; } }, true);
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!isText(el)) return;
    if (e.isComposing) { ime.el = el; ime.val = el.value; ime.valTs = Date.now(); }
  }, true);
  function fix() {
    if (!pend) return;
    var el = pend.el, want = pend.want;
    if (Date.now() > pend.until || !el.isConnected) { pend = null; return; }
    if (el.value === want || el.value.length >= want.length) return;   // 제대로 확정됐다(아직은) — 조금 뒤 다시 본다
    if (want.indexOf(el.value) !== 0) { pend = null; return; }         // 앞부분까지 바뀌었다 = 페이지가 일부러 바꾼 값 — 건드리지 않는다
    pend = null;
    var lost = want.slice(el.value.length);
    el.value = want;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    note(lost);
  }
  document.addEventListener('compositionend', function (e) {
    var el = e.target, want = (ime.el === el) ? ime.val : null, valTs = ime.valTs;
    ime.el = null; ime.val = null;
    if (want == null) return;
    if (ime.delTs >= valTs) return;                                     // 지우는 키로 끝난 조합 — 일부러 지운 것이다
    pend = { el: el, want: want, until: Date.now() + 1200 };
    fix(); [0, 60, 250, 600].forEach(function (ms) { setTimeout(fix, ms); });   // 브라우저마다 값이 빠지는 때가 조금씩 다르다
  }, true);
  /* 칸을 벗어나는 순간·change·Enter 직전에도 본다(저장 처리기가 잘린 값을 읽기 전에). 다시 그 칸에 글자를 치면 기다리던 것은 버린다 */
  document.addEventListener('focusout', function (e) { if (pend && pend.el === e.target) fix(); }, true);
  document.addEventListener('change', function (e) { if (pend && pend.el === e.target) fix(); }, true);
  document.addEventListener('mousedown', function () { if (pend) fix(); }, true);
  document.addEventListener('beforeinput', function (e) { if (pend && pend.el === e.target && !e.isComposing) pend = null; }, true);
})();
