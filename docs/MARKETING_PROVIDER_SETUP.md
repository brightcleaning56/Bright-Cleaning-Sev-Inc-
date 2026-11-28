# Marketing: Google Ads and Meta connection setup

This is the owner checklist for connecting Google Ads and Meta Ads to Bright Clean Marketing.
The code is built and tested against mock provider endpoints. Real accounts need the steps below first.
Nothing here changes a live campaign: the connection is read-only (spend for the last 30 days).

## 1. Set the token key (both providers)

In Render, add a random secret named `MARKETING_TOKEN_KEY` (at least 32 characters). Provider tokens are
stored encrypted with it. If the key is lost, connections must be made again. Keep a copy somewhere safe.

## 2. Google Ads

1. Create or choose a Google Cloud project. Create an OAuth 2.0 client (type: Web application).
   - Authorized redirect URI: `https://brightclean.net/api/marketing/providers/google_ads/callback`
2. Apply for a Google Ads API developer token from the Google Ads manager account. Google moved access
   levels onto Cloud projects; check the current rules in the
   [access levels guide](https://developers.google.com/google-ads/api/docs/access-levels).
   - Basic access needs brand verification and an application review. Until it is approved, the token works
     only with Google Ads **test** accounts.
3. In Render, set:
   - `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`
   - `GOOGLE_ADS_DEVELOPER_TOKEN`
   - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (only if the sign-in account is a manager account; digits only)
   - Optional: `GOOGLE_ADS_API_BASE` if Google moves to a newer API version than the default in code.
     Confirm the version in the Google Ads API release notes before changing it.

## 3. Meta Ads

1. Create a Meta app (type: Business). Add the Marketing API product.
   - Valid OAuth redirect URI: `https://brightclean.net/api/marketing/providers/meta_ads/callback`
2. Complete Meta business verification for the business that owns the ad account.
3. Request the `ads_read` permission. Meta requires App Review for advanced access. Check the current
   requirements in the [Marketing API authorization guide](https://developers.facebook.com/docs/marketing-api/get-started/authorization).
   Until approved, only people with a role on the app can connect.
4. In Render, set:
   - `META_APP_ID`, `META_APP_SECRET`
   - Optional: `META_API_BASE` if Meta moves to a newer Graph API version than the default in code.

## 4. Connect and test (per provider)

1. Sign in as the owner. Open Marketing, then the Google Ads or Meta Ads screen. Click **Connect**.
2. Approve the sign-in. You return to Marketing with a confirmation.
3. Open **Campaign manager**, choose a campaign on the same channel, and enter its provider campaign ID.
4. Click **Sync spend now**. Spend appears on the campaign and on Performance & ROI.
5. Click **Sync spend now** again. The figures should stay the same, not double.

## What the connection does and does not do

- Reads campaign spend by day for the last 30 days.
- Writes spend only for Bright Clean campaigns that are linked to a provider campaign ID.
- Never creates, changes, pauses or budgets a campaign or ad at the provider.
- Tokens stay on the server, encrypted. They never appear in the browser.
- Google tokens refresh automatically. Meta long-lived tokens last about 60 days; when the status shows
  an error after that, click **Connect** again.

## Not in this release

- Conversion data, ad performance metrics (clicks, impressions) and campaign creation at the provider.
- Automatic background sync. Sync runs when the owner clicks **Sync spend now**.
- Choosing between several accounts. The first accessible account is connected.
- Currency other than USD in spend rows.
