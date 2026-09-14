/* ══════════════════════════════════════════════════════════════════
   창(모달) 배경 클릭 닫기 — 공통 안전장치  (사장님 2026-09-14: "모든 공통에 넓게")

   증상: 입력창 안에서 글자를 드래그하거나 누른 채 마우스가 창 밖으로 조금 벗어난 뒤 떼면,
         브라우저는 «누른 곳과 뗀 곳의 공통 조상»(= 배경)에 click을 보낸다.
         배경 클릭으로 닫히는 창은 이때 입력 중인 내용과 함께 닫혀 버린다.
   원리: 누른 곳(mousedown)을 기억해 두었다가, click이 «전체 화면을 덮은 fixed 요소(배경)»에
         떨어졌는데 누른 곳이 그 배경 자체가 아니면(= 창 안에서 시작한 드래그) 그 click을 삼킨다.
         배경을 그 자리에서 눌렀다 뗀 진짜 배경 클릭은 그대로 통과한다.
   적용: 가이드 정산서 · 여행수배서(/travel/) · 골프 견적/관리/손님 사이트 — <head>에서 불러온다.
         페이지 코드는 손대지 않아도 되고, 배경에 걸린 onclick / addEventListener('click') 모두 막힌다.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__ovGuard) return;
  window.__ovGuard = true;
  var downTarget = null;

  function isOverlay(el) {
    if (!el || el === document.body || el === document.documentElement || el.nodeType !== 1) return false;
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed') return false;
    var r = el.getBoundingClientRect();
    return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
  }

  document.addEventListener('mousedown', function (e) { downTarget = e.target; }, true);
  document.addEventListener('click', function (e) {
    var d = downTarget; downTarget = null;
    if (!d || d === e.target) return;               // 같은 자리에서 눌렀다 뗐다 → 진짜 클릭
    if (!isOverlay(e.target)) return;               // 배경이 아닌 곳의 클릭은 상관없다
    if (d === e.target) return;
    /* 창 안에서 누르고 배경에서 뗀 드래그 — 배경 클릭으로 치지 않는다 */
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
})();
