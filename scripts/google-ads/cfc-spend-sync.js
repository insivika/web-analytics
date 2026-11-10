/**
 * Cash Flow Calendar — Google Ads spend → Umami ROI report (single account).
 *
 * Paste into Google Ads → Tools → Bulk actions → Scripts → (+) New script.
 * Set ENDPOINT and SECRET below, Authorize, Preview, then Run once with
 * MODE = 'backfill' (180 days), switch back to 'daily' and schedule it Daily.
 *
 * Read-only: it only reads reports and POSTs them to the endpoint. It never
 * changes campaigns, budgets or settings.
 */
var ENDPOINT = 'https://analytics.insivika.com/api/integrations/google-ads/spend';
var SECRET = 'PASTE_GOOGLE_ADS_SCRIPT_SECRET_HERE';
var MODE = 'daily'; // 'daily' = last 7 days, 'backfill' = last 180 days
var DAYS = { daily: 7, backfill: 180 };

function main() {
  var result = syncCurrentAccount(MODE);
  Logger.log(JSON.stringify(result));
}

/** Collects ad-level cost (plus a campaign-level remainder) and posts it. */
function syncCurrentAccount(mode) {
  var account = AdsApp.currentAccount();
  var tz = account.getTimeZone();
  var days = DAYS[mode] || 7;
  var end = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var start = Utilities.formatDate(new Date(Date.now() - (days - 1) * 86400000), tz, 'yyyy-MM-dd');

  var rows = [];
  var adTotals = {}; // campaignId|date -> {cost, impressions, clicks}

  var ads = AdsApp.search(
    'SELECT segments.date, campaign.id, campaign.name, ad_group.id, ad_group.name, ' +
      'ad_group_ad.ad.id, ad_group_ad.ad.name, metrics.cost_micros, metrics.impressions, metrics.clicks ' +
      'FROM ad_group_ad ' +
      "WHERE segments.date BETWEEN '" + start + "' AND '" + end + "'",
  );
  while (ads.hasNext()) {
    var r = ads.next();
    var cost = Number(r.metrics.costMicros || 0);
    var impressions = Number(r.metrics.impressions || 0);
    var clicks = Number(r.metrics.clicks || 0);
    if (!cost && !impressions && !clicks) continue;
    rows.push({
      date: r.segments.date,
      campaignId: String(r.campaign.id),
      campaignName: r.campaign.name,
      adGroupId: String(r.adGroup.id),
      adGroupName: r.adGroup.name,
      adId: String(r.adGroupAd.ad.id),
      adName: r.adGroupAd.ad.name || null,
      costMicros: cost,
      impressions: impressions,
      clicks: clicks,
    });
    var key = r.campaign.id + '|' + r.segments.date;
    var t = adTotals[key] || (adTotals[key] = { cost: 0, impressions: 0, clicks: 0 });
    t.cost += cost;
    t.impressions += impressions;
    t.clicks += clicks;
  }

  // Performance Max (and other campaign types) have no ad_group_ad rows, so add
  // whatever campaign-level cost isn't covered by ads as a remainder row.
  var campaigns = AdsApp.search(
    'SELECT segments.date, campaign.id, campaign.name, campaign.advertising_channel_type, ' +
      'metrics.cost_micros, metrics.impressions, metrics.clicks ' +
      'FROM campaign ' +
      "WHERE segments.date BETWEEN '" + start + "' AND '" + end + "'",
  );
  while (campaigns.hasNext()) {
    var c = campaigns.next();
    var k = c.campaign.id + '|' + c.segments.date;
    var covered = adTotals[k] || { cost: 0, impressions: 0, clicks: 0 };
    var restCost = Number(c.metrics.costMicros || 0) - covered.cost;
    var restImpr = Number(c.metrics.impressions || 0) - covered.impressions;
    var restClicks = Number(c.metrics.clicks || 0) - covered.clicks;
    if (restCost > 0 || restImpr > 0 || restClicks > 0) {
      rows.push({
        date: c.segments.date,
        campaignId: String(c.campaign.id),
        campaignName: c.campaign.name,
        adGroupId: null,
        adGroupName: null,
        adId: 'campaign-' + c.campaign.id,
        adName: '(campaign level: ' + c.campaign.advertisingChannelType + ')',
        costMicros: Math.max(0, restCost),
        impressions: Math.max(0, restImpr),
        clicks: Math.max(0, restClicks),
      });
    }
  }

  var payload = {
    customerId: account.getCustomerId(),
    currency: account.getCurrencyCode(),
    rangeStart: start,
    rangeEnd: end,
    mode: mode,
    rows: rows,
  };

  var totalCost = rows.reduce(function (s, x) { return s + x.costMicros; }, 0) / 1e6;
  Logger.log(account.getName() + ' (' + payload.customerId + '): ' + rows.length + ' rows, ' +
    totalCost.toFixed(2) + ' ' + payload.currency + ', ' + start + '..' + end);

  if (AdsApp.getExecutionInfo().isPreview()) {
    Logger.log('Preview mode: posting anyway so you can confirm rows land in the ROI report.');
  }

  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ads-secret': SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) {
    throw new Error('Upload failed: HTTP ' + code + ' ' + text.slice(0, 500));
  }
  return { customerId: payload.customerId, rows: rows.length, cost: totalCost, response: JSON.parse(text) };
}
