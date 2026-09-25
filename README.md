# cloudflare-google-ip-list

Cloudflare Worker that keeps a Cloudflare [IP list](https://developers.cloudflare.com/waf/tools/lists/custom-lists/) in sync with Google's published IP ranges (by default <https://www.gstatic.com/ipranges/goog.json>).

Once the list exists, you can reference it from WAF custom rules, rate limiting rules, and other rules that accept IP lists. It is refreshed every 6 hours, so you don't have to update it yourself.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PendaGTP/cloudflare-google-ip-list)

## Requirements

- A Cloudflare account. The Free plan allows one custom list; check [list limits](#limits) if you already use lists.
- An API token with the **Account → Account Filter Lists → Edit** permission.

## Deploy

### 1. Create an API token

1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → **Create Custom Token**.
2. Under **Permissions**, add **Account** / **Account Filter Lists** / **Edit**.
3. Under **Account Resources**, pick the account that should own the list.
4. Create the token and copy it.

### 2a. Deploy with the button

Click **Deploy to Cloudflare** above. Cloudflare forks this repository into your GitHub account, creates the KV namespace, and asks for:

| Name                   | Required | Value                  |
| ---------------------- | -------- | ---------------------- |
| `CLOUDFLARE_API_TOKEN` | Yes      | The token from step 1. |

If the token can access more than one account, set `ACCOUNT_ID` in `wrangler.jsonc` in your fork and push. The fork redeploys on push. See [Configuration](#configuration).

### 2b. Deploy from a clone

```sh
git clone https://github.com/PendaGTP/cloudflare-google-ip-list.git
cd cloudflare-google-ip-list
npm ci
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler deploy
```

On the first deploy, Wrangler creates the KV namespace and writes its ID into `wrangler.jsonc`. Commit that change so later deploys reuse the same namespace.

### 3. Check that it worked

The first sync runs at the next cron trigger (every 6 hours, on the hour, UTC). After it runs:

- **Manage Account → Configurations → Lists** shows a list named `google`.
- The worker's logs (**Workers & Pages → cloudflare-google-ip-list → Observability**) contain a `sync.complete` event.

To sync right away instead of waiting, see [Run a sync locally](#run-a-sync-locally).

## Use the list in a rule

Lists are referenced as `$<list name>`. For example, a WAF custom rule that skips or blocks requests from Google:

```txt
(ip.src in $google)
```

Rules can also exclude the list:

```txt
(http.request.uri.path starts_with "/admin" and not ip.src in $google)
```

> [!WARNING]
> `goog.json` contains every Google-owned range, **including the ranges Google Cloud customers use for their VMs**. Anyone can rent an IP in these ranges, so don't treat the list as "trusted Google traffic" when allowlisting. If you want to verify crawlers, use the Googlebot ranges listed under [Other Google sources](#other-google-sources) instead.

## Configuration

Set these in the `vars` section of [`wrangler.jsonc`](wrangler.jsonc) and redeploy:

| Variable               | Default                                      | Description                                                                                                                        |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_IP_RANGES_URL` | `https://www.gstatic.com/ipranges/goog.json` | Source of the IP ranges. Any URL that returns Google's `{"prefixes": [{"ipv4Prefix": …}, {"ipv6Prefix": …}]}` format works.        |
| `IP_LIST_NAME`         | `google`                                     | Name of the Cloudflare list to create and keep in sync. This is the name you use in rule expressions.                              |
| `ACCOUNT_ID`           | _(empty)_                                    | Account that owns the list. When empty, the worker uses the only account the token can access, and fails if it can access several. |

Secrets:

| Secret                 | Required | Description                                    |
| ---------------------- | -------- | ---------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | Yes      | API token with **Account Filter Lists: Edit**. |

The schedule is set in `triggers.crons` (default `0 */6 * * *`).

### Other Google sources

| Source                              | URL                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| All Google-owned ranges (default)   | `https://www.gstatic.com/ipranges/goog.json`                                  |
| Google Cloud customer ranges        | `https://www.gstatic.com/ipranges/cloud.json`                                 |
| Googlebot and other common crawlers | `https://developers.google.com/static/crawling/ipranges/common-crawlers.json` |

To keep several lists in sync, deploy the worker once per source with a different worker `name`, `IP_LIST_NAME`, and `GOOGLE_IP_RANGES_URL`.

## How it works

On each cron trigger, the worker:

1. Downloads the ranges from `GOOGLE_IP_RANGES_URL` and collects every IPv4 and IPv6 prefix.
2. Looks for a list named `IP_LIST_NAME` in the account and creates it if it doesn't exist.
3. Compares a hash of the ranges with the hash stored in KV from the last successful sync. If the ranges and the list's item count haven't changed, it stops here.
4. Otherwise it **replaces every item in the list** with the downloaded ranges, waits for Cloudflare to finish the bulk update (up to 2 minutes), and stores the new hash.

> [!IMPORTANT]
> The worker owns the list. Anything you add to it by hand is removed at the next update. Put your own IPs in a separate list.

The worker logs structured events that you can search in Workers Observability:

| Event           | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `sync.start`    | A sync began.                                                                |
| `sync.skipped`  | The ranges hadn't changed; nothing was written.                              |
| `sync.complete` | The list was updated. Includes `cidrCount`, `listCreated`, `pollCount`, and `durationMs`. |
| `sync.failed`   | The sync failed. Includes the error `message`.                               |

## Limits

Cloudflare limits custom lists per account ([current limits](https://developers.cloudflare.com/waf/tools/lists/#availability)):

| Plan           | Custom lists | List items (total) |
| -------------- | ------------ | ------------------ |
| Free           | 1            | 10,000             |
| Pro / Business | 10           | 10,000             |
| Enterprise     | 1,000        | 500,000            |

`goog.json` currently has fewer than 200 prefixes, so it fits on every plan. On the Free plan, the list this worker creates uses your only custom list.

## Troubleshooting

| Error in `sync.failed`                                                        | Cause                                                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Failed to fetch Cloudflare accounts`                                         | `ACCOUNT_ID` is unset and the token can't list accounts. Set `ACCOUNT_ID`.          |
| `API token has access to N accounts; set ACCOUNT_ID to choose one`            | Set `ACCOUNT_ID` to the account that should own the list.                           |
| `Failed to fetch Cloudflare IP lists` / `Failed to create Cloudflare IP list` | The token is invalid or is missing **Account Filter Lists: Edit** for this account. |
| `Failed to create Cloudflare IP list: …limit…`                                | The account already has as many lists as its plan allows.                           |
| `Bulk operation … timed out`                                                  | Cloudflare didn't finish the update within 2 minutes. The next run retries.         |

## Development

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in CLOUDFLARE_API_TOKEN
```

| Command              | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `npm run dev`        | Run the worker locally.                                                 |
| `npm run lint`       | Lint with oxlint.                                                       |
| `npm run build`      | Bundle to `dist/` without deploying.                                    |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`. |

### Run a sync locally

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"
```

This runs a real sync against your Cloudflare account using the token in `.dev.vars`. KV state stays local.

## License

[MIT](LICENSE)
