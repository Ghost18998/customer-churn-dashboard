// Customer Churn Intelligence Dashboard (client-side)
// Pipeline: filter → KPI → cohorts → drivers (lift) → risk scoring → explainability → what-if ROI

const $ = (id) => document.getElementById(id);
const worker = new Worker("worker.js");
function animateNumber(el, from, to, formatFn, ms = 550) {
  const start = performance.now();
  const diff = to - from;

  function tick(now) {
    const t = Math.min(1, (now - start) / ms);
    // smoothstep easing
    const eased = t * t * (3 - 2 * t);
    const val = from + diff * eased;
    el.textContent = formatFn(val);
    if (t < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

function readNumber(el, fallback = 0) {
  const raw = (el.textContent || "").replace(/[^0-9.\-]/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

worker.onmessage = (e) => {
  const { count, churn, avgMonthly } = e.data;

  // Customers
  const cEl = $("kCustomers");
  const cFrom = readNumber(cEl, 0);
  animateNumber(cEl, cFrom, count, v => Math.round(v).toLocaleString());

  // Churn %
  const chEl = $("kChurn");
  const chFrom = readNumber(chEl, 0);
  animateNumber(chEl, chFrom, churn, v => v.toFixed(1) + "%");

  // $ Monthly
  const mEl = $("kMonthly");
  const mFrom = readNumber(mEl, 0);
  animateNumber(mEl, mFrom, avgMonthly, v => "$" + v.toFixed(2));
};

// ---- Demo data generator (makes it feel BIG) ----
// Creates 1200 synthetic customers with realistic churn correlations.
function seededRandom(seed){
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = s * 16807 % 2147483647) / 2147483647;
}

function makeDemoData(n = 1200){
  const rand = seededRandom(71313);
  const pick = (arr, wts) => {
    const t = wts.reduce((a,b)=>a+b,0);
    let r = rand() * t;
    for (let i=0;i<arr.length;i++){
      r -= wts[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length-1];
  };

  const rows = [];
  for (let i=0;i<n;i++){
    const contract = pick(["Month-to-month","One year","Two year"], [0.56,0.24,0.20]);
    const internet = pick(["Fiber optic","DSL","None"], [0.48,0.38,0.14]);
    const senior = rand() < 0.16 ? 1 : 0;

    // tenure distribution skewed
    const tenure = Math.max(1, Math.min(72, Math.round(Math.pow(rand(), 1.8) * 72)));

    // monthly charges by internet + add noise
    let base = internet === "Fiber optic" ? 92 : internet === "DSL" ? 62 : 28;
    base += (contract === "Month-to-month") ? 6 : (contract === "Two year") ? -4 : 0;
    base += senior ? 2 : 0;
    const monthly = Math.max(18, Math.min(120, base + (rand()*18 - 9)));

    // churn probability model (this is the "engine")
    let p = 0.10;
    if (contract === "Month-to-month") p += 0.18; else if (contract === "One year") p += 0.06; else p += 0.02;
    if (internet === "Fiber optic") p += 0.08; else if (internet === "DSL") p += 0.03;
    if (tenure <= 3) p += 0.16;
    else if (tenure <= 6) p += 0.10;
    else if (tenure <= 12) p += 0.06;
    if (monthly >= 90) p += 0.06;
    if (senior) p += 0.03;

    // cap
    p = Math.max(0.02, Math.min(0.65, p));
    const churn = rand() < p;

    rows.push({
      customerID: String(i+1).padStart(4,"0") + "-" + Math.floor(rand()*9000+1000),
      contract, internet, senior,
      tenure,
      monthly: Number(monthly.toFixed(2)),
      churn
    });
  }
  return rows;
}

// ---- Core analytics helpers ----
function churnRate(rows){
  if (!rows.length) return 0;
  return (rows.filter(r => r.churn).length / rows.length) * 100;
}
function avgMonthly(rows){
  if (!rows.length) return 0;
  return rows.reduce((s,r)=>s+r.monthly,0)/rows.length;
}
function groupBy(rows, keyFn){
  const m = {};
  rows.forEach(r=>{
    const k = keyFn(r);
    (m[k] ||= []).push(r);
  });
  return m;
}
function tenureBucket(t){
  if (t<=3) return "0–3";
  if (t<=6) return "4–6";
  if (t<=12) return "7–12";
  if (t<=24) return "13–24";
  return "25+";
}

function renderBars(containerId, grouped, order){
  const el = $(containerId);
  el.innerHTML = "";
  const keys = order ?? Object.keys(grouped);

  keys.forEach(k=>{
    const rows = grouped[k] || [];
    const rate = churnRate(rows);
    const wrap = document.createElement("div");
    wrap.className = "barWrap";

    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = Math.max(8, rate*3) + "px";
    bar.title = `${k}: ${rate.toFixed(1)}% churn (n=${rows.length})`;

    const top = document.createElement("div");
    top.className = "barTop";
    top.textContent = rows.length ? rate.toFixed(0) + "%" : "—";

    const label = document.createElement("div");
    label.className = "barLabel";
    label.textContent = k;

    bar.appendChild(top);
    wrap.appendChild(bar);
    wrap.appendChild(label);
    el.appendChild(wrap);
  });
}

// ---- Lift + drivers ----
function computeDrivers(rows){
  const base = churnRate(rows) || 0.0001;

  const segs = [
    { name:"Month-to-month", rows: rows.filter(r=>r.contract==="Month-to-month") },
    { name:"Fiber optic", rows: rows.filter(r=>r.internet==="Fiber optic") },
    { name:"Tenure ≤ 6", rows: rows.filter(r=>r.tenure<=6) },
    { name:"Monthly ≥ 90", rows: rows.filter(r=>r.monthly>=90) },
    { name:"Senior citizen", rows: rows.filter(r=>r.senior===1) },
  ];

  return segs
    .map(s=>{
      const rate = churnRate(s.rows);
      const lift = rate / base;
      return { ...s, rate, lift, n:s.rows.length };
    })
    .filter(x=>x.n>=40)
    .sort((a,b)=> b.lift - a.lift)
    .slice(0,5);
}

// ---- Risk scoring + explainability ----
function riskScore(r){
  let score = 0;

  // Contract
  if (r.contract==="Month-to-month") score += 35;
  else if (r.contract==="One year") score += 16;
  else score += 6;

  // Tenure
  if (r.tenure<=3) score += 26;
  else if (r.tenure<=6) score += 18;
  else if (r.tenure<=12) score += 10;
  else if (r.tenure<=24) score += 6;

  // Internet
  if (r.internet==="Fiber optic") score += 14;
  else if (r.internet==="DSL") score += 6;

  // Charges
  if (r.monthly>=90) score += 14;
  else if (r.monthly>=70) score += 7;

  // Senior
  if (r.senior===1) score += 5;

  return Math.min(100, score);
}

function explain(r){
  const parts = [];
  const add = (label, pts) => parts.push({ label, pts });

  if (r.contract==="Month-to-month") add("Month-to-month contract", 35);
  else if (r.contract==="One year") add("One year contract", 16);
  else add("Two year contract", 6);

  if (r.tenure<=3) add("Tenure 0–3 months", 26);
  else if (r.tenure<=6) add("Tenure 4–6 months", 18);
  else if (r.tenure<=12) add("Tenure 7–12 months", 10);
  else if (r.tenure<=24) add("Tenure 13–24 months", 6);
  else add("Tenure 25+ months", 0);

  if (r.internet==="Fiber optic") add("Fiber optic", 14);
  else if (r.internet==="DSL") add("DSL", 6);
  else add("No internet", 0);

  if (r.monthly>=90) add("Monthly ≥ $90", 14);
  else if (r.monthly>=70) add("Monthly $70–$89", 7);
  else add("Monthly < $70", 0);

  if (r.senior===1) add("Senior citizen", 5);

  const total = parts.reduce((s,p)=>s+p.pts,0);
  parts.sort((a,b)=>b.pts-a.pts);

  return { total, parts };
}

// ---- What-if ROI ----
function simulateConversion(rows, pctToOne, pctToTwo){
  const current = churnRate(rows);

  const m2m = rows.filter(r=>r.contract==="Month-to-month");
  if (!m2m.length) return { current, simulated: current };

  const r1 = churnRate(rows.filter(r=>r.contract==="One year")) || (current*0.70);
  const r2 = churnRate(rows.filter(r=>r.contract==="Two year")) || (current*0.55);
  const rm = churnRate(m2m) || current;

  const p1 = Math.max(0, Math.min(.60, pctToOne/100));
  const p2 = Math.max(0, Math.min(.60, pctToTwo/100));
  const p0 = Math.max(0, 1 - p1 - p2);

  const newMRate = p0*rm + p1*r1 + p2*r2;

  const non = rows.filter(r=>r.contract!=="Month-to-month");
  const nonCh = (churnRate(non)/100)*non.length;

  const simulated = ((nonCh + (newMRate/100)*m2m.length) / rows.length) * 100;
  return { current, simulated };
}

// ---- App state ----
let DATA = [];
let selectedCustomer = null;

function applyFilters(rows){
  const c = $("fContract").value;
  const i = $("fInternet").value;
  const tMin = Number($("tMin").value || 0);
  const tMax = Number($("tMax").value || 72);

  return rows.filter(r=>{
    if (c!=="All" && r.contract!==c) return false;
    if (i!=="All" && r.internet!==i) return false;
    if (r.tenure < tMin || r.tenure > tMax) return false;
    return true;
  });
}

// KPIs now come from the Web Worker (async)
function renderKPIsFromWorker() {
  $("kCustomers").classList.add("loading");
$("kChurn").classList.add("loading");
$("kMonthly").classList.add("loading");

  worker.postMessage({
    rows: DATA,
    filters: {
      contract: $("fContract").value,
      internet: $("fInternet").value,
      tMin: Number($("tMin").value || 0),
      tMax: Number($("tMax").value || 72),
    }
  });
}

function renderCohorts(rows){
  renderBars("cTenure", groupBy(rows, r=>tenureBucket(r.tenure)), ["0–3","4–6","7–12","13–24","25+"]);
  renderBars("cContract", groupBy(rows, r=>r.contract), ["Month-to-month","One year","Two year"]);
  renderBars("cInternet", groupBy(rows, r=>r.internet), ["Fiber optic","DSL","None"]);
}

function renderDrivers(rows){
  const ol = $("drivers");
  ol.innerHTML = "";
  const base = churnRate(rows) || 0.0001;

  computeDrivers(rows).forEach(d=>{
    const li = document.createElement("li");
    li.textContent = `${d.name}: ${d.rate.toFixed(1)}% churn (lift x${(d.rate/base).toFixed(2)}, n=${d.n.toLocaleString()})`;
    ol.appendChild(li);
  });
}

function renderExplain(){
  const box = $("explainBox");
  if (!selectedCustomer){
    box.textContent = "Click a customer in the table to see why the score is high.";
    return;
  }
  const { total, parts } = explain(selectedCustomer);
  box.innerHTML = `
    <div style="color:#e5e7eb;font-weight:900;font-size:14px;margin-bottom:8px;">
      ${selectedCustomer.customerID} — Risk Score: ${total}
    </div>
    ${parts.filter(p=>p.pts>0).map(p=>`
      <div style="display:flex;justify-content:space-between;color:#94a3b8;margin:4px 0;">
        <span>${p.label}</span><span style="color:#e5e7eb;font-weight:800;">+${p.pts}</span>
      </div>
    `).join("")}
  `;
}

function renderRisk(rows){
  const cut = Number($("riskCut").value);
  $("riskCutLabel").textContent = String(cut);

  const tbody = $("riskRows");
  tbody.innerHTML = "";

  rows
    .map(r=>({ ...r, risk: riskScore(r) }))
    .sort((a,b)=> b.risk - a.risk)
    .slice(0, 80)
    .forEach(r=>{
      const tr = document.createElement("tr");
      const at = r.risk >= cut ? "Yes" : "No";
      tr.innerHTML = `
        <td>${r.customerID}</td>
        <td>${r.risk}</td>
        <td class="${at==="Yes" ? "badYes" : "badNo"}">${at}</td>
        <td>${r.contract}</td>
        <td>${r.tenure}</td>
        <td>$${r.monthly.toFixed(2)}</td>
        <td>${r.internet}</td>
        <td class="${r.churn ? "badYes" : "badNo"}">${r.churn ? "Yes" : "No"}</td>
      `;
      tr.addEventListener("click", ()=>{
        selectedCustomer = r;
        renderExplain();
      });
      tbody.appendChild(tr);
    });
}

function renderWhatIf(rows){
  const p1 = Number($("wOne").value);
  const p2 = Number($("wTwo").value);
  const cost = Number($("wCost").value || 0);

  $("wOneLab").textContent = p1 + "%";
  $("wTwoLab").textContent = p2 + "%";

  const { current, simulated } = simulateConversion(rows, p1, p2);
  const delta = Math.max(0, current - simulated);

  const saved = Math.round((delta/100) * rows.length);
  const m2m = rows.filter(r=>r.contract==="Month-to-month").length;
  const converted = Math.round((p1+p2)/100 * m2m);
  const spend = converted * cost;

  // crude “value”: avg monthly * 6 months saved per prevented churn
  const value = saved * avgMonthly(rows) * 6;
  const roi = spend > 0 ? ((value - spend) / spend) * 100 : 0;

  $("wCur").textContent = current.toFixed(1) + "%";
  $("wNew").textContent = simulated.toFixed(1) + "%";
  $("wDelta").textContent = "−" + delta.toFixed(1) + " pts";
  $("wSaved").textContent = saved.toLocaleString();
  $("wROI").textContent = (spend>0 ? roi.toFixed(0)+"%" : "—");
}

function renderAll(){
  const rows = applyFilters(DATA);
  renderKPIsFromWorker();
  renderCohorts(rows);
  renderDrivers(rows);
  renderRisk(rows);
  renderWhatIf(rows);
  renderExplain();
}

// ---- Wiring ----
function wire(){
  ["fContract","fInternet","tMin","tMax","riskCut","wOne","wTwo","wCost"].forEach(id=>{
    $(id).addEventListener("input", renderAll);
    $(id).addEventListener("change", renderAll);
  });

  $("btnDemo").addEventListener("click", ()=>{
    DATA = makeDemoData(1200);
    selectedCustomer = null;
    renderAll();
  });

  $("btnReset").addEventListener("click", ()=>{
    $("fContract").value = "All";
    $("fInternet").value = "All";
    $("tMin").value = "0";
    $("tMax").value = "72";
    $("riskCut").value = "65";
    $("wOne").value = "15";
    $("wTwo").value = "10";
    $("wCost").value = "35";
    selectedCustomer = null;
    renderAll();
  });
}

// Boot
DATA = makeDemoData(1200);
wire();
renderAll();
