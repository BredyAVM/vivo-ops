"""Build a deterministic, audited historical-commercial import batch.

The script only reads the legacy workbook and current Supabase reference data.
It never writes to Supabase. Output is gzip-compressed JSON Lines plus a small
manifest that can be validated offline before any import is authorized.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
import re
import unicodedata
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


CUTOFF = dt.date(2026, 6, 1)
SOURCE_SYSTEM = "tablero_jugadas"
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS}


def clean_text(value: object) -> str:
    return str(value or "").strip()


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKD", clean_text(value))
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", text.lower()).strip()


def normalize_control(value: object) -> str:
    text = clean_text(value)
    try:
        number = float(text)
        return str(int(number)) if number.is_integer() else text
    except (TypeError, ValueError):
        return text


def normalize_phone(value: object) -> str | None:
    raw = clean_text(value)
    explicit = bool(re.match(r"^\s*(\+|00)", raw))
    digits = re.sub(r"[^0-9]", "", raw)
    if not digits:
        return None
    if explicit:
        if digits.startswith("00"):
            digits = digits[2:]
        result = "+" + digits
    elif digits.startswith("58") and len(digits) >= 11:
        result = "+" + digits
    elif digits.startswith("0") and len(digits) >= 10:
        result = "+58" + digits[1:]
    elif 9 <= len(digits) <= 10:
        result = "+58" + digits
    else:
        return None
    return result if re.match(r"^\+[1-9][0-9]{6,14}$", result) else None


def as_number(value: object, default: float = 0.0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError):
        return default


def money(value: object) -> float:
    return round(as_number(value), 2)


def excel_date(value: object) -> dt.date | None:
    try:
        serial = float(value)
        if not math.isfinite(serial) or serial < 1:
            return None
        return (dt.datetime(1899, 12, 30) + dt.timedelta(days=serial)).date()
    except (TypeError, ValueError, OverflowError):
        text = clean_text(value)
        for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y", "%Y-%m-%d"):
            try:
                return dt.datetime.strptime(text, fmt).date()
            except ValueError:
                pass
        return None


def excel_time(value: object) -> dt.time:
    text = clean_text(value)
    try:
        number = float(text)
        fraction = number % 1
        seconds = int(round(fraction * 86400)) % 86400
        return dt.time(seconds // 3600, (seconds % 3600) // 60, seconds % 60)
    except (TypeError, ValueError):
        pass
    for fmt in ("%H:%M:%S", "%H:%M", "%I:%M:%S %p", "%I:%M %p"):
        try:
            return dt.datetime.strptime(text.upper(), fmt).time()
        except ValueError:
            pass
    return dt.time(12, 0)


def caracas_timestamp(date_value: dt.date, time_value: object) -> str:
    return f"{date_value.isoformat()}T{excel_time(time_value).isoformat()}-04:00"


def fulfillment(value: object) -> str | None:
    text = normalize_text(value)
    if "delivery" in text or "domicilio" in text:
        return "delivery"
    if "pickup" in text or "pick up" in text or "retiro" in text:
        return "pickup"
    return None


def gift_tags(*values: object) -> list[str]:
    text = normalize_text(" ".join(clean_text(value) for value in values))
    result: list[str] = []
    if re.search(r"\bdond(?:y|ys|is)\b", text):
        result.append("dondys")
    if re.search(
        r"\b(obsequio|obs|obsq|regalo|premio|degustacion|donativo|cortesia|gratis|gratuito|muestra)",
        text,
    ):
        result.append("obsequio")
    if "regalo" in text:
        result.append("regalo")
    if "premio" in text:
        result.append("premio")
    if "degustacion" in text:
        result.append("degustacion")
    if "donativo" in text:
        result.append("donativo")
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(payload: dict[str, object]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_env(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
        if match:
            result[match.group(1)] = match.group(2).strip().strip('"').strip("'")
    return result


def fetch_all(env: dict[str, str], table: str, select: str) -> list[dict[str, object]]:
    base = env.get("SUPABASE_URL") or env.get("NEXT_PUBLIC_SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    url = f"{base}/rest/v1/{table}?{urllib.parse.urlencode({'select': select})}"
    rows: list[dict[str, object]] = []
    start = 0
    page_size = 1000
    while True:
        request = urllib.request.Request(
            url,
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Range": f"{start}-{start + page_size - 1}",
                "Range-Unit": "items",
            },
        )
        with urllib.request.urlopen(request, timeout=45) as response:
            page = json.load(response)
        rows.extend(page)
        if len(page) < page_size:
            return rows
        start += page_size


def shared_strings(archive: zipfile.ZipFile) -> list[str]:
    result: list[str] = []
    with archive.open("xl/sharedStrings.xml") as stream:
        for _, element in ET.iterparse(stream, events=("end",)):
            if element.tag == f"{{{MAIN_NS}}}si":
                result.append(
                    "".join(node.text or "" for node in element.iter(f"{{{MAIN_NS}}}t"))
                )
                element.clear()
    return result


def column_number(reference: str | None) -> int:
    match = re.match(r"([A-Z]+)", reference or "")
    result = 0
    for char in match.group(1) if match else "":
        result = result * 26 + ord(char) - 64
    return result


def decode_cell(cell: ET.Element, strings: list[str]) -> object:
    cell_type = cell.attrib.get("t")
    value_node = cell.find("m:v", NS)
    inline_node = cell.find("m:is", NS)
    raw = value_node.text if value_node is not None else None
    if cell_type == "s" and raw is not None:
        return strings[int(raw)]
    if cell_type == "inlineStr" and inline_node is not None:
        return "".join(node.text or "" for node in inline_node.iter(f"{{{MAIN_NS}}}t"))
    if cell_type == "b":
        return raw == "1"
    return raw


def iter_rows(archive: zipfile.ZipFile, path: str, strings: list[str]):
    with archive.open(path) as stream:
        for _, element in ET.iterparse(stream, events=("end",)):
            if element.tag != f"{{{MAIN_NS}}}row":
                continue
            row: dict[int, object] = {}
            for cell in element.findall("m:c", NS):
                row[column_number(cell.attrib.get("r"))] = decode_cell(cell, strings)
            yield int(element.attrib.get("r", 0)), row
            element.clear()


def workbook_paths(archive: zipfile.ZipFile) -> dict[str, str]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        node.attrib["Id"]: node.attrib["Target"]
        for node in relations.findall(f"{{{PKG_REL_NS}}}Relationship")
    }
    paths: dict[str, str] = {}
    for sheet in workbook.find("m:sheets", NS):
        target = targets[sheet.attrib[f"{{{REL_NS}}}id"]]
        paths[sheet.attrib["name"]] = (
            target.lstrip("/") if target.startswith("/") else "xl/" + target.lstrip("/")
        )
    return paths


def advisor_id_for_snapshot(
    seller: object,
    current_advisors: dict[str, dict[str, object]],
) -> str | None:
    normalized = normalize_text(seller)
    exact = current_advisors.get(normalized)
    if exact:
        return str(exact["id"])
    signatures = (
        (("anagraciela", "perozo"), "anagraciela perozo"),
        (("bredy", "velasquez"), "bredy velasquez"),
        (("ramon", "viviescas"), "ramon viviescas"),
        (("yujanir", "aular"), "yujanir aular"),
        (("martin", "montiel"), "martin montiel"),
        (("mariangela", "montiel"), "mariangela montiel"),
        (("jacqueline", "aular"), "jacqueline aular"),
    )
    for tokens, canonical in signatures:
        if all(token in normalized for token in tokens) and canonical in current_advisors:
            return str(current_advisors[canonical]["id"])
    return None


def write_jsonl_gzip(path: Path, rows: list[dict[str, object]]) -> None:
    with gzip.open(path, "wt", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(
                json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            )
            stream.write("\n")


def build(args: argparse.Namespace) -> dict[str, object]:
    source = Path(args.source).resolve()
    output_dir = Path(args.output).resolve()
    env = load_env(Path(args.env_file).resolve())

    clients_live = fetch_all(env, "clients", "id,phone")
    aliases_live = fetch_all(
        env,
        "client_legacy_aliases",
        "source,legacy_control,client_id",
    )
    products_live = fetch_all(env, "products", "id,name")
    profiles_live = fetch_all(env, "profiles", "id,full_name,is_active")
    roles_live = fetch_all(env, "user_roles", "user_id,role")

    clients_by_id = {int(row["id"]): row for row in clients_live}
    clients_by_phone: dict[str, list[int]] = collections.defaultdict(list)
    for row in clients_live:
        normalized_phone = normalize_phone(row.get("phone"))
        if normalized_phone:
            clients_by_phone[normalized_phone].append(int(row["id"]))

    aliases = {
        normalize_control(row["legacy_control"]): int(row["client_id"])
        for row in aliases_live
        if row.get("source") == "clientes_final_2026-06-01"
    }

    products_by_name: dict[str, list[int]] = collections.defaultdict(list)
    for row in products_live:
        products_by_name[normalize_text(row.get("name"))].append(int(row["id"]))

    active_advisor_ids = {
        str(row["user_id"])
        for row in roles_live
        if row.get("role") == "advisor"
    }
    current_advisors = {
        normalize_text(row.get("full_name")): row
        for row in profiles_live
        if row.get("is_active") is True and str(row.get("id")) in active_advisor_ids
    }

    rejection_counts: collections.Counter[str] = collections.Counter()
    rejects: list[dict[str, object]] = []
    orders_by_control: dict[str, dict[str, object]] = {}
    source_file_sha256 = sha256_file(source)

    with zipfile.ZipFile(source) as archive:
        strings = shared_strings(archive)
        paths = workbook_paths(archive)
        required_sheets = {"Clientes", "BDAux", "Base de Datos"}
        missing_sheets = required_sheets.difference(paths)
        if missing_sheets:
            raise RuntimeError(f"Missing workbook sheets: {sorted(missing_sheets)}")

        source_clients: dict[str, dict[str, object]] = {}
        for row_number, row in iter_rows(archive, paths["Clientes"], strings):
            if row_number == 1:
                continue
            control = normalize_control(row.get(1))
            if control:
                source_clients[control] = {
                    "phone": normalize_phone(row.get(2)),
                }

        for row_number, row in iter_rows(archive, paths["BDAux"], strings):
            if row_number == 1:
                continue
            control = normalize_control(row.get(1))
            created_on = excel_date(row.get(2))
            seller = clean_text(row.get(3))
            legacy_client_control = normalize_control(row.get(4))
            purchased_on = excel_date(row.get(9)) or created_on
            net_total = money(row.get(7))
            order_status = normalize_text(row.get(21))

            reason: str | None = None
            if order_status != "entregado":
                reason = "not_delivered"
            elif not control:
                reason = "missing_control"
            elif not legacy_client_control:
                reason = "missing_client_control"
            elif purchased_on is None:
                reason = "missing_purchase_date"
            elif purchased_on >= CUTOFF:
                reason = "at_or_after_cutoff"
            elif net_total < 0:
                reason = "negative_commercial_total"
            elif control in orders_by_control:
                reason = "duplicate_source_control"

            source_client = source_clients.get(legacy_client_control, {})
            source_phone = source_client.get("phone")
            phone_matches = clients_by_phone.get(str(source_phone), []) if source_phone else []
            direct_client_id = aliases.get(legacy_client_control)
            client_id: int | None = None
            match_route: str | None = None
            if reason is None:
                if direct_client_id is not None and direct_client_id not in clients_by_id:
                    reason = "alias_missing_live_client"
                elif (
                    direct_client_id is not None
                    and len(phone_matches) == 1
                    and phone_matches[0] != direct_client_id
                ):
                    reason = "alias_phone_disagreement"
                elif direct_client_id is not None:
                    client_id = direct_client_id
                    match_route = "direct_alias"
                elif len(phone_matches) == 1:
                    client_id = phone_matches[0]
                    match_route = "unique_phone_fallback"
                elif len(phone_matches) > 1:
                    reason = "ambiguous_phone"
                elif source_phone is None:
                    reason = "missing_or_invalid_phone"
                else:
                    reason = "phone_not_found"

            fulfillment_value = fulfillment(row.get(8))
            if reason is None and fulfillment_value is None:
                reason = "unknown_fulfillment"
            if reason is None and not seller:
                reason = "missing_advisor_snapshot"

            if reason is not None:
                rejection_counts[reason] += 1
                rejects.append({"source_row": row_number, "source_control": control, "reason": reason})
                continue

            assert client_id is not None
            assert purchased_on is not None
            assert fulfillment_value is not None
            source_product_summary = clean_text(row.get(6)) or None
            source_notes = clean_text(row.get(22)) or None
            order_payload: dict[str, object] = {
                "source_system": SOURCE_SYSTEM,
                "source_control": control,
                "source_row": row_number,
                "client_id": client_id,
                "legacy_client_control": legacy_client_control,
                "source_created_on": created_on.isoformat() if created_on else None,
                "purchased_at": caracas_timestamp(purchased_on, row.get(10)),
                "attributed_advisor_id": advisor_id_for_snapshot(seller, current_advisors),
                "advisor_name_snapshot": seller,
                "fulfillment": fulfillment_value,
                "net_total_usd": net_total,
                "gift_tags": gift_tags(source_product_summary, source_notes),
                "source_product_summary": source_product_summary,
                "source_notes": source_notes,
                "match_route": match_route,
                "items": [],
            }
            orders_by_control[control] = order_payload

        selected_raw_lines = 0
        valid_candidate_lines = 0
        for row_number, row in iter_rows(archive, paths["Base de Datos"], strings):
            if row_number == 1:
                continue
            control = normalize_control(row.get(1))
            order_payload = orders_by_control.get(control)
            if order_payload is None:
                continue
            selected_raw_lines += 1
            legacy_code = normalize_control(row.get(5))
            product_name = clean_text(row.get(6))
            quantity = round(as_number(row.get(7)), 3)
            unit_price = round(as_number(row.get(8)), 4)
            line_total = money(row.get(9))
            if quantity <= 0:
                continue
            if not legacy_code or legacy_code == "0" or not product_name:
                if line_total <= 0:
                    continue
                legacy_code = "LEGACY-UNALLOCATED"
                product_name = "Cargo o ajuste histórico no desglosado"
            valid_candidate_lines += 1
            product_matches = products_by_name[normalize_text(product_name)]
            item_payload: dict[str, object] = {
                "source_control": control,
                "source_line_no": row_number,
                "legacy_product_code": legacy_code,
                "product_id": product_matches[0] if len(product_matches) == 1 else None,
                "product_name_snapshot": product_name,
                "quantity": quantity,
                "unit_price_usd": unit_price,
                "line_total_usd": line_total,
            }
            item_payload["source_fingerprint"] = fingerprint(item_payload)
            order_payload["items"].append(item_payload)

    trusted_orders: list[dict[str, object]] = []
    trusted_items: list[dict[str, object]] = []
    for control, order_payload in orders_by_control.items():
        items = list(order_payload.pop("items"))
        net_total = float(order_payload["net_total_usd"])
        order_payload["gift_tags"] = gift_tags(
            order_payload.get("source_product_summary"),
            order_payload.get("source_notes"),
            *(item["product_name_snapshot"] for item in items),
        )
        if net_total == 0:
            order_payload["event_kind"] = "gift_only"
            if not order_payload["gift_tags"]:
                order_payload["gift_tags"] = ["obsequio_sin_clasificar"]
        else:
            order_payload["event_kind"] = "purchase"

        if not items and net_total > 0:
            reason = "no_valid_product_lines"
        elif items:
            line_total = round(sum(float(item["line_total_usd"]) for item in items), 2)
            reason = None if abs(net_total - line_total) < 0.005 else "line_total_mismatch"
        else:
            reason = None
        if reason:
            rejection_counts[reason] += 1
            rejects.append(
                {
                    "source_row": order_payload["source_row"],
                    "source_control": control,
                    "reason": reason,
                }
            )
            continue
        order_payload.pop("match_route", None)
        order_payload["source_fingerprint"] = fingerprint(order_payload)
        trusted_orders.append(order_payload)
        trusted_items.extend(items)

    trusted_orders.sort(key=lambda row: (str(row["purchased_at"]), str(row["source_control"])))
    trusted_items.sort(key=lambda row: (str(row["source_control"]), int(row["source_line_no"])))
    rejects.sort(key=lambda row: (int(row["source_row"]), str(row.get("reason") or "")))

    expected_total = round(sum(float(order["net_total_usd"]) for order in trusted_orders), 2)
    expected_purchase_count = sum(1 for order in trusted_orders if order["event_kind"] == "purchase")
    expected_gift_event_count = sum(1 for order in trusted_orders if order["event_kind"] == "gift_only")
    if args.expected_orders is not None and len(trusted_orders) != args.expected_orders:
        raise RuntimeError(f"Expected {args.expected_orders} trusted orders, got {len(trusted_orders)}")
    if args.expected_items is not None and len(trusted_items) != args.expected_items:
        raise RuntimeError(f"Expected {args.expected_items} trusted items, got {len(trusted_items)}")
    if args.expected_purchases is not None and expected_purchase_count != args.expected_purchases:
        raise RuntimeError(
            f"Expected {args.expected_purchases} purchases, got {expected_purchase_count}"
        )
    if args.expected_gift_events is not None and expected_gift_event_count != args.expected_gift_events:
        raise RuntimeError(
            f"Expected {args.expected_gift_events} gift events, got {expected_gift_event_count}"
        )
    if args.expected_total is not None and abs(expected_total - args.expected_total) >= 0.005:
        raise RuntimeError(f"Expected total {args.expected_total:.2f}, got {expected_total:.2f}")

    manifest: dict[str, object] = {
        "format_version": 2,
        "source_system": SOURCE_SYSTEM,
        "source_file_name": source.name,
        "source_sha256": source_file_sha256,
        "cutoff_date": CUTOFF.isoformat(),
        "expected_order_count": len(trusted_orders),
        "expected_purchase_count": expected_purchase_count,
        "expected_gift_event_count": expected_gift_event_count,
        "expected_item_count": len(trusted_items),
        "expected_net_total_usd": expected_total,
        "audit_summary": {
            "source_order_rows": len(trusted_orders) + len(rejects),
            "trusted_client_count": len({int(order["client_id"]) for order in trusted_orders}),
            "delivery_count": sum(1 for order in trusted_orders if order["fulfillment"] == "delivery"),
            "pickup_count": sum(1 for order in trusted_orders if order["fulfillment"] == "pickup"),
            "gift_order_count": sum(1 for order in trusted_orders if order["gift_tags"]),
            "purchase_count": expected_purchase_count,
            "gift_only_event_count": expected_gift_event_count,
            "purchase_with_gift_count": sum(
                1
                for order in trusted_orders
                if order["event_kind"] == "purchase" and order["gift_tags"]
            ),
            "legacy_balance_rows_ignored": len(trusted_orders),
            "historical_outstanding_balance_usd": 0,
            "current_advisor_order_count": sum(
                1 for order in trusted_orders if order["attributed_advisor_id"] is not None
            ),
            "snapshot_only_advisor_order_count": sum(
                1 for order in trusted_orders if order["attributed_advisor_id"] is None
            ),
            "exact_product_link_count": sum(
                1 for item in trusted_items if item["product_id"] is not None
            ),
            "snapshot_only_product_count": sum(
                1 for item in trusted_items if item["product_id"] is None
            ),
            "selected_raw_product_rows": selected_raw_lines,
            "valid_candidate_product_rows": valid_candidate_lines,
            "rejected_order_count": len(rejects),
            "rejections_by_reason": dict(sorted(rejection_counts.items())),
        },
        "files": {
            "orders": "orders.jsonl.gz",
            "items": "items.jsonl.gz",
            "rejects": "rejects.jsonl.gz",
        },
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    write_jsonl_gzip(output_dir / "orders.jsonl.gz", trusted_orders)
    write_jsonl_gzip(output_dir / "items.jsonl.gz", trusted_items)
    write_jsonl_gzip(output_dir / "rejects.jsonl.gz", rejects)
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--env-file", default=".env.local")
    parser.add_argument("--expected-orders", type=int)
    parser.add_argument("--expected-items", type=int)
    parser.add_argument("--expected-purchases", type=int)
    parser.add_argument("--expected-gift-events", type=int)
    parser.add_argument("--expected-total", type=float)
    args = parser.parse_args()
    manifest = build(args)
    print(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
