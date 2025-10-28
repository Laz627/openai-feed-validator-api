
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
const fileInput = $("#file-input");
const delimiterInput = $("#delimiter");
const encodingInput = $("#encoding");
const btnValidate = $("#btn-validate-file");
const statusBox = $("#status");
const resultsWrap = $("#results");
const issuesBody = $("#issues-body");
const noteTruncate = $("#note-truncate");
const statTotal = $("#stat-total");
const statErrors = $("#stat-errors");
const statWarnings = $("#stat-warnings");
const statPass = $("#stat-pass");
const btnJson = $("#btn-download-json");
const btnCsv = $("#btn-download-csv");

let lastResult = null;

const escapeHtml = (value) => {
  if(value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

function setDownloadsEnabled(enabled){
  [btnJson, btnCsv].forEach((btn) => {
    if(btn){
      btn.disabled = !enabled;
    }
  });
}

function renderStatus(message, kind = "info", { spinner = false } = {}){
  if(!statusBox) return;
  if(!message){
    statusBox.classList.add("hidden");
    statusBox.classList.remove("error", "success");
    statusBox.innerHTML = "";
    return;
  }
  const icon = spinner ? '<div class="spinner" role="status"></div>' : "";
  statusBox.innerHTML = `<div class="status-inner">${icon}<div>${escapeHtml(message)}</div></div>`;
  statusBox.classList.remove("hidden", "error", "success");
  if(kind === "error"){
    statusBox.classList.add("error");
  }else if(kind === "success"){
    statusBox.classList.add("success");
  }
}

function resetResults(){
  if(resultsWrap){
    resultsWrap.classList.add("hidden");
  }
  if(issuesBody){
    issuesBody.innerHTML = "";
  }
  if(noteTruncate){
    noteTruncate.classList.add("hidden");
  }
  if(statTotal) statTotal.textContent = "-";
  if(statErrors) statErrors.textContent = "-";
  if(statWarnings) statWarnings.textContent = "-";
  if(statPass) statPass.textContent = "-";
}

function renderResults(data){
  lastResult = data;
  const { summary, issues = [] } = data || {};

  if(statTotal) statTotal.textContent = summary?.items_total?.toLocaleString?.() ?? String(summary?.items_total ?? "-");
  if(statErrors) statErrors.textContent = summary?.items_with_errors?.toLocaleString?.() ?? String(summary?.items_with_errors ?? "-");
  if(statWarnings) statWarnings.textContent = summary?.items_with_warnings?.toLocaleString?.() ?? String(summary?.items_with_warnings ?? "-");

  if(statPass){
    if(typeof summary?.pass_rate === "number" && !Number.isNaN(summary.pass_rate)){
      const pct = Math.round(summary.pass_rate * 1000) / 10; // one decimal place
      statPass.textContent = `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
    }else{
      statPass.textContent = "-";
    }
  }

  if(issuesBody){
    const limit = 1000;
    const sliced = issues.slice(0, limit);
    if(sliced.length === 0){
      issuesBody.innerHTML = '<tr class="empty"><td colspan="7">✅ No issues found. Your feed meets all required checks.</td></tr>';
    }else{
      issuesBody.innerHTML = sliced.map((issue, idx) => {
        const rowIndex = typeof issue.row_index === "number" ? issue.row_index + 1 : "";
        const severity = (issue.severity || "info").toLowerCase();
        return `<tr>
          <td>${escapeHtml(rowIndex)}</td>
          <td>${escapeHtml(issue.item_id ?? "")}</td>
          <td>${escapeHtml(issue.field ?? "")}</td>
          <td>${escapeHtml(issue.rule_id ?? "")}</td>
          <td><span class="sev-${escapeHtml(severity)}">${escapeHtml(severity)}</span></td>
          <td>${escapeHtml(issue.message ?? "")}</td>
          <td>${escapeHtml(issue.sample_value ?? "")}</td>
        </tr>`;
      }).join("");
    }
    if(noteTruncate){
      if(issues.length > limit){
        noteTruncate.classList.remove("hidden");
      }else{
        noteTruncate.classList.add("hidden");
      }
    }
  }

  if(resultsWrap){
    resultsWrap.classList.remove("hidden");
  }

  setDownloadsEnabled(true);
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
    renderStatus("Please choose a feed file before validating.", "error");
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
  renderStatus("Validating feed…", "info", { spinner: true });
  if(btnValidate){
    btnValidate.disabled = true;
  }

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
    renderStatus("Validation complete.", "success");
  }catch(err){
    renderStatus(`Validation failed: ${err.message || err}`, "error");
  }finally{
    if(btnValidate){
      btnValidate.disabled = false;
    }
  }
}

btnJson && btnJson.addEventListener("click", handleDownloadJson);
btnCsv && btnCsv.addEventListener("click", handleDownloadCsv);
btnValidate && btnValidate.addEventListener("click", handleValidateClick);

setDownloadsEnabled(false);

// ===== Spec content enrichment =====
const REQUIRED_FIELD_DETAILS = [
  { name: "enable_search", description: "Boolean flag that controls whether the item is discoverable across OpenAI shopping and conversational surfaces." },
  { name: "enable_checkout", description: "Boolean flag gating assistant-led checkout flows. Must be \"true\" only when enable_search is also \"true\"." },
  { name: "id", description: "Stable unique identifier (≤100 characters) used to reconcile updates and suppress duplicates." },
  { name: "title", description: "Human-readable product name that will be surfaced in chat results and product cards." },
  { name: "description", description: "Rich text description (plain text) that helps the model summarize what the item offers." },
  { name: "link", description: "HTTPS URL to the canonical product detail page shoppers can visit for more context." },
  { name: "product_category", description: "Category taxonomy path separated with \">\" tokens (e.g., Electronics > Tablets) per the OpenAI commerce spec." },
  { name: "brand", description: "Brand or manufacturer displayed alongside the title and used for matching queries." },
  { name: "material", description: "Primary material or composition so the assistant can answer questions about build quality." },
  { name: "weight", description: "Shipping or packaged weight with unit (lb, kg, g, oz) for fulfillment and compliance answers." },
  { name: "image_link", description: "Primary product image URL shown in surfaces like shopping carousels." },
  { name: "price", description: "Item price formatted as \"<amount> <ISO currency>\" (e.g., 199.99 USD)." },
  { name: "availability", description: "Inventory state enumeration (in_stock, out_of_stock, preorder) that drives purchase eligibility." },
  { name: "inventory_quantity", description: "Available quantity (non-negative integer) used for low-stock messaging." },
  { name: "seller_name", description: "Display name for the merchant or storefront providing the offer." },
  { name: "seller_url", description: "Merchant homepage or storefront URL shoppers can visit for support." },
  { name: "return_policy", description: "Public return policy URL required for marketplace compliance." },
  { name: "return_window", description: "Number of days customers have to initiate a return." }
];

const RECOMMENDED_FIELD_DETAILS = [
  { name: "gtin", description: "Global Trade Item Number (UPC/EAN/ISBN) to help OpenAI map listings to canonical products." },
  { name: "mpn", description: "Manufacturer Part Number for catalog matching when no GTIN exists." },
  { name: "condition", description: "Product condition indicator (new, refurbished, used) surfaced in assistant responses." },
  { name: "dimensions", description: "Combined dimension string (e.g., 10 in x 6 in x 2 in) for quick size callouts." },
  { name: "length", description: "Length dimension with unit for detailed sizing guidance." },
  { name: "width", description: "Width dimension with unit for detailed sizing guidance." },
  { name: "height", description: "Height dimension with unit for detailed sizing guidance." },
  { name: "age_group", description: "Intended audience (newborn, kids, adult, etc.) to power age-restricted filtering." },
  { name: "additional_image_link", description: "Comma-separated list of supplementary image URLs for richer galleries." },
  { name: "video_link", description: "Product demo or marketing video URL used in conversational summaries." },
  { name: "model_3d_link", description: "3D model preview (GLB/USDZ) for immersive shopping experiences." },
  { name: "applicable_taxes_fees", description: "Any surcharge text shoppers should see alongside price disclosures." },
  { name: "sale_price", description: "Temporary discounted price that complements the primary price." },
  { name: "sale_price_effective_date", description: "Start/end date range for the sale_price in YYYY-MM-DD / YYYY-MM-DD format." },
  { name: "unit_pricing_measure", description: "Measurement of the item for per-unit pricing (e.g., 750 ml)." },
  { name: "base_measure", description: "Reference measure (e.g., 100 ml) used with unit_pricing_measure to compute unit price." },
  { name: "pricing_trend", description: "Signals about price history or competitiveness, surfaced in assistant copy." },
  { name: "availability_date", description: "Date the item becomes available; required for preorder, helpful for upcoming drops." },
  { name: "expiration_date", description: "Expiry date for perishable or regulated goods." },
  { name: "pickup_method", description: "Supported pickup option (in_store, reserve, not_supported) for click-and-collect." },
  { name: "pickup_sla", description: "Fulfillment lead time for pickup orders such as '2 days'." },
  { name: "item_group_id", description: "Identifier tying variants together so the assistant can cluster color/size options." },
  { name: "item_group_title", description: "Human-friendly name for the variant family displayed alongside grouped results." },
  { name: "color", description: "Variant color label used in conversational selection." },
  { name: "size", description: "Variant size label (e.g., M, 8.5) shown in responses." },
  { name: "size_system", description: "Two-letter ISO country code describing the sizing system (US, EU, JP, etc.)." },
  { name: "gender", description: "Intended gender (male, female, unisex) for apparel experiences." },
  { name: "offer_id", description: "Offer-level identifier when a merchant has multiple offers for the same item." },
  { name: "shipping", description: "Structured shipping cost details for transparency in chat responses." },
  { name: "delivery_estimate", description: "Estimated delivery windows or speed promises." },
  { name: "seller_privacy_policy", description: "Privacy policy URL required on checkout-enabled listings." },
  { name: "seller_tos", description: "Terms of service URL required on checkout-enabled listings." },
  { name: "popularity_score", description: "Relative popularity metric that can influence ranking explanations." },
  { name: "return_rate", description: "Historical return rate to highlight trustworthy products." },
  { name: "warning", description: "Plain-text safety or regulatory warning copy." },
  { name: "warning_url", description: "Link to detailed compliance or safety documentation." },
  { name: "age_restriction", description: "Age gating information (e.g., 21+) for regulated goods." },
  { name: "product_review_count", description: "Number of product-level reviews used for social proof." },
  { name: "product_review_rating", description: "Average product rating value." },
  { name: "store_review_count", description: "Number of merchant/store reviews." },
  { name: "store_review_rating", description: "Average merchant/store rating." },
  { name: "q_and_a", description: "Structured Q&A content that helps the assistant answer specific product questions." },
  { name: "raw_review_data", description: "Detailed review corpus the model can summarize when responding to shoppers." },
  { name: "related_product_id", description: "Identifier of complementary or substitute items for cross-sell suggestions." },
  { name: "relationship_type", description: "Type of relationship (part_of_set, accessory, etc.) connecting related_product_id." },
  { name: "geo_price", description: "Region-specific pricing overrides for localized offers." },
  { name: "geo_availability", description: "Locations where the item is available so the assistant can answer regional stock questions." }
];

function renderSpecList(el, items){
  if(!el || !Array.isArray(items)) return;
  el.innerHTML = items
    .map((item) => `<li><code>${escapeHtml(item.name)}</code><p>${escapeHtml(item.description)}</p></li>`)
    .join("");
}

renderSpecList($("#req-list"), REQUIRED_FIELD_DETAILS);
renderSpecList($("#rec-list"), RECOMMENDED_FIELD_DETAILS);

const yearEl = $("#year");
if(yearEl){
  yearEl.textContent = String(new Date().getFullYear());
}

// Initial
showTab("validate");
