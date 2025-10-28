from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import csv, io, re, httpx

app = FastAPI(title="OpenAI Product Feed Validator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten later to your Vercel domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

REQUIRED_FIELDS = ["id", "title", "description", "link", "image_link", "price", "availability"]
AVAIL_ENUM = {"in_stock","out_of_stock","preorder","backorder"}
PRICE_PATTERN = re.compile(r"^\d+(\.\d{2})?\s[A-Z]{3}$")

class ValidateResponse(BaseModel):
    summary: dict
    issues: list

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/validate/file", response_model=ValidateResponse)
async def validate_file(file: UploadFile = File(...), delimiter: str = Form(","), encoding: str = Form("utf-8")):
    data = await file.read()
    return _validate_bytes(data, delimiter, encoding)

@app.post("/validate/url", response_model=ValidateResponse)
async def validate_url(feed_url: str = Form(...), delimiter: str = Form(""), encoding: str = Form("utf-8")):
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(feed_url)
            r.raise_for_status()
            content_type = r.headers.get("content-type","").lower()
            # Basic delimiter sniff if not provided
            guess_delim = "\t" if "\t" in r.text and r.text.count("\t")>r.text.count(",") else ","
            delim = (delimiter or guess_delim)
            return _validate_bytes(r.content, delim, encoding)
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch feed URL: {e}")

def _validate_bytes(data: bytes, delimiter: str, encoding: str):
    try:
        text = data.decode(encoding, errors="replace")
    except Exception:
        raise HTTPException(400, "Could not decode file with provided encoding")

    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter if delimiter else ",")
    header = [h.strip() for h in (reader.fieldnames or [])]

    missing_required = [f for f in REQUIRED_FIELDS if f not in header]
    if missing_required:
        issues = [{
            "row_index": None, "item_id": None, "field": f,
            "rule_id": "OF-REQ-MISSING", "severity": "error",
            "message": f"Required field `{f}` is missing from header.", "sample_value": None,
            "remediation": [f"Add `{f}` to your feed header."]
        } for f in missing_required]
        return {"summary": {"items_total": 0, "items_with_errors": len(issues), "items_with_warnings": 0, "pass_rate": 0.0},
                "issues": issues}

    issues, seen_ids, total = [], set(), 0
    for i, row in enumerate(reader):
        total += 1
        rid = (row.get("id") or "").strip()
        # Required presence
        for f in REQUIRED_FIELDS:
            val = (row.get(f) or "").strip()
            if not val:
                issues.append(_issue(i, rid, f, "OF-001", "error", f"`{f}` is required and missing.", val))

        # Duplicate id
        if rid:
            if rid in seen_ids:
                issues.append(_issue(i, rid, "id", "OF-203", "error", "Duplicate `id` found.", rid))
            seen_ids.add(rid)

        # Availability enum
        av = (row.get("availability") or "").strip().lower()
        if av and av not in AVAIL_ENUM:
            issues.append(_issue(i, rid, "availability", "OF-206", "error",
                                 "Availability must be one of in_stock, out_of_stock, preorder, backorder.", av))

        # Price format
        pr = (row.get("price") or "").strip()
        if pr and not PRICE_PATTERN.match(pr):
            issues.append(_issue(i, rid, "price", "OF-006", "error",
                                 "Price must be `<number> <ISO4217>`, e.g., `129.99 USD`.", pr))

        # Recommended fields → warnings if present but empty
        for opt in ["brand", "gtin", "mpn", "condition", "category", "sale_price"]:
            if opt in row and not (row.get(opt) or "").strip():
                issues.append(_issue(i, rid, opt, "OF-REC", "warning",
                                     f"`{opt}` is recommended but empty.", row.get(opt)))

    errors = sum(1 for it in issues if it["severity"] == "error")
    warnings = sum(1 for it in issues if it["severity"] == "warning")
    error_rows = {it["row_index"] for it in issues if it["severity"]=="error" and it["row_index"] is not None}
    pass_rate = 0.0 if total == 0 else round((total - len(error_rows)) / total, 4)

    return {"summary": {"items_total": total,
                        "items_with_errors": errors,
                        "items_with_warnings": warnings,
                        "pass_rate": pass_rate},
            "issues": issues}

def _issue(row_idx, item_id, field, rule, severity, msg, sample):
    return {
        "row_index": row_idx,
        "item_id": item_id,
        "field": field,
        "rule_id": rule,
        "severity": severity,
        "message": msg,
        "sample_value": sample,
        "remediation": []
    }
