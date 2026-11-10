# Ad spend setup (Meta + Google Ads → ROI report)

Steps only an account owner can do. Nothing here changes campaigns, budgets or
bids: the integrations are read-only, and the URL-parameter changes in section 4
are tracking-only.

The ROI report lives at **analytics.insivika.com → Cash Flow Calendar → Growth → ROI**.

## 0. Environment variables (Vercel project `web-analytics`, team `philipp-as-projects`)

Set these for **Production** and **Preview**. Values for the two secrets were
generated into `web-analytics/.env.ads.local` (git-ignored, never committed).

| Name | Value |
|---|---|
| `META_ACCESS_TOKEN` | System-user token with `ads_read` (section 1) |
| `META_AD_ACCOUNT_IDS` | Comma-separated ad account ids, e.g. `act_1234567890` (the `act_` prefix is optional) |
| `META_API_VERSION` | Optional. Defaults to `v27.0` (current as of Nov 2026; v24.0 was retired Nov 10, 2026) |
| `GOOGLE_ADS_SCRIPT_SECRET` | From `.env.ads.local`. Paste the same value into the Google Ads Script |
| `CRON_SECRET` | From `.env.ads.local`. Vercel sends it as `Authorization: Bearer …` to the nightly cron |
| `ADS_WEBSITE_ID` | Optional. Defaults to the Cash Flow Calendar website `19a70b61-1c6c-449c-8b83-197db764884f` |

CLI (from a folder linked to the project, or pass `--scope philipp-as-projects`):

```bash
vercel env add META_ACCESS_TOKEN production
vercel env add META_ACCESS_TOKEN preview
```

Repeat for each variable, then redeploy (env changes apply to new deployments only).

## 1. Meta (Facebook / Instagram) — read-only Insights access

Docs: <https://developers.facebook.com/docs/marketing-api/businessmanager/systemuser/install-apps-and-generate-tokens>,
<https://developers.facebook.com/docs/marketing-api/access>.

1. **App.** In <https://developers.facebook.com/apps> create (or pick) an app of type
   **Business**, owned by the same Business portfolio as the ad account. Add the
   **Marketing API** product. That grants *Limited access* (formerly "Standard"),
   which is enough to read your own ad accounts.
   - An app already exists for the iOS SDK (`816804350948650`). You can reuse it if
     it's a Business app in the same business. A separate "CFC Reporting" app keeps
     permissions cleaner.
2. **System user.** Open Business settings → **Users → System users**
   (<https://business.facebook.com/settings/system-users>) → **Add**. Name it
   `cfc-roi-reporting`, role **Employee** (Admin isn't needed for reading).
3. **Assign assets.** Select the system user → **Assign assets** → **Ad accounts**
   → select each account → grant the view/analyze permission (performance only; no
   "manage" needed). Also add the app to the system user under **Apps**.
4. **Token.** Click **Generate new token** → choose the app → expiration **Never**
   (the alternative is 60 days, which you'd then have to renew) → permission
   **`ads_read`** only → Generate. Copy it into `META_ACCESS_TOKEN`.
5. **Ad account id.** In Ads Manager, the account dropdown shows the id. Add it with
   or without `act_` to `META_AD_ACCOUNT_IDS`. Include the app-install campaign's
   account too; it shows up in the blended totals.

Exact labels in Business settings change occasionally. If a label differs, the
underlying model is the same: system user → assigned ad account → app → token
with `ads_read`.

**If the token breaks** (expired, revoked, password change), the nightly sync
records Meta error code 190. The ROI page's *Data health* panel shows "Meta access
token is invalid or expired"; generate a new token and update the env var.

## 2. Google Ads — Google Ads Script (no developer token)

Docs: <https://developers.google.com/google-ads/scripts/docs/getting-started>,
<https://developers.google.com/google-ads/scripts/docs/concepts/manager-scripts>.

1. In Google Ads: **Tools → Bulk actions → Scripts** → **+** → **New script**.
   Name it `CFC spend → ROI`.
2. Paste the contents of `scripts/google-ads/cfc-spend-sync.js`. If you run it from a
   manager (MCC) account, use `scripts/google-ads/cfc-spend-sync-mcc.js` instead and
   list the client ids in `ACCOUNT_IDS` (up to 50 accounts).
3. Set `SECRET` to the `GOOGLE_ADS_SCRIPT_SECRET` value. `ENDPOINT` is already
   `https://analytics.insivika.com/api/integrations/google-ads/spend`.
4. Click **Authorize** (once per script), then **Preview**. The log shows rows and
   total cost per account, e.g. `CFC (1234567890): 85 rows, 412.37 USD`. Preview
   still posts to the endpoint, so you can confirm rows land (section 5).
5. **Backfill once.** Set `MODE = 'backfill'` (180 days), click **Run**, then set
   `MODE = 'daily'` back and save.
6. **Schedule.** In the scripts list, set frequency to **Daily**, ideally early
   morning in the account time zone.
7. Note the **customer id** (top right, `123-456-7890`). It's stored without dashes.

How totals stay complete: the script reads ad-level cost from `ad_group_ad`.
Performance Max has no ad-level rows, so it adds a per-campaign remainder row
(`campaign-<id>`, "campaign level"). That keeps daily totals equal to the
campaign totals in the UI.

## 3. FX rates

Spend and revenue are converted to USD with daily ECB rates from
<https://api.frankfurter.dev> (no key). Weekends and holidays reuse the last
rate, up to 7 days back. If the source is ever unreachable, add rows to `fx_rate`
with `source = 'manual'` (USD per 1 unit). Manual rows win over fetched ones.

## 4. Ad URL parameters (tracking only, do this in the ad platforms)

These make clicks carry campaign and ad ids, so landing-page visits, store-button
taps and signups can be tied back to spend. The landing page already captures
UTMs, `fbclid` and `gclid`/`gbraid`/`wbraid`.

**Meta:** in Ads Manager, on each ad (bulk-select all ads → Edit) → **Tracking**
→ **URL parameters**:

```
utm_source=fb&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}
```

Use `utm_source=ig` for Instagram-only placements if you split them, or
`{{site_source_name}}`, which resolves to fb/ig/an/msg. Meta appends `fbclid`
itself.

**Google:**
1. **Admin → Account settings → Auto-tagging** → check *Tag the URL that people
   click through from my ad* → Save (adds `gclid`). It's usually on already.
2. **Admin → Account settings → Tracking → Final URL suffix**:
   ```
   utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}
   ```
3. Changes take effect for new clicks within about 24–48 hours.

I couldn't verify the exact current Ads Manager label for URL parameters and the
full ValueTrack list (`{campaignid}`, `{creative}`) against Meta's and Google's
pages this time. Use the platform's URL preview to confirm the parameters expand.

## 5. Verify after adding credentials

1. **Meta:** open ROI → *Data health* → **Sync Meta now** (7 days), then
   **Backfill 180 days** once. *Last successful sync* updates, and *Spend by
   campaign* fills in.
2. **Google:** run the script **Preview**. The log ends with the endpoint's JSON
   response (`"status":"success","rows":…`), and Google campaigns appear in
   *Spend by campaign*.
3. **Totals within 1%:** compare the last 7 complete days in Ads Manager and Google
   Ads (same accounts, same date range) with the ROI page's per-campaign spend, or
   query directly:
   ```sql
   select channel, sum(spend) local_spend, sum(spend_usd) usd
   from ad_spend
   where website_id = '19a70b61-1c6c-449c-8b83-197db764884f'
     and date between current_date - 7 and current_date - 1
   group by 1;
   ```
   Platform days follow each ad account's own time zone, so compare in that
   time zone.
4. **Cron:** after the next 10:00 UTC run, *Last successful sync* for meta and fx
   shows today's date.

## 6. Staging

Preview deployments of `web-analytics` get the same env vars if they're set for
**Preview**. Run **Sync Meta now** on the preview URL. For Google, point a copy of
the script's `ENDPOINT` at the preview URL and run **Preview**. Vercel Cron only
runs on Production.


## Revenue from Stripe and RevenueCat

The ROI page compares ad spend with the money that actually came in: ad spend →
website visitors (sessions on `www.cashflowcalendar.app`) → trial starts →
paying customers → their revenue to date. Revenue comes straight from Stripe
(charges, refunds, disputes, with the fees Stripe booked) and RevenueCat
(subscription and purchase revenue after store commission and tax). Nothing is
estimated from prices or fee rates.

Users are matched through a read-only Supabase view: Stripe `customer.metadata.user_id`
(Supabase id or older Firebase uid) or `stripe_customer_id`, and the RevenueCat
customer id (= Firebase uid), resolve to the Supabase `user_id` that Umami events carry.

### 1. Supabase read-only role

1. Open `scripts/supabase/roi-readonly.sql`, replace `CHANGE_ME` with a long random
   password (only in the SQL editor, not in the file), run it in Supabase → SQL editor.
2. Connection string: Supabase → Connect → Session pooler (IPv4). Swap the user for
   `roi_reader.<project-ref>` and the password for the one you set.
   That is `SUPABASE_READONLY_DATABASE_URL`.

### 2. Stripe restricted key (read-only)

Stripe Dashboard → Developers → API keys → Create restricted key → "Building your own
integration". Set **Read** for: Charges, Refunds, Disputes, Customers, Balance
transactions (shown as "Balance"). Everything else stays **None**. Name it
`umami-roi-readonly`. That is `STRIPE_RESTRICTED_KEY` (`rk_live_…`).

### 3. RevenueCat API v2 key (read-only)

RevenueCat → Project settings → API keys → + New secret API key → version **V2**.
Set Read only for: Customer information (customers, subscriptions, purchases) and
Charts & metrics. Everything else No access. That is `REVENUECAT_API_KEY`
(`sk_…`). `REVENUECAT_PROJECT_ID` is the `proj…` id in the dashboard URL.

### 4. Vercel env vars (Production and Preview), then redeploy

| Name | Value |
|---|---|
| `SUPABASE_READONLY_DATABASE_URL` | step 1 |
| `STRIPE_RESTRICTED_KEY` | step 2 |
| `REVENUECAT_API_KEY` | step 3 |
| `REVENUECAT_PROJECT_ID` | step 3 |
| `ROI_MARKETING_HOSTNAME` | optional, default `www.cashflowcalendar.app` |
| `SUPABASE_CA_CERT` | optional, only if the TLS check fails (PEM from Supabase → Database → SSL) |

### 5. First sync

ROI page → Data health → **Backfill revenue (2 years)** once. After that the nightly
cron refreshes Stripe (last 14 days) and RevenueCat (newest trial starters every
night, older ones in rotation). Check against Stripe (Balance → Net volume) and
RevenueCat (Charts → Revenue, proceeds) for the same dates.
