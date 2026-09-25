# cloudflare-google-ip-list

Cloudflare Worker that syncs Google's public IP ranges (default is <https://www.gstatic.com/ipranges/goog.json>) into a Cloudflare account IP list.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PendaGTP/cloudflare-google-ip-list)

## Deploy

1. [Create an API token](https://dash.cloudflare.com/profile/api-tokens) with the **Account → Account Filter Lists → Edit** permission.
2. Click **Deploy to Cloudflare** above and paste the token when prompted for `CLOUDFLARE_API_TOKEN`. The KV namespace is created for you.

Or deploy from a clone:

```sh
npm ci
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler deploy
```

The KV namespace is provisioned automatically on the first deploy.

`ACCOUNT_ID` is optional. When unset, the worker uses the only account the token can access. Set it if the token can access several accounts.
