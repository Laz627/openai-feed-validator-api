// ===== DOM helpers =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ===== Tabs & Panels =====
const tabValidate = $("#tab-validate");
const tabSpec = $("#tab-spec");
const panelValidate = $("#panel-validate");
const panelSpec = $("#panel-spec");

function setActiveTab(tab, panel, active){
  if(!tab || !panel) return;
  tab.setAttribute("aria-selected", String(active));
  if(active){
    panel.classList.remove("hidden");
    requestAnimationFrame(() => panel.classList.add("visible"));
  }else{
    panel.classList.remove("visible");
    panel.classList.add("hidden");
  }
}

function showTab(which){
  const isValidate = which === "validate";
  setActiveTab(tabValidate, panelValidate, isValidate);
  setActiveTab(tabSpec, panelSpec, !isValidate);
}

tabValidate?.addEventListener("click", () => showTab("validate"));
tabSpec?.addEventListener("click", () => showTab("spec"));

// ===== Validation wiring =====
const fileInput = $("#file-input");
const delimiterInput = $("#delimiter");
const encodingInput = $("#encoding");
const btnValidate = $("#btn-validate-file");
const btnBrowse = $("#btn-browse");
const dropZone = $("#drop-zone");
const selectedFileLabel = $("#selected-file");
const statusBox = $("#status");
const resultsWrap = $("#results");
const summaryTruncate = $("#summary-truncate");
const issuesTable = document.querySelector("#results table.issues");
const issuesBody = $("#issues-body");
const noteTruncate = $("#note-truncate");
const noResultsEl = $("#no-results");
const noIssuesEl = $("#no-issues");
const btnNoIssuesJson = $("#btn-noissues-json");
const btnNoIssuesCsv = $("#btn-noissues-csv");
const specFilterEl = $("#spec-filter");
const filterSearchInput = $("#filter-search");
const severityChips = $$(".chip");
const btnJson = $("#btn-download-json");
const btnCsv = $("#btn-download-csv");
const countAll = $("#count-all");
const countError = $("#count-error");
const countWarning = $("#count-warning");
const countOpportunity = $("#count-opportunity");
const stepOne = $(".step-1");
const stepTwo = $(".step-2");
const stepThree = $(".step-3");

let lastResult = null;
let allIssues = [];
let filterSeverity = "all";
let searchTerm = "";
let specFilter = null;
let validateLabel = btnValidate?.textContent || "Validate";

function escapeHtml(value){
  if(value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value){
  return escapeHtml(value).replace(/\n/g, " &#10;");
}

function formatBytes(bytes){
  if(!Number.isFinite(bytes)) return "";
  if(bytes < 1024) return `${bytes} B`;
  const units = ["KB","MB","GB"]; let idx = 0; let num = bytes / 1024;
  while(num >= 1024 && idx < units.length - 1){ num /= 1024; idx += 1; }
  return `${num.toFixed(num >= 10 ? 0 : 1)} ${units[idx]}`;
}

function updateSelectedFile(){
  if(!selectedFileLabel) return;
  if(fileInput?.files?.length){
    const file = fileInput.files[0];
    const size = formatBytes(file.size);
    selectedFileLabel.textContent = size ? `${file.name} (${size})` : file.name;
    updateStepState("file-chosen");
  }else{
    selectedFileLabel.textContent = "No file selected yet.";
    updateStepState("ready");
  }
}

function updateStepState(state){
  const steps = [stepOne, stepTwo, stepThree];
  steps.forEach((step) => step?.classList.remove("current", "complete"));
  switch(state){
    case "file-chosen":
      stepOne?.classList.add("complete");
      stepTwo?.classList.add("current");
      break;
    case "validating":
      stepOne?.classList.add("complete");
      stepTwo?.classList.add("current");
      break;
    case "success":
      stepOne?.classList.add("complete");
      stepTwo?.classList.add("complete");
      stepThree?.classList.add("current");
      break;
    case "error":
      stepOne?.classList.add("complete");
      stepTwo?.classList.add("current");
      break;
    default:
      stepOne?.classList.add("current");
  }
}

function setValidateLoading(isLoading){
  if(!btnValidate) return;
  btnValidate.disabled = isLoading;
  btnValidate.textContent = isLoading ? "Validating…" : validateLabel;
}

function setDownloadsEnabled(enabled){
  [btnJson, btnCsv, btnNoIssuesJson, btnNoIssuesCsv].forEach((btn) => {
    if(btn){ btn.disabled = !enabled; }
  });
}

function renderStatus({ type = "info", title = "", subtitle = "", spinner = false } = {}){
  if(!statusBox) return;
  if(!title && !subtitle){
    statusBox.classList.add("hidden");
    statusBox.classList.remove("error", "success");
    statusBox.innerHTML = "";
    return;
  }
  statusBox.classList.remove("hidden", "error", "success");
  if(type === "success"){
    statusBox.classList.add("success");
  }else if(type === "error"){
    statusBox.classList.add("error");
  }
  const icon = type === "success" ? "✅" : type === "error" ? "⚠️" : "ℹ️";
  const iconHtml = spinner ? '<div class="spinner" role="status" aria-label="Validating"></div>' : `<span class="status-icon">${icon}</span>`;
  statusBox.innerHTML = `
    <div class="status-card">
      ${iconHtml}
      <div>
        ${title ? `<p class="status-title">${escapeHtml(title)}</p>` : ""}
        ${subtitle ? `<p class="status-subtitle">${escapeHtml(subtitle)}</p>` : ""}
      </div>
    </div>
  `;
}

function resetResults(){
  resultsWrap?.classList.add("hidden");
  issuesTable?.classList.remove("is-hidden");
  if(issuesBody) issuesBody.innerHTML = "";
  noResultsEl?.classList.add("hidden");
  noIssuesEl?.classList.add("hidden");
  specFilterEl?.classList.add("hidden");
  specFilterEl && (specFilterEl.innerHTML = "");
  noteTruncate?.classList.add("hidden");
  summaryTruncate?.classList.add("hidden");
  allIssues = [];
  filterSeverity = "all";
  searchTerm = "";
  specFilter = null;
  filterSearchInput && (filterSearchInput.value = "");
  severityChips.forEach((chip) => chip.classList.toggle("active", chip.dataset.severity === "all"));
  updateChipCounts();
}

function updateChipCounts(){
  if(!countAll || !countError || !countWarning) return;
  const errorCount = allIssues.filter((issue) => (issue.severity || "").toLowerCase() === "error").length;
  const warningCount = allIssues.filter((issue) => (issue.severity || "").toLowerCase() === "warning").length;
  const opportunityCount = allIssues.filter((issue) => (issue.severity || "").toLowerCase() === "opportunity").length;
  countAll.textContent = allIssues.length.toLocaleString();
  countError.textContent = errorCount.toLocaleString();
  countWarning.textContent = warningCount.toLocaleString();
  if(countOpportunity){
    countOpportunity.textContent = opportunityCount.toLocaleString();
  }
}

function applyFilters(){
  if(!issuesBody) return;
  const limit = 1000;
  let filtered = allIssues;
  if(filterSeverity !== "all"){
    filtered = filtered.filter((issue) => (issue.severity || "").toLowerCase() === filterSeverity);
  }
  if(searchTerm){
    const q = searchTerm.toLowerCase();
    filtered = filtered.filter((issue) => {
      return [
        issue.row_index,
        issue.item_id,
        issue.field,
        issue.rule_id,
        issue.message,
        issue.sample_value
      ].some((val) => val !== undefined && val !== null && String(val).toLowerCase().includes(q));
    });
  }
  if(specFilter){
    const needle = specFilter.query.toLowerCase();
    filtered = filtered.filter((issue) => {
      return [issue.field, issue.rule_id, issue.rule_text]
        .some((val) => val && String(val).toLowerCase().includes(needle));
    });
  }

  const hasIssues = allIssues.length > 0;
  const hadFilters = filterSeverity !== "all" || !!searchTerm || !!specFilter;
  const showNoResults = hasIssues && filtered.length === 0 && hadFilters;

  noResultsEl?.classList.toggle("hidden", !showNoResults);
  issuesTable?.classList.toggle("is-hidden", !hasIssues || filtered.length === 0);

  if(filtered.length === 0){
    issuesBody.innerHTML = "";
  }else{
    const slice = filtered.slice(0, limit);
    issuesBody.innerHTML = slice.map((issue, idx) => {
      const rowIndex = typeof issue.row_index === "number" ? issue.row_index + 1 : issue.row_index ?? "";
      const rowDisplay = rowIndex === "" || rowIndex === null || rowIndex === undefined ? "—" : rowIndex;
      const severity = (issue.severity || "info").toLowerCase();
      const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
      const ruleId = issue.rule_id ?? "";
      const tooltip = issue.rule_text || issue.message || ruleId;
      const itemId = issue.item_id ?? "";
      const itemDisplay = itemId ? itemId : "—";
      const sampleValue = issue.sample_value ?? "";
      const sampleContent = sampleValue
        ? `<span class="sample-value">${escapeHtml(sampleValue)}</span><button type="button" class="copy-btn" data-copy="${escapeAttr(sampleValue)}" aria-label="Copy sample value">Copy</button>`
        : '<span class="muted">—</span>';
      return `
        <tr>
          <td class="sticky-col col-index" data-label="#">${escapeHtml(rowDisplay)}</td>
          <td class="sticky-col col-item" data-label="Item ID">${escapeHtml(itemDisplay)}</td>
          <td data-label="Field">${escapeHtml(issue.field ?? "")}</td>
          <td data-label="Rule"><span class="rule-id" title="${escapeAttr(tooltip)}">${escapeHtml(ruleId)}</span></td>
          <td data-label="Severity"><span class="sev-${escapeHtml(severity)}">${escapeHtml(severityLabel)}</span></td>
          <td data-label="Message">${escapeHtml(issue.message ?? "")}</td>
          <td data-label="Sample" class="sample-cell">${sampleContent}</td>
        </tr>
      `;
    }).join("");
    noteTruncate?.classList.toggle("hidden", filtered.length <= limit);
  }
  if(noteTruncate){
    noteTruncate.classList.add("hidden");
  }
}

function renderResults(data){
  lastResult = data;
  allIssues = Array.isArray(data?.issues) ? data.issues : [];
  updateChipCounts();

  const summary = data?.summary || {};

  const truncated = Boolean(
    summary.truncated ||
    summary.items_truncated ||
    summary.rows_truncated ||
    summary.items_sampled === 50000 ||
    data?.truncated ||
    (typeof summary.items_total === "number" && summary.items_total >= 50000)
  );
  summaryTruncate?.classList.toggle("hidden", !truncated);

  if(resultsWrap){
    resultsWrap.classList.remove("hidden");
  }

  if(allIssues.length === 0){
    issuesTable?.classList.add("is-hidden");
    noIssuesEl?.classList.remove("hidden");
  }else{
    issuesTable?.classList.remove("is-hidden");
    noIssuesEl?.classList.add("hidden");
  }

  applyFilters();
  setDownloadsEnabled(true);
  updateStepState("success");
}

function handleDownloadJson(){
  if(!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "validation.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function handleDownloadCsv(){
  if(!lastResult) return;
  const issues = lastResult.issues || [];
  const head = ["row_index", "item_id", "field", "rule_id", "severity", "message", "sample_value"];
  const csvLines = [head.join(",")].concat(
    issues.map((issue) => head.map((key) => JSON.stringify(issue[key] ?? "")).join(","))
  );
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "validation.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function handleValidateClick(event){
  event.preventDefault();
  if(!fileInput || !fileInput.files || fileInput.files.length === 0){
    renderStatus({ type: "error", title: "No file selected", subtitle: "Please add a feed file before validating." });
    updateStepState("ready");
    return;
  }

  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append("file", file);
  if(delimiterInput){
    formData.append("delimiter", delimiterInput.value || "");
  }
  if(encodingInput){
    formData.append("encoding", encodingInput.value || "utf-8");
  }

  setDownloadsEnabled(false);
  resetResults();
  renderStatus({ type: "info", title: "Validating…", subtitle: "Hang tight while we check your feed.", spinner: true });
  setValidateLoading(true);
  updateStepState("validating");

  try{
    const response = await fetch("/validate/file", { method: "POST", body: formData });
    const raw = await response.text();
    let payload = null;
    try{
      payload = raw ? JSON.parse(raw) : null;
    }catch(parseError){
      payload = null;
    }
    if(!response.ok){
      const detail = payload?.detail || payload?.error || raw || response.statusText;
      throw new Error(detail);
    }
    if(!payload){
      throw new Error("Unexpected empty response from validator.");
    }
    renderResults(payload);
    renderStatus({ type: "success", title: "Validation complete.", subtitle: "Validation complete." });
  }catch(err){
    renderStatus({ type: "error", title: "Validation failed", subtitle: err?.message || String(err) });
    updateStepState("error");
  }finally{
    setValidateLoading(false);
  }
}

function handleDrop(event){
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if(files && files.length){
    fileInput.files = files;
    updateSelectedFile();
  }
  dropZone?.classList.remove("dragging");
}

function initDragAndDrop(){
  if(!dropZone) return;
  ["dragenter", "dragover"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((type) => {
    dropZone.addEventListener(type, () => dropZone.classList.remove("dragging"));
  });
  dropZone.addEventListener("drop", handleDrop);
  dropZone.addEventListener("keydown", (event) => {
    if(event.key === "Enter" || event.key === " "){
      event.preventDefault();
      fileInput?.click();
    }
  });
  dropZone.addEventListener("click", (event) => {
    if(event.target !== btnBrowse){
      fileInput?.click();
    }
  });
}

function initFilters(){
  severityChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      severityChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      filterSeverity = chip.dataset.severity || "all";
      applyFilters();
    });
  });
  filterSearchInput?.addEventListener("input", (event) => {
    searchTerm = event.target.value.trim();
    applyFilters();
  });
}

function initCopyButtons(){
  document.addEventListener("click", async (event) => {
    const target = event.target;
    if(!(target instanceof HTMLElement)) return;
    if(target.classList.contains("copy-btn")){
      const value = target.dataset.copy ?? "";
      try{
        await navigator.clipboard.writeText(value.replace(/ &#10;/g, "\n"));
        target.textContent = "Copied";
        setTimeout(() => { target.textContent = "Copy"; }, 1600);
      }catch(err){
        target.textContent = "Copy failed";
        setTimeout(() => { target.textContent = "Copy"; }, 1600);
      }
    }
  });
}

function setSpecFilter(field){
  specFilter = field ? { label: field.name, query: field.rule || field.name } : null;
  if(!specFilterEl) return;
  if(!specFilter){
    specFilterEl.classList.add("hidden");
    specFilterEl.innerHTML = "";
  }else{
    specFilterEl.classList.remove("hidden");
    specFilterEl.innerHTML = `
      <span>Filtering by <strong>${escapeHtml(specFilter.label)}</strong></span>
      <button type="button" class="btn small clear">Clear</button>
    `;
    const clearBtn = specFilterEl.querySelector(".clear");
    clearBtn?.addEventListener("click", () => {
      setSpecFilter(null);
      applyFilters();
    });
  }
}

const SPEC_FIELDS = [
  { name: "enable_search", description: "Boolean flag that makes the item discoverable across OpenAI surfaces.", importance: "required", dependencies: "Required for checkout and discovery." },
  { name: "enable_checkout", description: "Allows assistant-led checkout flows for the item.", importance: "conditional", dependencies: "Requires enable_search = true." },
  { name: "id", description: "Stable unique identifier used to reconcile updates.", importance: "required", dependencies: "No additional dependencies." },
  { name: "title", description: "Product name surfaced in chat results and product cards.", importance: "required", dependencies: "Plain text ≤ 150 characters." },
  { name: "description", description: "Human-readable description that powers summarisation.", importance: "required", dependencies: "Plain text without HTML." },
  { name: "link", description: "HTTPS URL to the canonical product detail page.", importance: "required", dependencies: "Must use https://." },
  { name: "product_category", description: "Taxonomy path separated with > tokens.", importance: "required", dependencies: "Follow OpenAI commerce taxonomy." },
  { name: "brand", description: "Brand or manufacturer displayed alongside the title.", importance: "required", dependencies: "No additional dependencies." },
  { name: "material", description: "Primary material so the assistant can answer build questions.", importance: "required", dependencies: "Provide unit or composition where relevant." },
  { name: "weight", description: "Shipping or packaged weight with unit.", importance: "required", dependencies: "Requires value + unit (lb, kg, g, oz)." },
  { name: "image_link", description: "Primary product image URL shown in shopping surfaces.", importance: "required", dependencies: "Must be an https URL." },
  { name: "price", description: "Item price formatted as <amount> <ISO currency>.", importance: "required", dependencies: "Currency must be ISO 4217." },
  { name: "availability", description: "Inventory state (in_stock, out_of_stock, preorder).", importance: "required", dependencies: "If preorder, include availability_date." },
  { name: "inventory_quantity", description: "Available quantity for stock messaging.", importance: "required", dependencies: "Integer ≥ 0." },
  { name: "seller_name", description: "Merchant or storefront display name.", importance: "required", dependencies: "No additional dependencies." },
  { name: "seller_url", description: "Merchant homepage or support URL.", importance: "required", dependencies: "Must be an https URL." },
  { name: "return_policy", description: "Public return policy URL for compliance.", importance: "required", dependencies: "Must be accessible over https." },
  { name: "return_window", description: "Number of days a customer can initiate a return.", importance: "required", dependencies: "Integer ≥ 0." },
  { name: "sale_price", description: "Discounted price that complements the primary price.", importance: "conditional", dependencies: "Requires sale_price_effective_date and ≤ price." },
  { name: "sale_price_effective_date", description: "Start/end date range for sale pricing.", importance: "conditional", dependencies: "Format YYYY-MM-DD / YYYY-MM-DD." },
  { name: "unit_pricing_measure", description: "Measurement used to compute unit price (e.g., 750 ml).", importance: "conditional", dependencies: "Requires base_measure." },
  { name: "base_measure", description: "Reference measure that pairs with unit_pricing_measure.", importance: "conditional", dependencies: "Requires unit_pricing_measure." },
  { name: "availability_date", description: "Date the item becomes available to ship.", importance: "conditional", dependencies: "Required when availability = preorder." },
  { name: "gtin", description: "Global Trade Item Number to map listings to canonical products.", importance: "recommended", dependencies: "Digits only (8, 12, 13, or 14)." },
  { name: "mpn", description: "Manufacturer Part Number when no GTIN exists.", importance: "recommended", dependencies: "No additional dependencies." },
  { name: "additional_image_link", description: "Comma-separated list of extra image URLs.", importance: "recommended", dependencies: "Use https URLs separated by commas." },
  { name: "video_link", description: "Marketing or demo video URL.", importance: "recommended", dependencies: "https URL preferred." },
  { name: "model_3d_link", description: "3D model preview (GLB/USDZ).", importance: "recommended", dependencies: "File must be publicly accessible." },
  { name: "item_group_id", description: "Identifier tying variants together.", importance: "conditional", dependencies: "Required when color/size/gender present." },
  { name: "color", description: "Variant color label for conversational selection.", importance: "recommended", dependencies: "Requires item_group_id when used." },
  { name: "size", description: "Variant size label (e.g., M, 8.5).", importance: "recommended", dependencies: "Requires item_group_id when used." },
  { name: "size_system", description: "Sizing system (US, EU, JP).", importance: "recommended", dependencies: "Requires item_group_id when used." },
  { name: "gender", description: "Intended gender (male, female, unisex).", importance: "recommended", dependencies: "Requires item_group_id when used." },
  { name: "pickup_method", description: "Supported pickup option (in_store, reserve, not_supported).", importance: "recommended", dependencies: "If pickup supported, include pickup_sla." },
  { name: "pickup_sla", description: "Fulfilment lead time for pickup orders.", importance: "recommended", dependencies: "Used when pickup_method ≠ not_supported." },
  { name: "shipping", description: "Structured shipping cost details.", importance: "recommended", dependencies: "Include currency and region." },
  { name: "delivery_estimate", description: "Estimated delivery windows or speed promises.", importance: "recommended", dependencies: "No additional dependencies." },
  { name: "seller_privacy_policy", description: "Privacy policy URL required for checkout listings.", importance: "conditional", dependencies: "Required when enable_checkout = true." },
  { name: "seller_tos", description: "Terms of service URL for checkout listings.", importance: "conditional", dependencies: "Required when enable_checkout = true." },
  { name: "warning", description: "Safety or regulatory warning copy.", importance: "recommended", dependencies: "Include warning_url for detailed info." },
  { name: "warning_url", description: "Link to detailed compliance or safety documentation.", importance: "recommended", dependencies: "https URL recommended." },
  { name: "product_review_count", description: "Number of product-level reviews.", importance: "recommended", dependencies: "Integer ≥ 0." },
  { name: "product_review_rating", description: "Average product rating value.", importance: "recommended", dependencies: "0.0 – 5.0 scale." },
  { name: "store_review_count", description: "Number of merchant/store reviews.", importance: "recommended", dependencies: "Integer ≥ 0." },
  { name: "store_review_rating", description: "Average merchant/store rating.", importance: "recommended", dependencies: "0.0 – 5.0 scale." },
  { name: "related_product_id", description: "Identifier of complementary or substitute items.", importance: "recommended", dependencies: "Pair with relationship_type." },
  { name: "relationship_type", description: "Relationship (part_of_set, accessory, etc.).", importance: "recommended", dependencies: "Used with related_product_id." }
];

const specGrid = $("#spec-grid");
function renderSpecGrid(){
  if(!specGrid) return;
  specGrid.innerHTML = SPEC_FIELDS.map((field) => {
    const badgeLabel = field.importance.charAt(0).toUpperCase() + field.importance.slice(1);
    const dependencyText = field.dependencies || "No additional dependencies.";
    return `
      <button type="button" class="spec-card" data-field="${escapeAttr(field.name)}" data-rule="${escapeAttr(field.rule || field.name)}">
        <span class="badge ${escapeHtml(field.importance)}">${escapeHtml(badgeLabel)}</span>
        <span class="field-name">${escapeHtml(field.name)}</span>
        <p class="field-desc">${escapeHtml(field.description)}</p>
        <p class="dependencies">${escapeHtml(dependencyText)}</p>
      </button>
    `;
  }).join("");
  specGrid.addEventListener("click", (event) => {
    const target = event.target.closest(".spec-card");
    if(!(target instanceof HTMLElement)) return;
    const name = target.dataset.field;
    const rule = target.dataset.rule;
    setSpecFilter({ name, rule });
    applyFilters();
    showTab("validate");
  });
}

function initSpecFilterKeyboard(){
  specGrid?.addEventListener("keydown", (event) => {
    if(!(event.target instanceof HTMLElement)) return;
    if(!event.target.classList.contains("spec-card")) return;
    if(event.key === "Enter" || event.key === " "){
      event.preventDefault();
      event.target.click();
    }
  });
}

btnBrowse?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", updateSelectedFile);
btnJson?.addEventListener("click", handleDownloadJson);
btnCsv?.addEventListener("click", handleDownloadCsv);
btnNoIssuesJson?.addEventListener("click", handleDownloadJson);
btnNoIssuesCsv?.addEventListener("click", handleDownloadCsv);
btnValidate?.addEventListener("click", handleValidateClick);

initDragAndDrop();
initFilters();
initCopyButtons();
renderSpecGrid();
initSpecFilterKeyboard();
updateSelectedFile();
setDownloadsEnabled(false);
updateStepState("ready");
updateChipCounts();

const yearEl = $("#year");
if(yearEl){
  yearEl.textContent = String(new Date().getFullYear());
}

showTab("validate");
