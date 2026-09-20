"""Seed monthly-billing's store for a test: a garage, a payer, an agreement.
argv: tenant garage_id timezone currency agreement_id payer_id registrar vehicles(csv or -)
"""
import json, os, sys, tempfile
from datetime import UTC, datetime
import psycopg
from monthly_billing.agreement import load_agreement
from monthly_billing.cli import load_garage_file
from monthly_billing.store.postgres import tenant
from monthly_billing.store.records import store_agreement, store_garage, store_payer

tenant_id, garage_id, zone, currency, agreement_id, payer_id, registrar, vehicles = sys.argv[1:9]
vehicles = [] if vehicles == "-" else vehicles.split(",")

def tmp(doc):
    h = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(doc, h); h.close(); return h.name

garage_doc = {"id": garage_id, "timezone": zone, "currency": currency,
              "billing_day": "last_day_of_month", "payment_grace_days": 5,
              "identity_rule": "folded_alphanumeric"}
agreement_doc = {
    "id": agreement_id, "version": 1, "garage_id": garage_id, "covered_garage_ids": [garage_id],
    "payer_id": payer_id, "spots": 4, "registrar": registrar, "vehicles": vehicles,
    "monthly_price_minor": 48000, "start_day": "2026-03-10",
    "mandate": {"agreed_by": "the fleet manager", "agreed_at_iso": "2026-03-09T16:20:00-07:00",
                "terms_shown": "A recurring monthly charge for monthly parking.",
                "frequency_shown": "Monthly, on the last day of each month.",
                "amount_basis_shown": "The stated monthly price.",
                "cancellation_shown": "Cancel in writing; the paid period runs to its end."},
}
agreement = load_agreement(agreement_doc)
garage = load_garage_file(tmp(garage_doc))
conn = psycopg.connect(os.environ["MONTHLY_BILLING_DSN"]); conn.autocommit = False
with tenant(conn, tenant_id) as cursor:
    home, home_uuid = garage, store_garage(cursor, tenant_id, garage)
    payer_uuid = store_payer(cursor, tenant_id, payer_id, f"Payer {payer_id}")
    store_agreement(cursor, tenant_id, home, home_uuid, payer_uuid, agreement, now=datetime(2026, 3, 1, tzinfo=UTC))
conn.commit(); conn.close()
print("seeded", garage_id, agreement_id)
