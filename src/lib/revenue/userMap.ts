// Maps provider ids to the Supabase profile user_id (the id Umami events carry as
// user_id). Read from a read-only Supabase view (roi.user_map) that exposes only
// user_id, firebase_user_id and stripe_customer_id.

export interface UserMapRow {
  user_id: string;
  firebase_user_id: string | null;
  stripe_customer_id: string | null;
}

export interface UserMap {
  /** Supabase user_id for a Stripe metadata.user_id / customer id / RevenueCat customer id. */
  resolve(ref: string | null | undefined, customerRef?: string | null): string | null;
  /** Firebase uid (= RevenueCat customer id) for a Supabase user_id. */
  firebaseUid(userId: string): string | null;
  size: number;
}

export function buildUserMap(rows: UserMapRow[]): UserMap {
  const byUserId = new Map<string, UserMapRow>();
  const byFirebase = new Map<string, string>();
  const byStripe = new Map<string, string>();

  for (const row of rows) {
    if (!row.user_id) continue;
    byUserId.set(row.user_id, row);
    if (row.firebase_user_id) byFirebase.set(row.firebase_user_id, row.user_id);
    if (row.stripe_customer_id) byStripe.set(row.stripe_customer_id, row.user_id);
  }

  return {
    // metadata.user_id is a Supabase uuid or an older Firebase uid; fall back to
    // the Stripe customer id recorded on the profile.
    resolve(ref, customerRef) {
      if (ref && byUserId.has(ref)) return ref;
      if (ref && byFirebase.has(ref)) return byFirebase.get(ref) ?? null;
      if (customerRef && byStripe.has(customerRef)) return byStripe.get(customerRef) ?? null;
      return null;
    },
    firebaseUid(userId) {
      return byUserId.get(userId)?.firebase_user_id ?? null;
    },
    size: byUserId.size,
  };
}

/**
 * Loads the mapping from Supabase over SUPABASE_READONLY_DATABASE_URL. TLS is
 * verified; set SUPABASE_CA_CERT (PEM, from Supabase → Database → SSL) if the
 * default trust store doesn't include Supabase's CA.
 */
export async function loadUserMap(connectionString = process.env.SUPABASE_READONLY_DATABASE_URL) {
  if (!connectionString) {
    throw new Error(
      'SUPABASE_READONLY_DATABASE_URL is not set (read-only access to roi.user_map).',
    );
  }
  const { Client } = await import('pg');
  const ca = process.env.SUPABASE_CA_CERT?.replace(/\\n/g, '\n');
  const client = new Client({ connectionString, ...(ca ? { ssl: { ca } } : {}) });
  await client.connect();
  try {
    const { rows } = (await client.query(
      'select user_id::text as user_id, firebase_user_id, stripe_customer_id from roi.user_map',
    )) as { rows: UserMapRow[] };
    return buildUserMap(rows);
  } finally {
    await client.end().catch(() => {});
  }
}
