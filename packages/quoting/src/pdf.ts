import type { QuoteLineRow, QuoteRow } from './schema';

/**
 * Document generation for quotes.
 *
 * `QuoteDocumentProvider` is the pluggable interface; the module ships ONLY
 * the `HtmlQuoteDocumentAdapter`, which produces a self-contained,
 * print-ready HTML document (open it and hit "print to PDF"). A real
 * PDF-bytes adapter (headless browser, pdf lib, external service, ...) is
 * intentionally NOT implemented here — implement this interface in apps/api
 * or an infra package and pass it to `quotingRouter(deps, { documentProvider })`.
 */

export interface QuoteDocumentModel {
  quote: QuoteRow;
  lines: QuoteLineRow[];
  tenantName: string;
  /** ISO-8601 UTC render time. */
  generatedAt: string;
}

export interface RenderedQuoteDocument {
  /** e.g. "text/html; charset=utf-8" or "application/pdf". */
  contentType: string;
  /** HTML string or binary PDF bytes. */
  content: string | Uint8Array;
}

export interface QuoteDocumentProvider {
  render(model: QuoteDocumentModel): Promise<RenderedQuoteDocument>;
}

function esc(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-US')}.${rem}`;
}

/**
 * Stub adapter: renders a print-ready HTML quote document. This is the
 * default provider wired by the router.
 */
export class HtmlQuoteDocumentAdapter implements QuoteDocumentProvider {
  async render(model: QuoteDocumentModel): Promise<RenderedQuoteDocument> {
    const { quote, lines, tenantName } = model;
    const rows = lines
      .map(
        (l) => `      <tr>
        <td>${esc(l.description)}</td>
        <td class="num">${l.quantity}</td>
        <td class="num">${money(l.effective_unit_price_cents)}</td>
        <td class="num">${money(l.total_cents)}</td>
      </tr>`,
      )
      .join('\n');

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quote ${esc(quote.id)}</title>
<style>
  @page { size: letter; margin: 2cm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; }
  .doc { max-width: 720px; margin: 0 auto; padding: 24px; }
  header { display: flex; justify-content: space-between; align-items: baseline;
           border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0; }
  .meta { font-size: 12px; color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; border-bottom: 1px solid #999; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #e2e2e2; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-top: 16px; margin-left: auto; width: 280px; font-size: 13px; }
  .totals div { display: flex; justify-content: space-between; padding: 3px 8px; }
  .totals .grand { border-top: 2px solid #1a1a1a; font-weight: bold; font-size: 15px; }
  .notes { margin-top: 24px; font-size: 12px; color: #444; white-space: pre-wrap; }
  footer { margin-top: 32px; font-size: 11px; color: #777; }
  @media print { .doc { padding: 0; } }
</style>
</head>
<body>
<div class="doc">
  <header>
    <div>
      <h1>${esc(tenantName)}</h1>
      <div class="meta">Quote ${esc(quote.id)} &middot; ${esc(quote.title)}</div>
    </div>
    <div class="meta">
      <div>Status: ${esc(quote.status)}</div>
      <div>Customer: ${esc(quote.customer_id)}</div>
      ${quote.valid_until ? `<div>Valid until: ${esc(quote.valid_until)}</div>` : ''}
    </div>
  </header>
  <table>
    <thead>
      <tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${money(quote.subtotal_cents)}</span></div>
    <div><span>Discount</span><span>-${money(quote.discount_cents)}</span></div>
    <div><span>Tax</span><span>${money(quote.tax_cents)}</span></div>
    <div class="grand"><span>Total</span><span>${money(quote.total_cents)}</span></div>
  </div>
  ${quote.notes ? `<div class="notes">${esc(quote.notes)}</div>` : ''}
  <footer>Generated ${esc(model.generatedAt)}</footer>
</div>
</body>
</html>`;
    return { contentType: 'text/html; charset=utf-8', content: html };
  }
}
