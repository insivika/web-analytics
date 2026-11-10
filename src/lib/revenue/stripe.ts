// Stripe revenue, read-only: charges, refunds and disputes with the balance
// transaction Stripe actually booked (amount, fee, net). Uses a restricted key.

export interface RevenueRow {
  source: 'stripe' | 'revenuecat';
  externalId: string;
  kind: 'payment' | 'refund' | 'dispute' | 'subscription';
  /** Raw id from the provider (Stripe metadata.user_id or customer id, RevenueCat customer id). */
  userRef: string | null;
  customerRef: string | null;
  occurredAt: Date;
  currency: string;
  amount: number;
  grossUsd: number | null;
  feeUsd: number | null;
  netUsd: number | null;
  product: string | null;
  refunded: boolean;
}

const cents = (n: unknown) => Math.round(Number(n ?? 0)) / 100;

/**
 * Balance transactions are in the account's settlement currency. When that is
 * USD (the usual case) the numbers are exact; otherwise the caller converts.
 */
function fromBalance(bt: any) {
  if (!bt || typeof bt !== 'object') return { gross: null, fee: null, net: null, currency: null };
  return {
    gross: cents(bt.amount),
    fee: cents(bt.fee),
    net: cents(bt.net),
    currency: String(bt.currency || '').toUpperCase(),
  };
}

const customerUserRef = (customer: any) =>
  customer && typeof customer === 'object' ? (customer.metadata?.user_id ?? null) : null;
const customerId = (customer: any) =>
  customer ? (typeof customer === 'string' ? customer : (customer.id ?? null)) : null;

export function mapStripeCharge(charge: any): RevenueRow | null {
  if (!charge || charge.status !== 'succeeded' || !charge.paid) return null;
  const bt = fromBalance(charge.balance_transaction);
  return {
    source: 'stripe',
    externalId: charge.id,
    kind: 'payment',
    userRef: customerUserRef(charge.customer),
    customerRef: customerId(charge.customer),
    occurredAt: new Date(charge.created * 1000),
    currency: String(charge.currency || 'usd').toUpperCase(),
    amount: cents(charge.amount),
    grossUsd: bt.currency === 'USD' ? bt.gross : null,
    feeUsd: bt.currency === 'USD' ? bt.fee : null,
    netUsd: bt.currency === 'USD' ? bt.net : null,
    product: charge.description ?? null,
    refunded: !!charge.refunded,
  };
}

/** Refunds reduce revenue: Stripe books them as negative balance transactions. */
export function mapStripeRefund(refund: any): RevenueRow | null {
  if (!refund || refund.status === 'failed' || refund.status === 'canceled') return null;
  const bt = fromBalance(refund.balance_transaction);
  const charge = refund.charge && typeof refund.charge === 'object' ? refund.charge : null;
  return {
    source: 'stripe',
    externalId: refund.id,
    kind: 'refund',
    userRef: customerUserRef(charge?.customer),
    customerRef: customerId(charge?.customer),
    occurredAt: new Date(refund.created * 1000),
    currency: String(refund.currency || 'usd').toUpperCase(),
    amount: -cents(refund.amount),
    grossUsd: bt.currency === 'USD' ? bt.gross : null,
    feeUsd: bt.currency === 'USD' ? bt.fee : null,
    netUsd: bt.currency === 'USD' ? bt.net : null,
    product: null,
    refunded: false,
  };
}

/** Disputes (chargebacks): sum of their balance transactions (amount + dispute fee). */
export function mapStripeDispute(dispute: any): RevenueRow | null {
  if (!dispute) return null;
  const bts: any[] = Array.isArray(dispute.balance_transactions)
    ? dispute.balance_transactions
    : [];
  const usd = bts.filter(b => String(b.currency).toUpperCase() === 'USD');
  const charge = dispute.charge && typeof dispute.charge === 'object' ? dispute.charge : null;
  const sum = (key: string) =>
    usd.length === bts.length && bts.length ? usd.reduce((s, b) => s + cents(b[key]), 0) : null;
  return {
    source: 'stripe',
    externalId: dispute.id,
    kind: 'dispute',
    userRef: customerUserRef(charge?.customer),
    customerRef: customerId(charge?.customer),
    occurredAt: new Date(dispute.created * 1000),
    currency: String(dispute.currency || 'usd').toUpperCase(),
    amount: -cents(dispute.amount),
    grossUsd: sum('amount'),
    feeUsd: sum('fee'),
    netUsd: sum('net'),
    product: null,
    refunded: false,
  };
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

/** Lists all objects of a Stripe list endpoint created since `since` (unix seconds). */
export async function listStripe(
  path: '/v1/charges' | '/v1/refunds' | '/v1/disputes',
  key: string,
  since: number,
  expand: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<any[]> {
  const items: any[] = [];
  let startingAfter: string | null = null;

  for (let page = 0; page < 200; page++) {
    const params = new URLSearchParams({ limit: '100', 'created[gte]': String(since) });
    for (const e of expand) params.append('expand[]', e);
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetchImpl(`https://api.stripe.com${path}?${params}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const body: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      throw new StripeApiError(
        res.status === 401 || res.status === 403
          ? `Stripe key rejected (${res.status}): ${msg}. Check STRIPE_RESTRICTED_KEY and its read permissions.`
          : `Stripe API error (${res.status}): ${msg}`,
        res.status,
      );
    }

    items.push(...(body.data ?? []));
    if (!body.has_more || !body.data?.length) break;
    startingAfter = body.data[body.data.length - 1].id;
  }

  return items;
}

/** All Stripe money movements (charges, refunds, disputes) since `since`. */
export async function fetchStripeRevenue(
  key: string,
  since: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RevenueRow[]> {
  const [charges, refunds, disputes] = await Promise.all([
    listStripe('/v1/charges', key, since, ['data.balance_transaction', 'data.customer'], fetchImpl),
    listStripe(
      '/v1/refunds',
      key,
      since,
      ['data.balance_transaction', 'data.charge.customer'],
      fetchImpl,
    ),
    listStripe('/v1/disputes', key, since, ['data.charge.customer'], fetchImpl),
  ]);

  return [
    ...charges.map(mapStripeCharge),
    ...refunds.map(mapStripeRefund),
    ...disputes.map(mapStripeDispute),
  ].filter((r): r is RevenueRow => r !== null);
}
