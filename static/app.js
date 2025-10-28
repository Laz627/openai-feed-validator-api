const $ = (sel) => document.querySelector(sel);

const tabFile = $("#tab-file");
const tabUrl = $("#tab-url");
const panelFile = $("#panel-file");
const panelUrl = $("#panel-url");

tabFile.addEventListener("click", () => {
  tabFile.classList.add("active");
  tabUrl.classList.remove("active");
  panelFile.classList.remove("hidden");
  panelUrl.classList.add("hidden");
});

tabUrl.addEventListener("click", () => {
  tabUrl.classList.add("active");
  tabFile.classList.remove("active");
  panelUrl.classList.remove("hidden");
  panelFile.classList.add("hidden");
});

const statusBox = $("#status");
const resultsBox = $("#results");
const issuesBody = $("#issues-body");

const statTotal = $("#stat-total");
const statErrors = $("#stat-errors");
const statWarnings = $("#stat-warnings");
const statPass = $("#stat-pass");
const noteTruncate = $("#note-truncate");

function setStatus(text, kind = "info") {
  statusBox.textContent = text;
  statusBox.classList.remove("hidden");
  statusBox.style.borderColor = kind === "error" ? "#fecaca" : "#e5e7eb";
  statusBox.style.background = kind === "error" ? "#fef2f2" : "#fff";
}

function clearStatus() {
  statusBox.textContent = "";
  statusBox.classList.add("hidden");
}

function renderResults(data) {
  resultsBox.classList.remove("hidden");
  const { summary, issues } = data;
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
      <td>${escapeHtml(String(it.sample_value ?? ""))}</td>
    `;
    issuesBody.appendChild(tr);
  });
  noteTruncate.classList.toggle("hidden", (issues || []).length <= maxRows);

  // Wire downloads
  $("#btn-download-json").onclick = () => downloadJSON(data);
  $("#btn-download-csv").onclick = () => downloadCSV(issues || []);
}

function escapeHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function downloadJSON(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: "validation-report.json" });
  a.click(); URL.revokeObjectURL(url);
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

// ---- File validation
$("#btn-validate-file").addEventListener("click", async () => {
  try {
    clearStatus();
    resultsBox.classList.add("hidden");
    const f = $("#file-input").files[0];
    if (!f) return setStatus("Please choose a CSV/TSV file.", "error");
    const form = new FormData();
    form.append("file", f);
    form.append("delimiter", $("#delimiter").value || ",");
    form.append("encoding", $("#encoding").value || "utf-8");

    setStatus("Validating file…");
    const res = await fetch("/validate/file", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    clearStatus();
    renderResults(data);
  } catch (e) {
    setStatus(e?.message || "Validation failed.", "error");
  }
});

// ---- URL validation
$("#btn-validate-url").addEventListener("click", async () => {
  try {
    clearStatus();
    resultsBox.classList.add("hidden");
    const url = $("#feed-url").value.trim();
    if (!url) return setStatus("Please enter a feed URL.", "error");
    const form = new FormData();
    form.append("feed_url", url);
    form.append("delimiter", $("#delimiter-url").value || "");
    form.append("encoding", $("#encoding-url").value || "utf-8");

    setStatus("Fetching and validating URL…");
    const res = await fetch("/validate/url", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    clearStatus();
    renderResults(data);
  } catch (e) {
    setStatus(e?.message || "Validation failed.", "error");
  }
});
