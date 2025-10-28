# =========================
# app/main.py (patched)
# =========================

from typing import Any, Dict, List, Optional, Tuple
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

class Issue(BaseModel):
    row_index: Optional[int] = None
    item_id: Optional[str] = None
    field: str
    rule_id: str
    severity: str  # "error" | "warning" | "info" | "opportunity"
    message: str
    sample_value: Optional[str] = None
    remediation: Optional[List[str]] = None

class Summary(BaseModel):
    items_total: int = 0
    items_with_errors: int = 0
    items_with_warnings: int = 0
    items_with_opportunities: int = 0
    pass_rate: float = 0.0
    top_rules: Optional[List[Dict[str, Any]]] = None

class ValidateResponse(BaseModel):
    summary: Summary
    issues: List[Issue]

app = FastAPI(title="OpenAI Product Feed Validator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Required fields (per row)
REQUIRED_FIELDS = [
    "enable_search", "enable_checkout",
    "id", "title", "description", "link",
    "product_category", "brand", "material", "weight",
    "image_link",
    "price",
    "availability", "inventory_quantity",
    "seller_name", "seller_url",
    "return_policy", "return_window",
]

# Recommended fields (will only warn if PRESENT BUT EMPTY, not for missing)
RECOMMENDED_FIELDS = [
    "gtin", "mpn",
    "condition", "dimensions", "length", "width", "height",
    "age_group",
    "additional_image_link", "video_link", "model_3d_link",
    "applicable_taxes_fees", "sale_price", "sale_price_effective_date",
    "unit_pricing_measure", "base_measure", "pricing_trend",
    "availability_date", "expiration_date",
    "pickup_method", "pickup_sla",
    "item_group_id", "item_group_title", "color", "size", "size_system", "gender", "offer_id",
    "shipping", "delivery_estimate",
    "seller_privacy_policy", "seller_tos",
    "popularity_score", "return_rate",
    "warning", "warning_url", "age_restriction",
    "product_review_count", "product_review_rating", "store_review_count", "store_review_rating",
    "q_and_a", "raw_review_data",
    "related_product_id", "relationship_type",
    "geo_price", "geo_availability",
]

HEADER_ALIASES: Dict[str, str] = {
    "image link": "image_link",
    "image-url": "image_link",
    "imageurl": "image_link",
    "product link": "link",
    "product-url": "link",
    "producturl": "link",
    "price_amount": "price",
    "availability_status": "availability",
    "product_category": "product_category",
    "sellername": "seller_name",
    "seller url": "seller_url",
    "sellerurl": "seller_url",
    "return policy": "return_policy",
    "return window": "return_window",
}

BOOL_ENUM = {"true", "false"}
AVAIL_ENUM = {"in_stock", "out_of_stock", "preorder"}
CONDITION_ENUM = {"new", "refurbished", "used"}
AGE_GROUP_ENUM = {"newborn", "infant", "toddler", "kids", "adult"}
GENDER_ENUM = {"male", "female", "unisex"}
RELATIONSHIP_ENUM = {"part_of_set", "required_part", "often_bought_with", "substitute", "different_brand", "accessory"}
PICKUP_ENUM = {"in_store", "reserve", "not_supported"}

CURRENCY_PRICE_RE = re.compile(r"^\d+(\.\d{1,2})?\s[A-Z]{3}$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATE_RANGE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\s*/\s*(\d{4}-\d{2}-\d{2})$")
URL_RE = re.compile(r"^https?://", re.IGNORECASE)
ALNUM_RE = re.compile(r"^[A-Za-z0-9._\-]+$")
COUNTRY_ALPHA2_RE = re.compile(r"^[A-Za-z]{2}$")
WEIGHT_RE = re.compile(r"^\s*\d+(\.\d+)?\s*(lb|lbs|kg|g|oz)\s*$", re.IGNORECASE)
DIMENSION_RE = re.compile(r"^\s*\d+(\.\d+)?\s*(mm|cm|in|inch|inches)\s*$", re.IGNORECASE)

ROW_CAP = 50000

def guess_delimiter(sample: str) -> str:
    counts = {"\t": sample.count("\t"), ",": sample.count(","), ";": sample.count(";"), "|": sample.count("|")}
    return max(counts, key=counts.get) if counts else ","

def normalize_key(k: str) -> str:
    kk = (k or "").strip().lower().replace("-", "_").replace(" ", "_")
    return HEADER_ALIASES.get(kk, kk)

def normalize_headers(headers: List[str]) -> List[str]:
    return [normalize_key(h) for h in headers]

def normalize_record_keys(r: Dict[str, Any]) -> Dict[str, Any]:
    nr: Dict[str, Any] = {}
    for k, v in r.items():
        nr[normalize_key(str(k))] = v
    if isinstance(nr.get("additional_image_link"), list):
        nr["additional_image_link"] = ", ".join(map(str, nr["additional_image_link"]))
    return nr

def parse_price(value: str) -> Optional[Tuple[float, str]]:
    try:
        num, cur = value.strip().split()
        return float(num), cur
    except Exception:
        return None

def is_future_date(yyyy_mm_dd: str) -> bool:
    try:
        from datetime import date
        y, m, d = map(int, yyyy_mm_dd.split("-"))
        target = date(y, m, d)
        return target > date.today()
    except Exception:
        return False

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

    seen_optional_fields: set[str] = set()

    for idx, raw in enumerate(records):
        total += 1
        # Use only this row's keys; do not inject missing keys.
        r = {normalize_key(k): ("" if raw.get(k) is None else str(raw.get(k)).strip()) for k in raw.keys()}
        rid = r.get("id", "")

        # Required per row
        def req(field, code, msg):
            if not r.get(field, ""):
                _push_issue(issues, error_rows, idx, rid, field, code, "error", msg, r.get(field, ""))

        # Flags
        req("enable_search", "OF-100", "enable_search is required.")
        req("enable_checkout", "OF-101", "enable_checkout is required.")
        es = r.get("enable_search", "").lower()
        ec = r.get("enable_checkout", "").lower()
        if r.get("enable_search") and es not in {"true","false"}:
            _push_issue(issues, error_rows, idx, rid, "enable_search", "OF-100A", "error",
                        'enable_search must be "true" or "false" (lower-case).', es)
        if r.get("enable_checkout") and ec not in {"true","false"}:
            _push_issue(issues, error_rows, idx, rid, "enable_checkout", "OF-101A", "error",
                        'enable_checkout must be "true" or "false" (lower-case).', ec)
        if ec == "true" and es != "true":
            _push_issue(issues, error_rows, idx, rid, "enable_checkout", "OF-102", "error",
                        "enable_checkout can only be true when enable_search is true.", ec)

        # id
        req("id", "OF-110", "id is required.")
        if r.get("id"):
            if len(r["id"]) > 100:
                _push_issue(issues, error_rows, idx, rid, "id", "OF-111", "error", "id exceeds 100 characters.", r["id"][:120])
            if not ALNUM_RE.match(r["id"]):
                _push_issue(issues, error_rows, idx, rid, "id", "OF-112", "warning",
                            "id should be alphanumeric plus . _ - only.", r["id"])
            if r["id"] in seen_ids:
                _push_issue(issues, error_rows, idx, rid, "id", "OF-113", "error", "Duplicate id found.", r["id"])
            seen_ids.add(r["id"])

        # title
        req("title", "OF-120", "title is required.")
        title = r.get("title","")
        if title:
            if len(title) > 150:
                _push_issue(issues, error_rows, idx, rid, "title", "OF-121", "warning", "title exceeds 150 characters.", title[:180])
            if title.isupper():
                _push_issue(issues, error_rows, idx, rid, "title", "OF-122", "warning", "Avoid ALL-CAPS titles.", title)

        # description
        req("description", "OF-130", "description is required.")
        desc = r.get("description","")
        if desc:
            if len(desc) > 5000:
                _push_issue(issues, error_rows, idx, rid, "description", "OF-131", "warning", "description exceeds 5,000 characters.", desc[:80])
            if re.search(r"<[^>]+>", desc):
                _push_issue(issues, error_rows, idx, rid, "description", "OF-132", "warning", "description should be plain text (HTML detected).", desc[:80])

        # link
        req("link", "OF-140", "link is required.")
        link = r.get("link","")
        if link and not re.match(r"^https?://", link, flags=re.I):
            _push_issue(issues, error_rows, idx, rid, "link", "OF-141", "error", "link must be a valid http(s) URL.", link)

        # product_category
        req("product_category", "OF-150", "product_category is required.")
        pc = r.get("product_category","")
        if pc and ">" not in pc:
            _push_issue(issues, error_rows, idx, rid, "product_category", "OF-151", "warning",
                        "product_category should use '>' as a separator (e.g., A > B).", pc)

        # brand
        req("brand", "OF-160", "brand is required.")
        if r.get("brand") and len(r["brand"]) > 70:
            _push_issue(issues, error_rows, idx, rid, "brand", "OF-161", "warning", "brand exceeds 70 characters.", r["brand"][:90])

        # material
        req("material", "OF-170", "material is required.")
        if r.get("material") and len(r["material"]) > 100:
            _push_issue(issues, error_rows, idx, rid, "material", "OF-171", "warning", "material exceeds 100 characters.", r["material"][:120])

        # weight
        req("weight", "OF-180", "weight is required (e.g., '1.5 lb').")
        if r.get("weight") and not WEIGHT_RE.match(r["weight"]):
            _push_issue(issues, error_rows, idx, rid, "weight", "OF-181", "error",
                        "weight must be a positive number with unit (lb, lbs, kg, g, oz).", r["weight"])

        # image_link
        req("image_link", "OF-190", "image_link is required.")
        if r.get("image_link") and not re.match(r"^https?://", r["image_link"], flags=re.I):
            _push_issue(issues, error_rows, idx, rid, "image_link", "OF-191", "error", "image_link must be a valid http(s) URL.", r["image_link"])

        # price
        req("price", "OF-200", "price is required.")
        if r.get("price") and not re.match(r"^\d+(\.\d{1,2})?\s[A-Z]{3}$", r["price"]):
            _push_issue(issues, error_rows, idx, rid, "price", "OF-201", "error",
                        'price must be "<number> <ISO4217>", e.g., "79.99 USD".', r["price"])

        # Availability & Inventory
        req("availability", "OF-210", "availability is required.")
        avail = r.get("availability","").lower()
        if avail and avail not in AVAIL_ENUM:
            _push_issue(issues, error_rows, idx, rid, "availability", "OF-211", "error",
                        'availability must be one of: "in_stock", "out_of_stock", "preorder".', avail)

        req("inventory_quantity", "OF-212", "inventory_quantity is required.")
        invq = r.get("inventory_quantity","")
        if invq != "":
            try:
                iv = int(float(invq))
                if iv < 0: raise ValueError()
            except Exception:
                _push_issue(issues, error_rows, idx, rid, "inventory_quantity", "OF-213", "error",
                            "inventory_quantity must be a non-negative integer.", invq)

        if avail == "preorder":
            ad = r.get("availability_date","")
            if not ad or not ISO_DATE_RE.match(ad) or not is_future_date(ad):
                _push_issue(issues, error_rows, idx, rid, "availability_date", "OF-214", "error",
                            "availability_date (YYYY-MM-DD) is required for preorder and must be a future date.", ad)

        # Variants
        variant_hint = any(r.get(k) for k in ("color","size","size_system","gender"))
        if variant_hint and not r.get("item_group_id"):
            _push_issue(issues, error_rows, idx, rid, "item_group_id", "OF-230", "error",
                        "item_group_id is required when variant attributes are present.", r.get("item_group_id"))

        if r.get("gender") and r["gender"].lower() not in GENDER_ENUM:
            _push_issue(issues, error_rows, idx, rid, "gender", "OF-231", "warning",
                        'gender must be one of: "male", "female", "unisex".', r["gender"])

        if r.get("size_system") and not COUNTRY_ALPHA2_RE.match(r["size_system"]):
            _push_issue(issues, error_rows, idx, rid, "size_system", "OF-232", "warning",
                        "size_system must be a 2-letter ISO 3166 country code.", r["size_system"])

        if r.get("condition") and r["condition"].lower() not in CONDITION_ENUM:
            _push_issue(issues, error_rows, idx, rid, "condition", "OF-233", "warning",
                        'condition must be one of: "new", "refurbished", "used".', r["condition"])

        if r.get("age_group") and r["age_group"].lower() not in AGE_GROUP_ENUM:
            _push_issue(issues, error_rows, idx, rid, "age_group", "OF-234", "warning",
                        'age_group must be one of: "newborn", "infant", "toddler", "kids", "adult".', r["age_group"])

        # Dimensions
        dims = [r.get("length",""), r.get("width",""), r.get("height","")]
        provided_dims = [d for d in dims if d]
        if provided_dims and len(provided_dims) != 3:
            _push_issue(issues, error_rows, idx, rid, "length/width/height", "OF-240", "warning",
                        "Provide all of length, width, and height when using individual dimension fields.", ", ".join(provided_dims))
        for f, val in zip(["length","width","height"], dims):
            if val and not DIMENSION_RE.match(val):
                _push_issue(issues, error_rows, idx, rid, f, "OF-241", "warning", f"{f} should include units (mm/cm/in).", val)

        # Media optional
        if r.get("video_link") and not URL_RE.match(r["video_link"]):
            _push_issue(issues, error_rows, idx, rid, "video_link", "OF-250", "warning", "video_link must be a valid http(s) URL.", r["video_link"])
        if r.get("model_3d_link") and not URL_RE.match(r["model_3d_link"]):
            _push_issue(issues, error_rows, idx, rid, "model_3d_link", "OF-251", "warning", "model_3d_link must be a valid http(s) URL.", r["model_3d_link"])

        # Price dependencies
        if r.get("sale_price"):
            sp = r["sale_price"]
            if not CURRENCY_PRICE_RE.match(sp):
                _push_issue(issues, error_rows, idx, rid, "sale_price", "OF-260", "error", 'sale_price must be "<number> <ISO4217>".', sp)
            else:
                p_parsed = parse_price(r.get("price",""))
                sp_parsed = parse_price(sp)
                if p_parsed and sp_parsed and sp_parsed[0] > p_parsed[0]:
                    _push_issue(issues, error_rows, idx, rid, "sale_price", "OF-261", "error",
                                "sale_price must be less than or equal to price.", sp)
            spd = r.get("sale_price_effective_date","")
            if not spd or not DATE_RANGE_RE.match(spd):
                _push_issue(issues, error_rows, idx, rid, "sale_price_effective_date", "OF-262", "error",
                            "sale_price_effective_date is required with sale_price and must be 'YYYY-MM-DD / YYYY-MM-DD'.", spd)
            else:
                start, end = DATE_RANGE_RE.match(spd).groups()
                if start >= end:
                    _push_issue(issues, error_rows, idx, rid, "sale_price_effective_date", "OF-263", "error",
                                "sale_price_effective_date start must precede end.", spd)

        # Unit pricing
        upm = r.get("unit_pricing_measure",""); bm = r.get("base_measure","")
        if (upm and not bm) or (bm and not upm):
            _push_issue(issues, error_rows, idx, rid, "unit_pricing_measure/base_measure", "OF-270", "error",
                        "unit_pricing_measure and base_measure must be provided together.", f"{upm} | {bm}")

        # Availability extras
        if r.get("expiration_date") and (not ISO_DATE_RE.match(r["expiration_date"]) or not is_future_date(r["expiration_date"])):
            _push_issue(issues, error_rows, idx, rid, "expiration_date", "OF-280", "warning",
                        "expiration_date must be a future ISO date (YYYY-MM-DD).", r["expiration_date"])

        if r.get("pickup_method") and r["pickup_method"] not in PICKUP_ENUM:
            _push_issue(issues, error_rows, idx, rid, "pickup_method", "OF-281", "warning",
                        'pickup_method must be one of: "in_store", "reserve", "not_supported".', r["pickup_method"])
        if r.get("pickup_sla") and not re.match(r"^\d+\s+\w+$", r["pickup_sla"]):
            _push_issue(issues, error_rows, idx, rid, "pickup_sla", "OF-282", "warning",
                        "pickup_sla should be a positive integer + unit (e.g., '1 day').", r["pickup_sla"])

        # Merchant info
        req("seller_name", "OF-290", "seller_name is required.")
        if r.get("seller_name") and len(r["seller_name"]) > 70:
            _push_issue(issues, error_rows, idx, rid, "seller_name", "OF-291", "warning", "seller_name exceeds 70 characters.", r["seller_name"][:80])

        req("seller_url", "OF-292", "seller_url is required.")
        if r.get("seller_url") and not URL_RE.match(r["seller_url"]):
            _push_issue(issues, error_rows, idx, rid, "seller_url", "OF-293", "error", "seller_url must be a valid http(s) URL.", r["seller_url"])

        if ec == "true":
            if not r.get("seller_privacy_policy") or not URL_RE.match(r.get("seller_privacy_policy","")):
                _push_issue(issues, error_rows, idx, rid, "seller_privacy_policy", "OF-294", "error",
                            "seller_privacy_policy URL is required when enable_checkout is true.", r.get("seller_privacy_policy"))
            if not r.get("seller_tos") or not URL_RE.match(r.get("seller_tos","")):
                _push_issue(issues, error_rows, idx, rid, "seller_tos", "OF-295", "error",
                            "seller_tos URL is required when enable_checkout is true.", r.get("seller_tos"))

        # Returns
        req("return_policy", "OF-296", "return_policy URL is required.")
        if r.get("return_policy") and not URL_RE.match(r["return_policy"]):
            _push_issue(issues, error_rows, idx, rid, "return_policy", "OF-296A", "error", "return_policy must be a valid http(s) URL.", r["return_policy"])
        req("return_window", "OF-297", "return_window (days) is required.")
        if r.get("return_window"):
            try:
                rw = int(r["return_window"])
                if rw <= 0: raise ValueError
            except Exception:
                _push_issue(issues, error_rows, idx, rid, "return_window", "OF-298", "error", "return_window must be a positive integer (days).", r["return_window"])

        if r.get("relationship_type") and r["relationship_type"] not in RELATIONSHIP_ENUM:
            _push_issue(issues, error_rows, idx, rid, "relationship_type", "OF-299", "warning",
                        "relationship_type must be a documented value.", r["relationship_type"])

        # Track which optional fields were provided at all for opportunity reporting later
        for opt in RECOMMENDED_FIELDS:
            if opt in r:
                seen_optional_fields.add(opt)

        # Context-aware recommended warnings (only if PRESENT but empty, and only when applicable)
        def warn_if_present_empty(field: str, rule: str):
            if field in r and (r[field] == "" or r[field] is None):
                _push_issue(issues, error_rows, idx, rid, field, rule, "warning", f'"{field}" is recommended but empty.', r.get(field))

        # availability_date only relevant for preorder (if present and empty => warn, if preorder and missing => already error)
        if avail == "preorder":
            if "availability_date" in r and not r["availability_date"]:
                warn_if_present_empty("availability_date", "OF-REC")

        # seller_* only relevant when checkout enabled
        if ec == "true":
            if "seller_privacy_policy" in r and not r["seller_privacy_policy"]:
                warn_if_present_empty("seller_privacy_policy", "OF-REC")
            if "seller_tos" in r and not r["seller_tos"]:
                warn_if_present_empty("seller_tos", "OF-REC")

        # Variant recommendations only when variant context exists
        if variant_hint:
            for fld in ("item_group_id","color","size","size_system","gender"):
                if fld in r and not r[fld]:
                    warn_if_present_empty(fld, "OF-REC")

        # Generic recommended: only warn if field key exists and value is empty (never for missing)
        GENERIC_REC = set(RECOMMENDED_FIELDS) - {"availability_date","seller_privacy_policy","seller_tos","item_group_id","color","size","size_system","gender"}
        for opt in GENERIC_REC:
            if opt in r and (r[opt] == "" or r[opt] is None):
                warn_if_present_empty(opt, "OF-REC")

    # Flag entirely missing recommended fields as low-severity opportunities
    def format_field_name(field: str) -> str:
        return field.replace("_", " ").replace("/", " / ")

    missing_optional = sorted(set(RECOMMENDED_FIELDS) - seen_optional_fields)
    for field in missing_optional:
        nice = format_field_name(field)
        _push_issue(
            issues,
            error_rows,
            row_index=-1,
            item_id="",
            field=field,
            rule_id=f"OF-OPP-{field.upper()}",
            severity="opportunity",
            message=f'Consider adding "{nice}" to improve feed coverage and merchandising.',
            sample=None,
        )

    # Normalise dataset-level opportunity rows to display without row index
    for issue in issues:
        if issue.severity == "opportunity" and issue.row_index == -1:
            issue.row_index = None
            issue.item_id = None

    errors = sum(1 for it in issues if it.severity == "error")
    warnings = sum(1 for it in issues if it.severity == "warning")
    opportunities = sum(1 for it in issues if it.severity == "opportunity")
    pass_rate = 0.0 if total == 0 else round((total - len(error_rows)) / total, 4)

    return ValidateResponse(
        summary=Summary(items_total=total,
                        items_with_errors=errors,
                        items_with_warnings=warnings,
                        items_with_opportunities=opportunities,
                        pass_rate=pass_rate),
        issues=issues,
    )

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
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    text = data.decode(encoding or "utf-8", errors="replace")
    delim = delimiter or guess_delimiter(text)
    sio = io.StringIO(text)
    reader = csv.reader(sio, delimiter=delim)
    raw_header = next(reader, None) or []
    norm_header = normalize_headers([str(h) for h in raw_header])
    # Rewind and use DictReader with normalized headers, skip header row correctly
    sio.seek(0)
    dict_reader = csv.DictReader(sio, delimiter=delim)
    dict_reader.fieldnames = norm_header
    out: List[Dict[str, Any]] = []
    _ = next(dict_reader, None)  # skip header row
    for row in dict_reader:
        out.append(normalize_record_keys({k: row.get(k, "") for k in norm_header}))
    return out

def validate_bytes(data: bytes, delimiter: str, encoding: str) -> ValidateResponse:
    records = parse_as_json(data, encoding)
    if records is None:
        records = parse_as_csv_tsv(data, delimiter, encoding)
    if len(records) > ROW_CAP:
        records = records[:ROW_CAP]
    return validate_records(records)

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

app.mount("/", StaticFiles(directory="static", html=True), name="static")
