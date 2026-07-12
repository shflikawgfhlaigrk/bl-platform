import type { ImportBatch, ImportKind } from './contract';

/**
 * SIMULATOR — a deterministic, seeded Square provider so the ENTIRE import
 * pipeline is testable with zero credentials and zero network. No
 * `Math.random`: every value derives from a seeded PRNG, so the same
 * (seed, kind, count) always yields byte-identical batches.
 */

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ada', 'Blake', 'Cora', 'Drew', 'Elle', 'Finn', 'Gwen', 'Hank'];
const LAST = ['Ash', 'Byrne', 'Cole', 'Dunn', 'Ellis', 'Ford', 'Gray', 'Holt'];
const ITEMS = ['Elastic Belt', 'Saddle Pad', 'Breeches', 'Show Coat', 'Half Chaps', 'Fly Bonnet'];

export class SimulatedSquareProvider {
  constructor(private readonly seed: number = 1) {}

  /** A deterministic batch of `count` records for `kind`. */
  batch(kind: ImportKind, count: number): ImportBatch {
    const rand = mulberry32((this.seed ^ hashString(kind)) >>> 0);
    const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
    const iso = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86400000 + int(0, 3600) * 1000).toISOString();
    const pick = <T>(arr: T[]) => arr[int(0, arr.length - 1)];

    const records: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      records.push(this.record(kind, i, int, iso, pick));
    }
    return {
      source: 'simulator',
      kind,
      records,
      sourceMeta: { fetchedAt: '2026-07-12T00:00:00.000Z' },
    };
  }

  private record(
    kind: ImportKind,
    i: number,
    int: (a: number, b: number) => number,
    iso: (i: number) => string,
    pick: <T>(arr: T[]) => T,
  ): unknown {
    const usd = (amount: number) => ({ amount, currency: 'USD' });
    switch (kind) {
      case 'payments': {
        const amount = int(500, 25000);
        return {
          id: `sim_pay_${this.seed}_${i}`,
          created_at: iso(i),
          status: 'COMPLETED',
          amount_money: usd(amount),
          processing_fee: [{ amount_money: usd(Math.round(amount * 0.029) + 30) }],
          customer_id: `sim_cust_${this.seed}_${int(0, 4)}`,
          order_id: `sim_ord_${this.seed}_${i}`,
        };
      }
      case 'orders':
        return {
          id: `sim_ord_${this.seed}_${i}`,
          state: 'COMPLETED',
          created_at: iso(i),
          location_id: 'LSIM',
          total_money: usd(int(500, 25000)),
          line_items: [
            {
              name: pick(ITEMS),
              quantity: String(int(1, 3)),
              catalog_object_id: `sim_var_${this.seed}_${int(0, 9)}`,
              total_money: usd(int(500, 25000)),
            },
          ],
        };
      case 'customers':
        return {
          id: `sim_cust_${this.seed}_${i}`,
          created_at: iso(i),
          given_name: pick(FIRST),
          family_name: pick(LAST),
          email_address: int(0, 1) === 0 ? `sim${i}@example.test` : null,
          phone_number: null,
          creation_source: 'IMPORT',
        };
      case 'catalog':
        return {
          type: 'ITEM',
          id: `sim_item_${this.seed}_${i}`,
          is_deleted: false,
          item_data: {
            name: `${pick(ITEMS)} ${i}`,
            variations: [
              {
                type: 'ITEM_VARIATION',
                id: `sim_var_${this.seed}_${i}`,
                item_variation_data: {
                  item_id: `sim_item_${this.seed}_${i}`,
                  name: 'Default',
                  sku: `SKU${this.seed}${i}`,
                  upc: `00000000000${i % 10}`,
                  price_money: usd(int(500, 25000)),
                },
              },
            ],
          },
        };
      case 'gift_cards':
        return {
          id: `sim_gftc_${this.seed}_${i}`,
          state: 'ACTIVE',
          balance_money: usd(int(0, 5000)),
          gan: `7782730${100000 + i}`,
          created_at: iso(i),
        };
      case 'payouts':
        return {
          id: `sim_po_${this.seed}_${i}`,
          status: 'PAID',
          amount_money: { amount: int(100, 400000), currency_code: 'USD' },
          destination: { type: 'BANK_ACCOUNT' },
          created_at: iso(i),
          arrival_date: iso(i).slice(0, 10),
        };
      case 'disputes':
        return {
          id: `sim_disp_${this.seed}_${i}`,
          state: 'WON',
          reason: 'EMV_LIABILITY_SHIFT',
          amount_money: usd(int(500, 20000)),
          disputed_payment: { payment_id: `sim_pay_${this.seed}_${i}` },
          created_at: iso(i),
        };
      case 'invoices':
        return {
          id: `sim_inv_${this.seed}_${i}`,
          status: int(0, 1) === 0 ? 'PAID' : 'UNPAID',
          order_id: `sim_ord_${this.seed}_${i}`,
          invoice_number: String(1000 + i),
          created_at: iso(i),
          primary_recipient: { customer_id: `sim_cust_${this.seed}_${int(0, 4)}` },
          payment_requests: [{ computed_amount_money: usd(int(500, 25000)) }],
        };
      case 'inventory_counts':
        return {
          catalog_object_id: `sim_var_${this.seed}_${i}`,
          location_id: 'LSIM',
          state: 'IN_STOCK',
          quantity: String(int(0, 40)),
          calculated_at: iso(i),
        };
      case 'refunds': {
        const amount = int(500, 20000);
        return {
          id: `sim_ref_${this.seed}_${i}`,
          status: 'COMPLETED',
          amount_money: usd(amount),
          created_at: iso(i),
          payment_id: `sim_pay_${this.seed}_${i}`,
          order_id: `sim_ord_${this.seed}_${i}`,
        };
      }
      default:
        return {};
    }
  }
}
