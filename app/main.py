# =========================
# app/main.py
# FastAPI app that:
#  - validates OpenAI-style product feeds (JSON or CSV/TSV)
#  - exposes /validate/file and /validate/url
#  - serves a static frontend from /static
#  - includes a simple /health check
# =========================

from typing import Any, Dict, List, Optional
import csv
import io
import json
import re
from urllib.parse import unquote

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# -------------------------
# Pydantic response models
# -------------------------

class Issue(BaseModel):
    row_index: Optional[int] = None
    item_id: Optional[str] = None
    field: str
    rule_id: str
    severity: str  # "error" | "warning" | "info"
    message: str
    sample_value: Optional[str] = None
    remediation: Optional[List[str]] = None

class Summary(BaseModel):
    items_total: int = 0
    items_with_errors: int = 0
    items_with_warnings: int = 0
    pass_rate: float = 0.0
    top_rules: Optional[List[Dict[str, Any]]] = None

class ValidateResponse(BaseModel):
    summary: Summary
    issues: List[Issue]

# -------------------------
# App & CORS
# -------------------------

app = FastAPI(title="OpenAI Product Feed Validator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to your domain later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# Validation configuration
# (Tune these lists as spec evolves)
# -------------------------

REQUIRED_FIELDS = [
    # Core (spec-aligned)
    "enable_search", "enable_checkout",
    "id", "title", "description", "link", "image_link", "price", "availability",
]

RECOMMENDED_FIELDS = [
    "brand", "gtin", "mpn", "condition", "product_category", "sale_price",
    "additional_image_link", "item_group_id", "gender", "age_group",
    "color", "size", "material", "weight",
]

# Normalize/alias odd header names commonly seen in the wild
HEADER_ALIASES: Dict[str, str] = {
    "image link": "image_link",
    "image-url": "image_link",
    "imageurl": "image_link",
    "product link": "link",
    "product-url": "link",
    "producturl": "link",
    "price_amount": "price",
    "availability_status": "availability",
    "product_category": "product_category",  # explicit
}

AVAIL_ENUM = {"in_stock", "out_of_stock", "preorder", "backorder"}
PRICE_RE = re.compile(r"^\d+(\.\d{2})?\s[A-Z]{3}$")  # e.g., "129.99 USD"

# -------------------------
# Utilities
# -------------------------

def guess_delimiter(sample: str) -> str:
    counts = {
        "\t": sample.count("\t"),
        ",": sample.count(","),
        ";": sample.count(";"),
        "|": sample.count("|"),
    }
    # pick the delimiter with the highest count
    best = max(counts, key=counts.get) if counts else ","
    return best

def normalize_key(k: str) -> str:
    """snake_case-ish normalization"""
    kk = (k or "").strip().lower()
    kk = kk.replace("-", "_").replace(" ", "_")
    return HEADER_ALIASES.get(kk, kk)

def normalize_headers(headers: List[str]) -> List[str]:
    return [normalize_key(h) for h in headers]

def normalize_record_keys(r: Dict[str, Any]) -> Dict[str, Any]:
    nr: Dict[str, Any] = {}
    for k, v in r.items():
        nr[normalize_key(str(k))] = v
    # Flatten arrays for display convenience
    if isinstance(nr.get("additional_image_link"), list):
        nr["additional_image_link"] = ", ".join(map(str, nr["additional_image_link"]))
    return nr

# -------------------------
# Core validator
# -------------------------

def _push_issue(issues: List[Issue], error_rows: set[int], row_index: int, item_id: str,
                field: str, rule_id: str, severity: str, message: str, sample: Any):
    issues.append(Issue(
        row_index=row_index,
        item_id=item_id or None,
        field=field,
        rule_id=rule_id,
        severity=severity,
        message=message,
        sample_value=None if sample is None else str(sample),
        remediation=[],
    ))
    if severity == "error":
        error_rows.add(row_index)

def validate_records(records: List[Dict[str, Any]]) -> ValidateResponse:
    issues: List[Issue] = []
    total = 0
    error_rows: set[int] = set()
    seen_ids: set[str] = set()

    # Header-level presence (based on union of keys from first row)
    header = list(records[0].keys()) if records else []
    for f in REQUIRED_FIELDS:
        if f not in header:
            issues.append(Issue(
                row_index=None, item_id=None, field=f, rule_id="OF-REQ-MISSING",
                severity="error",
                message=f'Required field "{f}" is missing from header.',
                sample_value=None, remediation=[f'Add "{f}" to your feed header.']
            ))
    # If header is missing a required column, stop early
    if any(i.rule_id == "OF-REQ-MISSING" for i in issues):
        return ValidateResponse(
            summary=Summary(
                items_total=0,
                items_with_errors=sum(1 for it in issues if it.severity == "error"),
                items_with_warnings=sum(1 for it in issues if it.severity == "warning"),
                pass_rate=0.0,
            ),
            issues=issues
        )

    for idx, raw in enumerate(records):
        total += 1
        r = {k: ("" if raw.get(k) is None else str(raw.get(k)).strip()) for k in header}
        rid = r.get("id", "")

        # Required presence
        for f in REQUIRED_FIELDS:
            if not r.get(f):
                _push_issue(issues, error_rows, idx, rid, f, "OF-001", "error", f'"{f}" is required and missing.', r.get(f))

        # Duplicate id
        if rid:
            if rid in seen_ids:
                _push_issue(issues, error_rows, idx, rid, "id", "OF-203", "error", "Duplicate id found.", rid)
            seen_ids.add(rid)

        # Availability
        av = r.get("availability", "").lower()
        if av and av not in AVAIL_ENUM:
            _push_issue(issues, error_rows, idx, rid, "availability", "OF-206", "error",
                        'Availability must be one of: "in_stock", "out_of_stock", "preorder", "backorder".', av)

        # Price format "<number> <ISO4217>"
        pr = r.get("price", "")
        if pr and not PRICE_RE.match(pr):
            _push_issue(issues, error_rows, idx, rid, "price", "OF-006", "error",
                        'Price must be "<number> <ISO4217>", e.g., "129.99 USD".', pr)

        # Recommended-but-empty warnings
        for opt in RECOMMENDED_FIELDS:
            if opt in r and not r[opt]:
                _push_issue(issues, error_rows, idx, rid, opt, "OF-REC", "warning",
                            f'"{opt}" is recommended but empty.', r.get(opt))

    errors = sum(1 for it in issues if it.severity == "error")
    warnings = sum(1 for it in issues if it.severity == "warning")
    pass_rate = 0.0 if total == 0 else round((total - len(error_rows)) / total, 4)

    return ValidateResponse(
        summary=Summary(
            items_total=total,
            items_with_errors=errors,
            items_with_warnings=warnings,
            pass_rate=pass_rate,
        ),
        issues=issues,
    )

# -------------------------
# Parsers (JSON first, then CSV/TSV)
# -------------------------

# Hard cap on rows to validate (MVP)
ROW_CAP = 50000

def parse_as_json(data: bytes, encoding: str) -> Optional[List[Dict[str, Any]]]:
    try:
        text = data.decode(encoding or "utf-8", errors="replace")
        obj = json.loads(text)
        if isinstance(obj, list):
            return [normalize_record_keys(r) for r in obj if isinstance(r, dict)]
        if isinstance(obj, dict) and isinstance(obj.get("items"), list):
            return [normalize_record_keys(r) for r in obj["items"] if isinstance(r, dict)]
    except Exception:
        return None
    return None

def parse_as_csv_tsv(data: bytes, delimiter: str, encoding: str) -> List[Dict[str, Any]]:
    # Strip BOM, decode
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    text = data.decode(encoding or "utf-8", errors="replace")

    delim = delimiter or guess_delimiter(text)

    sio = io.StringIO(text)
    reader = csv.reader(sio, delimiter=delim)
    raw_header = next(reader, None) or []
    norm_header = normalize_headers([str(h) for h in raw_header])

    sio.seek(0)
    dict_reader = csv.DictReader(sio, delimiter=delim)
    dict_reader.fieldnames = norm_header  # force normalized header

    out: List[Dict[str, Any]] = []
    for row in dict_reader:
        out.append(normalize_record_keys({k: row.get(k) for k in norm_header}))
    return out

def validate_bytes(data: bytes, delimiter: str, encoding: str) -> ValidateResponse:
    # Try JSON first
    records = parse_as_json(data, encoding)
    if records is None:
        # Fallback: CSV/TSV
        records = parse_as_csv_tsv(data, delimiter, encoding)
    # Apply row cap
    if len(records) > ROW_CAP:
        records = records[:ROW_CAP]
    return validate_records(records)

# -------------------------
# Routes
# -------------------------

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/validate/file", response_model=ValidateResponse)
async def validate_file(
    file: UploadFile = File(...),
    delimiter: str = Form(""),
    encoding: str = Form("utf-8"),
):
    try:
        data = await file.read()
        return validate_bytes(data, delimiter, encoding)
    except Exception as e:
        raise HTTPException(400, f"Validation failed: {e}")

@app.post("/validate/url", response_model=ValidateResponse)
async def validate_url(
    feed_url: str = Form(...),
    delimiter: str = Form(""),
    encoding: str = Form("utf-8"),
):
    try:
        clean = unquote(feed_url)
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(clean, headers={"Accept": "*/*"})
            r.raise_for_status()
            return validate_bytes(r.content, delimiter, encoding)
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch feed URL: {e}")

# -------------------------
# Static frontend (must be last)
# -------------------------

# Serve / -> static/index.html and other assets under /static/*
app.mount("/", StaticFiles(directory="static", html=True), name="static")
