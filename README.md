# cloudflare-google-ip-list

Keeps a Cloudflare **Account IP List** in sync with [Google's published IP ranges](https://www.gstatic.com/ipranges/goog.json) (`goog.json`).

Sync runs on a **cron trigger only** (every 6 hours UTC). There is no public HTTP endpoint to trigger sync.

## Setup

### 1. KV namespace

Create production and preview namespaces, then set the ids in [wrangler.jsonc](wrangler.jsonc):

```bash
npx wrangler kv namespace create STATE
npx wrangler kv namespace create STATE --preview
```

Replace `REPLACE_WITH_KV_NAMESPACE_ID` and `REPLACE_WITH_KV_PREVIEW_NAMESPACE_ID` with the returned ids.

KV stores a SHA-256 hash of the sorted CIDR set (`google-ip-list:cidr-hash`) to skip no-op updates.

### 2. Secrets

For local development, copy [.dev.vars.example](.dev.vars.example) to `.dev.vars` and fill in values.

For production:

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put ACCOUNT_ID
```

### 3. API token permissions

The token needs permission to manage Account Filter Lists for the target account, including:

- Read lists
- Create lists (first run)
- Edit list items (bulk replace)

Use a token scoped to the account that owns the IP list.

### 4. Deploy

```bash
npm run deploy
```

Confirm **Workers → Triggers → Cron Triggers** shows `0 */6 * * *`.

After deploy, use **Trigger cron** in the dashboard (or wait for the schedule) and verify the IP list item count matches Google's feed (~145 prefixes today) and the KV key exists.

## Configuration

| Name | Source | Purpose |
|------|--------|---------|
| `GOOGLE_IP_RANGES_URL` | `wrangler.jsonc` var | Google JSON feed |
| `IP_LIST_NAME` | `wrangler.jsonc` var | Cloudflare list name |
| `CLOUDFLARE_API_TOKEN` | secret | Lists API auth |
| `ACCOUNT_ID` | secret | Target account |
| `STATE` | KV binding | Last synced CIDR hash |

## Development

```bash
npm run dev
```

Cron triggers do not run automatically in `wrangler dev`; use the dashboard **Trigger cron** on a deployed worker for end-to-end checks.

```bash
npm test
```
