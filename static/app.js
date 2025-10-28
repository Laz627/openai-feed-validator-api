// Tabs
const $ = (s) => document.querySelector(s);
const tabValidate = $("#tab-validate");

const tabSpec = $("#tab-spec");
const panelValidate = $("#panel-validate");

const panelSpec = $("#panel-spec");

function showTab(which){
  [panelValidate, panelSpec].forEach(p=>p.classList.add("hidden"));
  [tabValidate, tabSpec].forEach(t=>t.classList.remove("active"));
  if(which==="validate"){ panelValidate.classList.remove("hidden"); tabValidate.classList.add("active"); }
  
  if(which==="spec"){ panelSpec.classList.remove("hidden"); tabSpec.classList.add("active"); }
}
tabValidate.addEventListener("click", ()=>showTab("validate"));
tabUrl.addEventListener("click", ()=>showTab("url"));
tabSpec.addEventListener("click", ()=>showTab("spec"));
document.querySelector("#year").textContent = new Date().getFullYear();

// Status
const statusBox = $("#status");
function setStatus(text, kind="info", loading=false){
  statusBox.innerHTML = `
    <div class="status-inner ${loading?"loading":""}">
      ${loading?'<div class="spinner"></div>':''}
      <span>${text}</span>
      ${loading?'<div class="bar"><div class="bar-fill"></div></div>':''}
    </div>`;
  statusBox.classList.remove("hidden");
  statusBox.classList.toggle("error", kind==="error");
}
function clearStatus(){ statusBox.classList.add("hidden"); statusBox.innerHTML=""; }

// Results
const resultsBox = $("#results");
const issuesBody = $("#issues-body");
const statTotal = $("#stat-total");
const statErrors = $("#stat-errors");
const statWarnings = $("#stat-warnings");
const statPass = $("#stat-pass");
const noteTruncate = $("#note-truncate");

function escapeHtml(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;"); }
function csvCell(v){ const s=String(v??""); return /[\",\n]/.test(s)?`"${s.replace(/\"/g,'\"\"')}"`:s; }

function downloadJSON(data){
  const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"),{href:url,download:"validation-report.json"});
  a.click(); URL.revokeObjectURL(url);
}
function downloadCSV(issues){
  const headers = ["row_index","item_id","field","rule_id","severity","message","sample_value"];
  const rows = issues.map(it => [
    it.row_index ?? "", it.item_id ?? "", it.field ?? "", it.rule_id ?? "", it.severity ?? "",
    String(it.message ?? "").replace(/\r?\n/g," ").trim(),
    it.sample_value ?? ""
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\n");
  const blob = new Blob([csv],{type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"),{href:url,download:"validation-issues.csv"});
  a.click(); URL.revokeObjectURL(url);
}
function renderResults(data){
  resultsBox.classList.remove("hidden");
  const {summary, issues} = data||{};
  statTotal.textContent = summary?.items_total ?? "-";
  statErrors.textContent = summary?.items_with_errors ?? "-";
  statWarnings.textContent = summary?.items_with_warnings ?? "-";
  statPass.textContent = summary?.pass_rate!=null ? (summary.pass_rate*100).toFixed(1)+"%" : "-";

  issuesBody.innerHTML = "";
  const maxRows = 1000;
  (issues||[]).slice(0,maxRows).forEach(it=>{
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${it.row_index ?? "-"}</td>
      <td>${it.item_id ?? "-"}</td>
      <td>${it.field}</td>
      <td>${it.rule_id}</td>
      <td class="${it.severity==="error"?"sev-error":"sev-warning"}">${it.severity}</td>
      <td>${escapeHtml(it.message||"")}</td>
      <td>${escapeHtml(it.sample_value ?? "")}</td>`;
    issuesBody.appendChild(tr);
  });
  noteTruncate.classList.toggle("hidden",(issues||[]).length<=maxRows);
  document.querySelector("#btn-download-json").onclick = ()=>downloadJSON(data);
  document.querySelector("#btn-download-csv").onclick = ()=>downloadCSV(issues||[]);
}

// File upload
document.querySelector("#btn-validate-file").addEventListener("click", async ()=>{
  try{
    clearStatus(); resultsBox.classList.add("hidden");
    const f = document.querySelector("#file-input").files[0];
    if(!f) return setStatus("Please choose a JSON/CSV/TSV file.","error");
    const form = new FormData();
    form.append("file", f);
    form.append("delimiter", document.querySelector("#delimiter").value || ",");
    form.append("encoding", document.querySelector("#encoding").value || "utf-8");
    setStatus("Validating file…","info",true);
    const res = await fetch("/validate/file",{method:"POST",body:form});
    const data = await res.json();
    if(!res.ok) throw new Error(data?.error || res.statusText);
    clearStatus(); renderResults(data);
  }catch(e){ setStatus(e?.message || "Validation failed.","error"); }
});

    let data = null;
    try { data = await res.json(); } catch(e) {
      const txt = await res.text();
      throw new Error(txt || res.statusText);
    }
    if(!res.ok) throw new Error((data && (data.detail || data.error)) || res.statusText);
    clearStatusUrl(); renderResults(data);
  }catch(e){
    const statusUrl = $("#status-url");
    statusUrl.classList.remove("hidden");
    statusUrl.innerHTML = `<div class="status-inner error"><span>${e?.message || "Validation failed."}</span></div>`;
  }
});

// Spec lists (kept in sync manually with backend constants)
const REQUIRED = [
  "enable_search","enable_checkout",
  "id","title","description","link",
  "product_category","brand","material","weight",
  "image_link","price",
  "availability","inventory_quantity",
  "seller_name","seller_url","return_policy","return_window",
];
const RECOMMENDED = [
  "gtin","mpn","condition","dimensions","length","width","height","age_group",
  "additional_image_link","video_link","model_3d_link",
  "applicable_taxes_fees","sale_price","sale_price_effective_date",
  "unit_pricing_measure","base_measure","pricing_trend",
  "availability_date","expiration_date",
  "pickup_method","pickup_sla",
  "item_group_id","item_group_title","color","size","size_system","gender","offer_id",
  "shipping","delivery_estimate",
  "seller_privacy_policy","seller_tos",
  "popularity_score","return_rate",
  "warning","warning_url","age_restriction",
  "product_review_count","product_review_rating","store_review_count","store_review_rating",
  "q_and_a","raw_review_data",
  "related_product_id","relationship_type",
  "geo_price","geo_availability",
];
function populateSpec(){
  const r = $("#req-list"), c = $("#rec-list");
  r.innerHTML = REQUIRED.map(f=>`<li><code>${f}</code></li>`).join("");
  c.innerHTML = RECOMMENDED.map(f=>`<li><code>${f}</code></li>`).join("");
}
populateSpec();
