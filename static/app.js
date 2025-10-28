// =========================
// static/app.js
// Handles tab switching, validation requests, results rendering, downloads,
// animated status, and populating the Spec tab.
// =========================

const $ = (sel) => document.querySelector(sel);

// Tabs
const tabValidate = $("#tab-validate");
const tabUrl = $("#tab-url");
const tabSpec = $("#tab-spec");

const panelValidate = $("#panel-validate");
const panelUrl = $("#panel-url");
const panelSpec = $("#panel-spec");

function showTab(which) {
  const allTabs = [tabValidate, tabUrl, tabSpec];
  const allPanels = [panelValidate, panelUrl, panelSpec];
  allTabs.forEach((t) => t.classList.remove("active"));
  allPanels.forEach((p) => p.classList.add("hidden"));
  if (which === "validate") {
    tabValidate.classList.add("active");
    panelValidate.classList.remove("hidden");
  } else if (which === "url") {
    tabUrl.classList.add("active");
    panelUrl.classList.remove("hidden");
  } else {
    tabSpec.classList.add("active");
    panelSpec.classList.remove("hidden");
  }
}
tabValidate.addEventListener("click", () => showTab("validate"));
tabUrl.addEventListener("click", () => showTab("url"));
tabSpec.addEventListener("click", () => showTab("spec"));

// Status / loader
const statusBox = $("#status");
function setStatus(text, kind = "info", loading = false) {
  statusBox.innerHTML = `
    <div class="status-inner ${loading ? "loading" : ""}">
      ${loading ? `<div class="spinner"></div>` : ""}
      <span>${text}</span>
      ${loading ? `<div class="bar"><div class="bar-fill"></div></div>` : ""}
    </div>
  `;
  statusBox.classList.remove("hidden");
  statusBox.classList.toggle("error", kind === "error");
}
function clearStatus() {
  statusBox.classList.add("hidden");
  statusBox.innerHTML = "";
}

// Results
const resultsBox = $("#results");
const issuesBody = $("#issues-body");
const statTotal = $("#stat-total");
const statErrors = $("#stat-errors");
const statWarnings = $("#stat-warnings");
const statPass = $("#stat-pass");
const noteTruncate = $("#note-truncate");

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadJSON(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: "validation-report.json" });
  a.click(); URL.revokeObjectURL(url);
}
function downloadCSV(issues) {
  const headers = ["row_index","item_id","field","rule_id","severity","message","sample_value"];
  const rows = issues.map((it) => [
    it.row_index ?? "",
    it.item_id ?? "",
    it.field ?? "",
    it.rule_id ?? "",
    it.severity ?? "",
    String(it.message ?? "").replace(/\r?\n/g, " ").trim(),
    it.sample_value ?? ""
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: "validation-issues.csv" });
  a.click(); URL.revokeObjectURL(url);
}

function renderResults(data) {
  resultsBox.classList.remove("hidden");
  const { summary, issues } = data || {};
  statTotal.textContent = summary?.items_total ?? "-";
  statErrors.textContent = summary?.items_with_errors ?? "-";
  statWarnings.textContent = summary?.items_with_warnings ?? "-";
  statPass.textContent = summary?.pass_rate != null ? (summary.pass_rate * 100).toFixed(1) + "%" : "-";

  issuesBody.innerHTML = "";
  const maxRows = 1000;
  (issues || []).slice(0, maxRows).forEach((it) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${it.row_index ?? "-"}</td>
      <td>${it.item_id ?? "-"}</td>
      <td>${it.field}</td>
      <td>${it.rule_id}</td>
      <td class="${it.severity === "error" ? "sev-error" : "sev-warning"}">${it.severity}</td>
      <td>${escapeHtml(it.message || "")}</td>
      <td>${escapeHtml(it.sample_value ?? "")}</td>
    `;
    issuesBody.appendChild(tr);
  });
  noteTruncate.classList.toggle("hidden", (issues || []).length <= maxRows);

  document.querySelector("#btn-download-json").onclick = () => downloadJSON(data);
  document.querySelector("#btn-download-csv").onclick = () => downloadCSV(issues || []);
}

// Buttons (upload & URL)
document.querySelector("#btn-validate-file").addEventListener("click", async () => {
  try {
    clearStatus();
    resultsBox.classList.add("hidden");
    const f = document.querySelector("#file-input").files[0];
    if (!f) return setStatus("Please choose a JSON/CSV/TSV file.", "error");
    const form = new FormData();
    form.append("file", f);
    form.append("delimiter", document.querySelector("#delimiter").value || ",");
    form.append("encoding", document.querySelector("#encoding").value || "utf-8");

    setStatus("Validating file…", "info", true);
    const res = await fetch("/validate/file", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    clearStatus();
    renderResults(data);
  } catch (e) {
    setStatus(e?.message || "Validation failed.", "error");
  }
});

document.querySelector("#btn-validate-url").addEventListener("click", async () => {
  try {
    clearStatus();
    resultsBox.classList.add("hidden");
    const url = document.querySelector("#feed-url").value.trim();
    if (!url) return setStatus("Please enter a feed URL.", "error");
    const form = new FormData();
    form.append("feed_url", url);
    form.append("delimiter", document.querySelector("#delimiter-url").value || "");
    form.append("encoding", document.querySelector("#encoding-url").value || "utf-8");

    setStatus("Fetching and validating URL…", "info", true);
    const res = await fetch("/validate/url", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    clearStatus();
    renderResults(data);
  } catch (e) {
    setStatus(e?.message || "Validation failed.", "error");
  }
});

// Populate Spec tab (keep in sync with backend lists)
const REQUIRED = [
  "enable_search", "enable_checkout",
  "id", "title", "description", "link", "image_link", "price", "availability",
];
const RECOMMENDED = [
  "brand", "gtin", "mpn", "condition", "product_category", "sale_price",
  "additional_image_link", "item_group_id", "gender", "age_group",
  "color", "size", "material", "weight",
];

function populateSpec() {
  const r = document.querySelector("#req-list");
  const c = document.querySelector("#rec-list");
  r.innerHTML = REQUIRED.map(f => `<li><code>${f}</code></li>`).join("");
  c.innerHTML = RECOMMENDED.map(f => `<li><code>${f}</code></li>`).join("");
}
populateSpec();
