/* 수배 공용 양식(인보이스·바우처) 공통 동작 — 사장님 2026-09-23
   · 서버에 저장하지 않는다. 쓰던 내용(key)과 회사 정보(tk_form_company, 두 양식이 같이 씀)는 이 브라우저 localStorage에만 남는다.
   · 칸: data-f = 이 양식의 칸, data-co = 회사 정보, 표의 줄은 data-r(#rows 안). 숫자칸에 0을 미리 넣지 않는다. */
const FORM = (() => {
  const CO_KEY = "tk_form_company";
  const CO_DEFAULT = { name: "투어코리아 (TOURKOREA)", en: "We've Tour Thailand" };
  const SYM = { KRW: "원", THB: "밧", USD: "$" };
  let cfg, d, co;
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const get = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const today = () => { const t = new Date(); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 10); };
  function money(n){
    const c = (d && d.cur) || "KRW", v = Math.round((+n || 0) * (c === "USD" ? 100 : 1)) / (c === "USD" ? 100 : 1);
    return c === "USD" ? "$" + v.toLocaleString("en-US") : v.toLocaleString("ko-KR") + SYM[c];
  }
  const lineAmt = r => (r.qty === "" || r.qty == null ? 1 : +r.qty || 0) * (+r.unit || 0);
  function fresh(){
    const o = Object.assign({ date: today(), cur: "KRW", rows: [] }, cfg.fresh ? cfg.fresh() : {});
    for (let i = 0; i < (cfg.startRows || 3); i++) o.rows.push(Object.assign({}, cfg.blankRow));
    return o;
  }
  const save = () => { put(cfg.key, d); put(CO_KEY, co); };
  function grow(t){
    if (t.tagName !== "TEXTAREA" || t.rows !== 1) return;
    t.style.height = "";
    if (t.value.includes("\n") || t.scrollHeight > t.clientHeight + 2) t.style.height = t.scrollHeight + "px";
  }
  function drawRows(){
    const tb = document.getElementById("rows");
    tb.innerHTML = d.rows.map((r, i) => cfg.row(r, i)).join("");
    tb.querySelectorAll("textarea").forEach(grow);
    after();
  }
  /* 빈 날짜칸은 인쇄하면 「연도-월-일」이 찍힌다 — 표시해 두고 인쇄 때 감춘다 */
  function after(){
    document.querySelectorAll('input[type=date]').forEach(el => el.classList.toggle("empty", !el.value));
    if (cfg.after) cfg.after(d);
  }
  function fill(){
    document.querySelectorAll("[data-f]").forEach(el => { el.value = d[el.dataset.f] == null ? "" : d[el.dataset.f]; });
    document.querySelectorAll("[data-co]").forEach(el => { el.value = co[el.dataset.co] == null ? "" : co[el.dataset.co]; });
    const cur = document.getElementById("cur"); if (cur) cur.value = d.cur || "KRW";
    if (cfg.fill) cfg.fill(d);
    drawRows();
  }
  function init(c){
    cfg = c;
    d = get(cfg.key) || fresh();
    if (!Array.isArray(d.rows)) d.rows = [];
    co = Object.assign({}, CO_DEFAULT, get(CO_KEY) || {});
    document.addEventListener("input", e => {
      const t = e.target, ds = t.dataset || {};
      if (ds.f) d[ds.f] = t.value;
      else if (ds.co) co[ds.co] = t.value;
      else if (ds.r) { const tr = t.closest("[data-i]"); const r = tr && d.rows[+tr.dataset.i]; if (!r) return; r[ds.r] = t.value; grow(t); }
      else if (t.id === "cur") d.cur = t.value;
      else return;
      save(); after();
    });
    document.addEventListener("click", e => {
      const del = e.target.closest("[data-del]");
      if (del) { d.rows.splice(+del.dataset.del, 1); save(); drawRows(); return; }
      if (e.target.id === "bAdd") { d.rows.push(Object.assign({}, cfg.blankRow)); save(); drawRows(); return; }
      if (e.target.id === "bNew") {
        if (!confirm("지금 쓰던 내용을 지우고 새로 쓸까요?\n(회사 정보는 그대로 남습니다)")) return;
        d = fresh(); save(); fill();
      }
    });
    fill();
  }
  return { init, esc, money, lineAmt, save, redraw: drawRows, get d(){ return d; } };
})();
