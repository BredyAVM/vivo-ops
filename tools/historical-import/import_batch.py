"""Validate an audited historical batch and optionally import it.

Default behavior is offline and read-only. Database writes require both
--apply and an exact --confirm-sha256 value from the batch manifest.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Iterable


FORBIDDEN_BALANCE_FIELDS = {
    "abono",
    "abono_usd",
    "amount_paid_usd",
    "balance_due_usd",
    "change_usd",
    "legacy_pending_usd",
    "old_pending_usd",
    "outstanding_balance_usd",
    "paid_usd",
    "payment_state",
    "payment_status",
    "pending",
    "pending_usd",
    "saldo_pendiente",
}


def load_env(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
        if match:
            result[match.group(1)] = match.group(2).strip().strip('"').strip("'")
    return result


def canonical_fingerprint(payload: dict[str, object]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def read_jsonl_gzip(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if line.strip():
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise RuntimeError(f"{path.name}:{line_number} is not an object")
                rows.append(value)
    return rows


def validate_batch(batch_dir: Path, source: Path | None = None) -> tuple[dict[str, object], list[dict[str, object]], list[dict[str, object]]]:
    manifest = json.loads((batch_dir / "manifest.json").read_text(encoding="utf-8"))
    if int(manifest.get("format_version") or 0) != 2:
        raise RuntimeError("Only audited historical batch format version 2 is accepted")
    orders = read_jsonl_gzip(batch_dir / str(manifest["files"]["orders"]))
    items = read_jsonl_gzip(batch_dir / str(manifest["files"]["items"]))
    rejects = read_jsonl_gzip(batch_dir / str(manifest["files"]["rejects"]))

    if source is not None:
        digest = hashlib.sha256()
        with source.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != manifest["source_sha256"]:
            raise RuntimeError("Workbook SHA-256 does not match the manifest")

    if len(orders) != int(manifest["expected_order_count"]):
        raise RuntimeError("Order count does not match the manifest")
    expected_purchase_count = int(manifest["expected_purchase_count"])
    expected_gift_event_count = int(manifest["expected_gift_event_count"])
    if expected_purchase_count + expected_gift_event_count != len(orders):
        raise RuntimeError("Purchase and gift-event counts do not add up to the order count")
    if len(items) != int(manifest["expected_item_count"]):
        raise RuntimeError("Item count does not match the manifest")

    source_controls: set[str] = set()
    net_total = 0.0
    purchase_count = 0
    gift_event_count = 0
    for row in orders:
        forbidden_fields = FORBIDDEN_BALANCE_FIELDS.intersection(
            str(key).lower() for key in row
        )
        if forbidden_fields:
            raise RuntimeError(
                "Historical batches must not carry payment or debt fields: "
                + ", ".join(sorted(forbidden_fields))
            )
        control = str(row.get("source_control") or "")
        if not control or control in source_controls:
            raise RuntimeError(f"Duplicate or blank order control: {control!r}")
        source_controls.add(control)
        expected = str(row.get("source_fingerprint") or "")
        actual = canonical_fingerprint({key: value for key, value in row.items() if key != "source_fingerprint"})
        if expected != actual:
            raise RuntimeError(f"Order fingerprint mismatch for control {control}")
        if str(row.get("purchased_at") or "") >= "2026-06-01T00:00:00-04:00":
            raise RuntimeError(f"Order {control} is not before the cutoff")
        event_kind = str(row.get("event_kind") or "")
        order_total = float(row.get("net_total_usd") or 0)
        tags = row.get("gift_tags")
        if event_kind == "purchase" and order_total > 0:
            purchase_count += 1
        elif event_kind == "gift_only" and order_total == 0 and isinstance(tags, list) and tags:
            gift_event_count += 1
        else:
            raise RuntimeError(
                f"Order {control} has an invalid purchase/gift classification"
            )
        net_total += order_total

    if purchase_count != expected_purchase_count:
        raise RuntimeError("Purchase count does not match the manifest")
    if gift_event_count != expected_gift_event_count:
        raise RuntimeError("Gift-event count does not match the manifest")

    item_keys: set[tuple[str, int]] = set()
    line_totals: dict[str, float] = {control: 0.0 for control in source_controls}
    for row in items:
        control = str(row.get("source_control") or "")
        line_number = int(row.get("source_line_no") or 0)
        key = (control, line_number)
        if control not in source_controls or line_number <= 1 or key in item_keys:
            raise RuntimeError(f"Invalid or duplicate item key: {key}")
        item_keys.add(key)
        expected = str(row.get("source_fingerprint") or "")
        actual = canonical_fingerprint({key: value for key, value in row.items() if key != "source_fingerprint"})
        if expected != actual:
            raise RuntimeError(f"Item fingerprint mismatch for {key}")
        line_totals[control] += float(row.get("line_total_usd") or 0)

    order_totals = {str(row["source_control"]): float(row["net_total_usd"]) for row in orders}
    mismatches = [
        control
        for control, total in order_totals.items()
        if abs(round(line_totals.get(control, 0.0), 2) - round(total, 2)) >= 0.005
    ]
    if mismatches:
        raise RuntimeError(f"{len(mismatches)} orders no longer reconcile to their item lines")

    expected_total = float(manifest["expected_net_total_usd"])
    if abs(round(net_total, 2) - round(expected_total, 2)) >= 0.005:
        raise RuntimeError("Net total does not match the manifest")
    if int(manifest["audit_summary"]["rejected_order_count"]) != len(rejects):
        raise RuntimeError("Reject count does not match the manifest")
    return manifest, orders, items


class RestClient:
    def __init__(self, env: dict[str, str]):
        self.base = env.get("SUPABASE_URL") or env.get("NEXT_PUBLIC_SUPABASE_URL")
        self.key = env.get("SUPABASE_SERVICE_ROLE_KEY")
        if not self.base or not self.key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")

    def request(
        self,
        method: str,
        path: str,
        body: object | None = None,
        prefer: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[object | None, dict[str, str]]:
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        if extra_headers:
            headers.update(extra_headers)
        request = urllib.request.Request(
            f"{self.base}/rest/v1/{path}",
            data=(json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None),
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read()
                return (json.loads(payload) if payload else None), dict(response.headers.items())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Supabase {method} {path} failed ({error.code}): {detail}") from error

    def get_all(self, table: str, params: dict[str, str]) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        start = 0
        page_size = 1000
        query = urllib.parse.urlencode(params, safe=",().:*-")
        while True:
            payload, _ = self.request(
                "GET",
                f"{table}?{query}",
                extra_headers={"Range": f"{start}-{start + page_size - 1}", "Range-Unit": "items"},
            )
            page = list(payload or [])
            rows.extend(page)
            if len(page) < page_size:
                return rows
            start += page_size

    def exact_count(self, table: str, filters: dict[str, str]) -> int:
        params = {"select": "id", **filters, "limit": "1"}
        _, headers = self.request(
            "GET",
            f"{table}?{urllib.parse.urlencode(params, safe=',().:*-')}",
            prefer="count=exact",
            extra_headers={"Range": "0-0", "Range-Unit": "items"},
        )
        content_range = headers.get("Content-Range") or headers.get("content-range") or ""
        match = re.search(r"/(\d+)$", content_range)
        if not match:
            raise RuntimeError(f"Could not read exact count for {table}: {content_range!r}")
        return int(match.group(1))


def chunks(rows: list[dict[str, object]], size: int) -> Iterable[list[dict[str, object]]]:
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


def import_batch(
    client: RestClient,
    manifest: dict[str, object],
    orders: list[dict[str, object]],
    items: list[dict[str, object]],
    batch_size: int,
) -> dict[str, object]:
    existing = client.get_all(
        "historical_import_batches",
        {
            "select": (
                "id,status,expected_order_count,expected_purchase_count,"
                "expected_gift_event_count,expected_item_count,expected_net_total_usd"
            ),
            "source_system": f"eq.{manifest['source_system']}",
            "source_sha256": f"eq.{manifest['source_sha256']}",
            "cutoff_date": f"eq.{manifest['cutoff_date']}",
            "limit": "2",
        },
    )
    if len(existing) > 1:
        raise RuntimeError("More than one import batch exists for the same source hash")
    if existing:
        batch = existing[0]
        batch_id = int(batch["id"])
        expected_metadata = (
            int(batch["expected_order_count"]),
            int(batch["expected_purchase_count"]),
            int(batch["expected_gift_event_count"]),
            int(batch["expected_item_count"]),
            round(float(batch["expected_net_total_usd"]), 2),
        )
        manifest_metadata = (
            int(manifest["expected_order_count"]),
            int(manifest["expected_purchase_count"]),
            int(manifest["expected_gift_event_count"]),
            int(manifest["expected_item_count"]),
            round(float(manifest["expected_net_total_usd"]), 2),
        )
        if expected_metadata != manifest_metadata:
            raise RuntimeError(f"Existing batch {batch_id} metadata differs from the manifest")
        if batch["status"] == "ready":
            ready_order_count = client.exact_count(
                "historical_orders",
                {"import_batch_id": f"eq.{batch_id}"},
            )
            ready_item_count = client.exact_count(
                "historical_order_items",
                {"import_batch_id": f"eq.{batch_id}"},
            )
            if ready_order_count != manifest_metadata[0] or ready_item_count != manifest_metadata[3]:
                raise RuntimeError(f"Ready batch {batch_id} does not reconcile to its manifest")
            return {
                "status": "already_ready",
                "batch_id": batch_id,
                "order_count": ready_order_count,
                "purchase_count": manifest_metadata[1],
                "gift_event_count": manifest_metadata[2],
                "item_count": ready_item_count,
                "net_total_usd": manifest_metadata[4],
            }
        if batch["status"] != "loading":
            raise RuntimeError(f"Existing batch {batch_id} has status {batch['status']!r}")
    else:
        payload, _ = client.request(
            "POST",
            "historical_import_batches?select=id,status",
            {
                "source_system": manifest["source_system"],
                "source_file_name": manifest["source_file_name"],
                "source_sha256": manifest["source_sha256"],
                "cutoff_date": manifest["cutoff_date"],
                "status": "loading",
                "expected_order_count": manifest["expected_order_count"],
                "expected_purchase_count": manifest["expected_purchase_count"],
                "expected_gift_event_count": manifest["expected_gift_event_count"],
                "expected_item_count": manifest["expected_item_count"],
                "expected_net_total_usd": manifest["expected_net_total_usd"],
                "audit_summary": manifest["audit_summary"],
            },
            prefer="return=representation",
        )
        batch_id = int(list(payload or [])[0]["id"])

    for index, batch_rows in enumerate(chunks(orders, batch_size), start=1):
        payload_rows = [{**row, "import_batch_id": batch_id} for row in batch_rows]
        client.request(
            "POST",
            "historical_orders?on_conflict=source_system,source_control",
            payload_rows,
            prefer="resolution=ignore-duplicates,return=minimal",
        )
        print(f"orders batch {index}")

    stored_orders = client.get_all(
        "historical_orders",
        {
            "select": "id,source_control,source_fingerprint,event_kind,net_total_usd",
            "import_batch_id": f"eq.{batch_id}",
            "order": "id.asc",
        },
    )
    if len(stored_orders) != int(manifest["expected_order_count"]):
        raise RuntimeError("Stored order count differs; batch remains loading")
    stored_purchase_count = sum(
        1 for row in stored_orders if row.get("event_kind") == "purchase"
    )
    stored_gift_event_count = sum(
        1 for row in stored_orders if row.get("event_kind") == "gift_only"
    )
    if stored_purchase_count != int(manifest["expected_purchase_count"]):
        raise RuntimeError("Stored purchase count differs; batch remains loading")
    if stored_gift_event_count != int(manifest["expected_gift_event_count"]):
        raise RuntimeError("Stored gift-event count differs; batch remains loading")
    order_ids = {str(row["source_control"]): int(row["id"]) for row in stored_orders}
    expected_order_fingerprints = {
        str(row["source_control"]): str(row["source_fingerprint"])
        for row in orders
    }
    if any(
        str(row["source_fingerprint"])
        != expected_order_fingerprints.get(str(row["source_control"]))
        for row in stored_orders
    ):
        raise RuntimeError("Stored order fingerprints differ; batch remains loading")

    for index, batch_rows in enumerate(chunks(items, batch_size), start=1):
        payload_rows = []
        for row in batch_rows:
            source_control = str(row["source_control"])
            stored_order_id = order_ids.get(source_control)
            if stored_order_id is None:
                raise RuntimeError(f"No stored order id for source control {source_control}")
            payload_rows.append(
                {
                    **{key: value for key, value in row.items() if key != "source_control"},
                    "import_batch_id": batch_id,
                    "historical_order_id": stored_order_id,
                }
            )
        client.request(
            "POST",
            "historical_order_items?on_conflict=historical_order_id,source_line_no",
            payload_rows,
            prefer="resolution=ignore-duplicates,return=minimal",
        )
        print(f"items batch {index}")

    stored_items = client.get_all(
        "historical_order_items",
        {
            "select": "historical_order_id,source_line_no,source_fingerprint,line_total_usd",
            "import_batch_id": f"eq.{batch_id}",
            "order": "historical_order_id.asc,source_line_no.asc",
        },
    )
    stored_item_count = len(stored_items)
    stored_total = round(sum(float(row["net_total_usd"]) for row in stored_orders), 2)
    if stored_item_count != int(manifest["expected_item_count"]):
        raise RuntimeError("Stored item count differs; batch remains loading")
    if abs(stored_total - float(manifest["expected_net_total_usd"])) >= 0.005:
        raise RuntimeError("Stored net total differs; batch remains loading")

    expected_item_fingerprints = {
        (order_ids[str(row["source_control"])], int(row["source_line_no"])):
            str(row["source_fingerprint"])
        for row in items
    }
    if any(
        str(row["source_fingerprint"])
        != expected_item_fingerprints.get(
            (int(row["historical_order_id"]), int(row["source_line_no"]))
        )
        for row in stored_items
    ):
        raise RuntimeError("Stored item fingerprints differ; batch remains loading")

    ready_at = dt.datetime.now(dt.timezone.utc).isoformat()
    ready_payload, _ = client.request(
        "PATCH",
        f"historical_import_batches?id=eq.{batch_id}&status=eq.loading&select=id,status",
        {"status": "ready", "ready_at": ready_at, "audit_summary": manifest["audit_summary"]},
        prefer="return=representation",
    )
    ready_rows = list(ready_payload or [])
    if len(ready_rows) != 1 or ready_rows[0].get("status") != "ready":
        raise RuntimeError("Batch was reconciled but could not be marked ready")
    return {
        "status": "ready",
        "batch_id": batch_id,
        "order_count": len(stored_orders),
        "purchase_count": stored_purchase_count,
        "gift_event_count": stored_gift_event_count,
        "item_count": stored_item_count,
        "net_total_usd": stored_total,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-dir", required=True)
    parser.add_argument("--source")
    parser.add_argument("--env-file", default=".env.local")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-sha256")
    args = parser.parse_args()

    batch_dir = Path(args.batch_dir).resolve()
    source = Path(args.source).resolve() if args.source else None
    manifest, orders, items = validate_batch(batch_dir, source)
    result: dict[str, object] = {
        "status": "dry_run_passed",
        "source_sha256": manifest["source_sha256"],
        "order_count": len(orders),
        "purchase_count": manifest["expected_purchase_count"],
        "gift_event_count": manifest["expected_gift_event_count"],
        "item_count": len(items),
        "net_total_usd": manifest["expected_net_total_usd"],
    }
    if args.apply:
        if args.confirm_sha256 != manifest["source_sha256"]:
            raise RuntimeError("--confirm-sha256 must exactly match the manifest before --apply")
        if not 50 <= args.batch_size <= 1000:
            raise RuntimeError("--batch-size must be between 50 and 1000")
        result = import_batch(
            RestClient(load_env(Path(args.env_file).resolve())),
            manifest,
            orders,
            items,
            args.batch_size,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
