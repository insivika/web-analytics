import { isValidScriptSecret } from '@/lib/ads/google';
import { getAdsWebsiteId } from '@/lib/ads/sync';
import { json, unauthorized } from '@/lib/response';
import { snapshotTrialForecast } from '@/queries/sql/reports/getTrialForecast';

// Nightly Vercel Cron: stores the day's conversion forecast (headline and per
// user) and records outcomes of earlier snapshots, for the accuracy line.
// Vercel sends `Authorization: Bearer $CRON_SECRET`.
export const maxDuration = 60;

export async function GET(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!isValidScriptSecret(token, process.env.CRON_SECRET)) {
    return unauthorized();
  }

  try {
    return json(await snapshotTrialForecast(getAdsWebsiteId()));
  } catch (e: any) {
    return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
