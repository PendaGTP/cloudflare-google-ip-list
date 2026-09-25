// Optional secret: when unset, the account is looked up from CLOUDFLARE_API_TOKEN.
interface Env {
	ACCOUNT_ID?: string;
}

declare namespace Cloudflare {
	interface Env {
		ACCOUNT_ID?: string;
	}
}
