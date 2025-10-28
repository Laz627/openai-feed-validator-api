
// ===== Robust two-tab controller and validator wiring =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Tabs & Panels
const tabValidate = $("#tab-validate");
const tabSpec = $("#tab-spec");
const panelValidate = $("#panel-validate");
const panelSpec = $("#panel-spec");

function showTab(which){
  [panelValidate, panelSpec].forEach(p => p && p.classList.add("hidden"));
  [tabValidate, tabSpec].forEach(t => t && t.classList.remove("active"));
  if(which === "validate"){
    panelValidate && panelValidate.classList.remove("hidden");
    tabValidate && tabValidate.classList.add("active");
  } else {
    panelSpec && panelSpec.classList.remove("hidden");
    tabSpec && tabSpec.classList.add("active");
  }
}

tabValidate && tabValidate.addEventListener("click", () => showTab("validate"));
tabSpec && tabSpec.addEventListener("click", () => showTab("spec"));

// ===== Validation wiring =====
const form = $("#upload-form");
const fileInput = $("#file-input");
const resultsDiv = $("#results");
const resultsSummary = $("#results-summary");
const itemNote = $("#item-note");
const btnJson = $("#btn-download-json");
const btnCsv = $("#btn-download-csv");

let lastResult = null;

function setLoading(isLoading){
  if(isLoading){
    resultsSummary && (resultsSummary.textContent = "Validating…");
  }
}

function renderResults(data){
  lastResult = data;
  const { summary, issues } = data;
  const text = `${summary.items_total} items, ${summary.items_with_warnings} warnings, ${summary.items_with_errors} errors`;
  resultsSummary && (resultsSummary.textContent = text);
  if(itemNote) itemNote.style.display = "block";

  // Build a simple table of issues
  if(!issues || issues.length === 0){
    resultsDiv.innerHTML = "<p>✅ No issues found.</p>";
  } else {
    const header = ["Row","Item ID","Field","Rule","Severity","Message","Sample"];
    const rows = issues.map(it => `<tr>
      <td>${it.row_index ?? ""}</td>
      <td>${it.item_id ?? ""}</td>
      <td>${it.field}</td>
      <td>${it.rule_id}</td>
      <td class="${it.severity}">${it.severity}</td>
      <td>${it.message}</td>
      <td>${it.sample_value ?? ""}</td>
    </tr>`).join("");
    resultsDiv.innerHTML = `<table class="results">
      <thead><tr>${header.map(h=>`<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Enable downloads
  [btnJson, btnCsv].forEach(b => b && (b.disabled = false));
}

// Downloads
btnJson && btnJson.addEventListener("click", () => {
  if(!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "validation.json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});
btnCsv && btnCsv.addEventListener("click", () => {
  if(!lastResult) return;
  const issues = lastResult.issues || [];
  const head = ["row_index","item_id","field","rule_id","severity","message","sample_value"];
  const csv = [head.join(",")].concat(issues.map(it => head.map(k => JSON.stringify(it[k] ?? "")).join(","))).join("\n");
  const blob = new Blob([csv], {type: "text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "validation.csv";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

// Submit handler
form && form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if(!fileInput || !fileInput.files || fileInput.files.length === 0){
    resultsDiv.innerHTML = "<p>Please choose a file.</p>";
    return;
  }
  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append("file", file);

  setLoading(true);
  try{
    const res = await fetch("/validate/file", { method: "POST", body: formData });
    const data = await res.json();
    if(!res.ok) throw new Error(data?.detail || data?.error || res.statusText);
    renderResults(data);
  }catch(err){
    resultsDiv.innerHTML = `<p class="error">Validation failed: ${String(err)}</p>`;
  }finally{
    setLoading(false);
  }
});

// Initial
showTab("validate");
