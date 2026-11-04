/* ══════════════════════════════════════════════════════════════════
   한글 마지막 글자 지킴이 — 공통  (사장님 2026-10-20: "모든 프로그램, 텍스트 찍는 칸 전부")

   증상: 「소파」까지 치고 마우스로 다른 곳을 누르거나 Tab·저장을 누르면 조합 중이던 마지막 글자(「파」)가 사라진다.
         키보드로 확정하지 않은 글자를 브라우저(IME)가 «확정»이 아니라 «취소»해 버리는 것이다.
   원리: 조합 중에 본 «가장 긴» 값(치던 글자 포함)을 기억해 두었다가, 조합이 끝난 직후 값이 그보다 «짧아졌으면»
         기억해 둔 값으로 되돌리고 input 이벤트를 다시 보내 페이지 자료에도 반영한다.
         지우는 키(Backspace·Delete·Esc)로 줄어든 것은 일부러 지운 것이라 건드리지 않는다.
   v2 (2026-11-04, 「가이드명 등 거의 모든 칸」 재신고):
     · 입력기가 글자를 취소할 때 «조합 중» 표시를 단 지우기 입력을 먼저 보내는데, 옛 판은 그 잘린 값을
       «마지막 값»으로 기억해 버려 되살릴 게 없다고 보았다 → 지우는 키 없이 줄어든 조합 값은 기억하지 않는다.
     · 조합 끝 신호(compositionend)가 오지 않은 채 칸을 벗어나도 되살린다.
     · Enter로 보낸 뒤 페이지가 칸을 비운 경우(검색·채팅식 칸)는 되살리지 않는다.
   처음엔 골프 사이트 관리에만 있었다(2026-09-19, 7e025c0·7d7df1c).
   적용: 가이드 정산서 · 여행수배서(/travel/) · 골프 견적/관리/손님 사이트 · 자료실 · 양식 · 풀빌라 수배서.
   ※ 사본 3곳(가이드정산서 /imeguard.js · /golf/site/imeguard.js · 풀빌라 /imeguard.js)을 늘 같게 둘 것.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__imeGuard) return;
  window.__imeGuard = 4;
  var DEL = { Backspace: 1, Delete: 1, Escape: 1 };
  var ime = { el: null, val: null, valTs: 0 };
  var delTs = 0, enterTs = 0;
  var pend = null;                                   // 조합이 막 끝난 칸 — {el,want,since,until}

  function isText(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'); }

  /* ── 기록(2026-11-04, 사장님 「다음엔 추측 말고 기록으로」) ──
     입력기가 실제로 보낸 신호 순서를 이 PC 브라우저에 최근 200개까지 남긴다(서버로 보내지 않음).
     글자가 또 빠지면 그 화면에서 Ctrl+Alt+L → [복사] → 클로드에게 붙여넣기. 글 내용은 끝 6글자만 남긴다. */
  var LOGK = 'imeGuardLog', LOG = [], saveT = 0;
  try { LOG = JSON.parse(localStorage.getItem(LOGK) || '[]') || []; } catch (_) { LOG = []; }
  function tag(el) {
    if (!el || !el.tagName) return '?';
    var d = el.dataset || {};
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.name ? '[' + el.name + ']' : '') + (d.p ? '{' + d.p + '}' : '');
  }
  function tail(v) { v = String(v == null ? '' : v); return (v.length > 6 ? '…' : '') + v.slice(-6) + '(' + v.length + ')'; }
  function rec(s) {
    var t = new Date(), ms = ('00' + t.getMilliseconds()).slice(-3);
    LOG.push(t.toTimeString().slice(0, 8) + '.' + ms + ' ' + s);
    if (LOG.length > 200) LOG.splice(0, LOG.length - 200);
    clearTimeout(saveT);
    saveT = setTimeout(function () { try { localStorage.setItem(LOGK, JSON.stringify(LOG)); } catch (_) {} }, 300);
  }
  rec('── 화면 열림 ' + location.pathname + ' v' + window.__imeGuard + ' ' + (navigator.userAgent.match(/(Chrome|Edg|Whale|Firefox)\/[\d.]+/g) || []).join(' '));
  function raw(e) {
    var el = e.target;
    if (e.type === 'keydown' || e.type === 'keyup') { if (!isText(el)) return; rec(e.type + ' key=' + e.key + ' code=' + e.code + (e.isComposing ? ' C' : '') + ' ' + tail(el.value)); return; }
    if (e.type === 'mousedown') { rec('mousedown ' + tag(el)); return; }
    if (!isText(el)) return;
    rec(e.type + (e.inputType ? ' ' + e.inputType : '') + (e.isComposing ? ' C' : '') + (e.data != null ? ' data="' + e.data + '"' : '') + ' ' + tag(el) + ' ' + tail(el.value));
  }
  ['keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'focusout', 'change', 'mousedown']
    .forEach(function (t) { document.addEventListener(t, raw, true); });
  window.addEventListener('blur', function () { rec('창 blur(다른 프로그램으로)'); });
  /* 기록 보기 — Ctrl+Alt+L */
  function showLog() {
    var old = document.getElementById('__imeLogBox'); if (old) { old.remove(); return; }
    var box = document.createElement('div'); box.id = '__imeLogBox';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;width:min(560px,calc(100vw - 32px));background:#fff;border:2px solid #173d2c;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.3);z-index:2147483647;padding:10px;font-size:13px';
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">한글 입력 기록 — [복사] 눌러 클로드에게 붙여넣기</div>';
    var ta = document.createElement('textarea'); ta.readOnly = true; ta.value = LOG.join('\n');
    ta.style.cssText = 'width:100%;height:260px;font:11px/1.35 Consolas,monospace;box-sizing:border-box';
    var bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;margin-top:6px';
    function btn(txt, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid #173d2c;background:#fff;cursor:pointer;font-weight:700'; b.onclick = fn; bar.appendChild(b); return b; }
    var cb = btn('복사', function () {
      ta.select();
      var ok = function () { cb.textContent = '복사됨 ✓'; };
      if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(ok, function () { try { document.execCommand('copy'); ok(); } catch (_) {} });
      else { try { document.execCommand('copy'); ok(); } catch (_) {} }
    });
    btn('비우기', function () { LOG = []; try { localStorage.removeItem(LOGK); } catch (_) {} ta.value = ''; });
    btn('닫기', function () { box.remove(); });
    box.appendChild(ta); box.appendChild(bar);
    (document.body || document.documentElement).appendChild(box);
    ta.scrollTop = ta.scrollHeight;
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.altKey && (e.code === 'KeyL' || e.key === 'l' || e.key === 'L')) { e.preventDefault(); showLog(); }
  }, true);
  window.__imeLog = showLog;
  function note(lost) {
    /* 되살렸을 때 한 줄 알린다 — 이 알림이 뜨면 입력기 쪽에서 빠진 글자를 잡아 준 것이다 */
    var t = document.createElement('div');
    t.textContent = '↩ 빠질 뻔한 마지막 글자 「' + lost + '」를 되살렸습니다';
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#173d2c;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;font-weight:700;z-index:2147483647;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none';
    (document.body || document.documentElement).appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  document.addEventListener('keydown', function (e) {
    if (DEL[e.code] || DEL[e.key]) { delTs = Date.now(); pend = null; }
    if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') enterTs = Date.now();
  }, true);
  document.addEventListener('compositionstart', function (e) {
    if (isText(e.target)) { ime.el = e.target; ime.val = e.target.value; ime.valTs = Date.now(); }
  }, true);
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!isText(el) || !e.isComposing) return;
    var v = el.value;
    if (ime.el === el && ime.val != null && v.length < ime.val.length && ime.val.indexOf(v) === 0 && delTs < ime.valTs) { rec('지킴이: 지우는 키 없이 줄어든 조합값 무시, 기억=' + tail(ime.val)); return; } // 지우는 키 없이 줄었다 = 입력기가 취소한 것 — 긴 값을 계속 기억
    ime.el = el; ime.val = v; ime.valTs = Date.now();
  }, true);

  function fix() {
    if (!pend) return;
    var el = pend.el, want = pend.want, v = el.value;
    if (Date.now() > pend.until || !el.isConnected) { pend = null; return; }
    if (delTs >= pend.since) { rec('지킴이: 지우는 키 눌러 포기'); pend = null; return; }                 // 그 뒤에 지우는 키를 눌렀다
    if (v === want || v.length >= want.length) return;                // 제대로 확정됐다(아직은) — 조금 뒤 다시 본다
    if (want.indexOf(v) !== 0) { rec('지킴이: 앞부분이 바뀌어 포기 ' + tail(v)); pend = null; return; }               // 앞부분까지 바뀌었다 = 페이지가 일부러 바꾼 값
    if (v === '' && enterTs >= pend.since - 1500) { rec('지킴이: Enter 후 비움이라 포기'); pend = null; return; } // Enter로 보내고 페이지가 칸을 비웠다
    pend = null;
    el.value = want;
    try { el.setSelectionRange(want.length, want.length); } catch (_) {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
    rec('지킴이: ✅ 되살림 「' + want.slice(v.length) + '」 ' + tail(want));
    note(want.slice(v.length));
  }
  function arm(el, want, since) {
    pend = { el: el, want: want, since: since, until: Date.now() + 1500 };
    rec('지킴이: 감시 시작 기억=' + tail(want) + ' ' + tag(el));
    setTimeout(function () {   // 감시가 끝난 뒤에도 짧으면 «놓친 것» — 이 줄이 기록에 있으면 빈틈이다
      var v = el.value;
      if (el.isConnected && delTs < since && v.length < want.length && want.indexOf(v) === 0 && !(v === '' && enterTs >= since - 1500)) rec('⚠ 놓침: 기억=' + tail(want) + ' 지금=' + tail(v) + ' ' + tag(el));
    }, 1700);
    fix(); [0, 30, 80, 250, 600, 1000].forEach(function (ms) { setTimeout(fix, ms); });   // 브라우저마다 값이 빠지는 때가 조금씩 다르다
  }
  document.addEventListener('compositionend', function (e) {
    var el = e.target, want = (ime.el === el) ? ime.val : null, valTs = ime.valTs;
    ime.el = null; ime.val = null;
    if (want == null || !isText(el)) return;
    if (delTs >= valTs) return;                                       // 지우는 키로 끝난 조합 — 일부러 지운 것이다
    arm(el, want, valTs);
  }, true);
  /* 칸을 벗어나는 순간·change·mousedown에도 본다(저장 처리기가 잘린 값을 읽기 전에).
     조합 끝 신호 없이 칸을 벗어난 경우도 여기서 잡는다. 다시 그 칸에 글자를 치면 기다리던 것은 버린다 */
  document.addEventListener('focusout', function (e) {
    var el = e.target;
    if (ime.el === el && ime.val != null && delTs < ime.valTs) {      // 조합 중인 채로 칸을 벗어났다
      var want = ime.val, since = ime.valTs;
      ime.el = null; ime.val = null;
      arm(el, want, since);
      return;
    }
    if (pend && pend.el === el) fix();
  }, true);
  document.addEventListener('change', function (e) { if (pend && pend.el === e.target) fix(); }, true);
  document.addEventListener('mousedown', function () { if (pend) fix(); }, true);
  /* v3: 다시 «글자를 넣을» 때만 기다리던 것을 버린다. 입력기가 조합 끝난 뒤 보내는 지우기 신호(delete…)로 버리면
     바로 그 지우기 때문에 빠진 글자를 못 되살린다(「진입불가」→「진입불」, 사장님 2026-11-04) */
  document.addEventListener('beforeinput', function (e) {
    if (pend && pend.el === e.target && !e.isComposing && String(e.inputType || '').indexOf('insert') === 0 && e.inputType !== 'insertCompositionText') pend = null;
  }, true);
})();
