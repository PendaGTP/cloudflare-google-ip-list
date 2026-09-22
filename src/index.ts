const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

const BULK_POLL_INTERVAL_MS = 1_000;
const BULK_POLL_TIMEOUT_MS = 120_000;

type GoogleIpPrefix = {
	ipv4Prefix?: string;
	ipv6Prefix?: string;
};

type GoogleIpRanges = {
	syncToken: string;
	creationTime: string;
	prefixes: GoogleIpPrefix[];
};

type CloudflareIpList = {
	id: string;
	name: string;
	kind: string;
	num_items: number;
	num_referencing_filters: number;
	created_on: string;
	modified_on: string;
};

type CloudflareApiError = {
	code: number;
	message: string;
};

type CloudflareListsResponse = {
	result: CloudflareIpList[];
	success: boolean;
	errors: CloudflareApiError[];
	messages: unknown[];
};

type CloudflareListResponse = {
	result: CloudflareIpList;
	success: boolean;
	errors: CloudflareApiError[];
	messages: unknown[];
};

type CloudflareBulkOperationResponse = {
	result: { operation_id: string } | null;
	success: boolean;
	errors: CloudflareApiError[];
	messages: unknown[];
};

type BulkOperationStatus = 'pending' | 'running' | 'completed' | 'failed';

type CloudflareBulkOperationStatusResponse = {
	result: {
		id: string;
		status: BulkOperationStatus;
		error?: string;
	} | null;
	success: boolean;
	errors: CloudflareApiError[];
	messages: unknown[];
};

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(sync(env).catch((err) => console.error('sync failed', err)));
	},
} satisfies ExportedHandler<Env>;

async function findIpList(env: Env) {
	const res = await fetch(`${CLOUDFLARE_API}/accounts/${env.ACCOUNT_ID}/rules/lists`, {
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
		},
	});

	const data = await res.json<CloudflareListsResponse>();
	if (!res.ok || !data.success) throw new Error(`Failed to fetch Cloudflare IP lists: ${res.statusText}`);

	return data.result.find((list) => list.name === env.IP_LIST_NAME);
}

async function createIpList(env: Env) {
	const res = await fetch(`${CLOUDFLARE_API}/accounts/${env.ACCOUNT_ID}/rules/lists`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			name: env.IP_LIST_NAME,
			kind: 'ip',
			description: 'Google IP ranges',
		}),
	});

	const data = await res.json<CloudflareListResponse>();
	if (!res.ok || !data.success) {
		let message;
		if (data.errors.length == 0) message = JSON.stringify(data);
		else message = data.errors.map((error) => error.message).join(', ');
		throw new Error(`Failed to create Cloudflare IP list: ${message}`);
	}

	return data.result;
}

async function updateIpList(env: Env, listId: string, cidrs: string[]) {
	const res = await fetch(`${CLOUDFLARE_API}/accounts/${env.ACCOUNT_ID}/rules/lists/${listId}/items`, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(cidrs.map((cidr) => ({ ip: cidr }))),
	});

	const data = await res.json<CloudflareBulkOperationResponse>();
	if (!res.ok || !data.success) {
		const message = data.errors.map((error) => error.message).join(', ');
		throw new Error(`Failed to update Cloudflare IP list: ${message}`);
	}

	const operationId = data.result?.operation_id;
	if (!operationId) {
		throw new Error('Failed to update Cloudflare IP list: missing operation_id');
	}

	return operationId;
}

async function waitForBulkOperation(env: Env, operationId: string, options: { intervalMs?: number; timeoutMs?: number } = {}) {
	const intervalMs = options.intervalMs ?? BULK_POLL_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? BULK_POLL_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const res = await fetch(`${CLOUDFLARE_API}/accounts/${env.ACCOUNT_ID}/rules/lists/bulk_operations/${operationId}`, {
			headers: {
				Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
			},
		});
		if (!res.ok) throw new Error(`Failed to fetch bulk operation status: ${res.statusText}`);

		const data = await res.json<CloudflareBulkOperationStatusResponse>();
		if (!data.success || !data.result) {
			const message = data.errors.map((error) => error.message).join(', ');
			throw new Error(`Failed to fetch bulk operation status: ${message}`);
		}

		const { status, error } = data.result;
		if (status === 'completed') return;
		if (status === 'failed') {
			throw new Error(`Bulk operation failed: ${error ?? 'unknown error'}`);
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	throw new Error(`Bulk operation timed out after ${timeoutMs}ms`);
}

function cidrHashKey(listName: string) {
	return `${listName}:cidr-hash`;
}

async function hashCidrs(cidrs: string[]) {
	const bytes = new TextEncoder().encode(cidrs.join('\n'));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sync(env: Env) {
	const res = await fetch(env.GOOGLE_IP_RANGES_URL);
	if (!res.ok) throw new Error(`Failed to fetch Google IP ranges: ${res.statusText}`);

	const data = await res.json<GoogleIpRanges>();
	const cidrs = data.prefixes
		.map((prefix) => prefix.ipv4Prefix ?? prefix.ipv6Prefix)
		.filter((cidr): cidr is string => cidr !== undefined)
		.sort();

	const hash = await hashCidrs(cidrs);
	const [stored, existing] = await Promise.all([env.STATE.get(cidrHashKey(env.IP_LIST_NAME)), findIpList(env)]);

	const list = existing ?? (await createIpList(env));
	if (existing && stored === hash && existing.num_items === cidrs.length) {
		return `Unchanged ${cidrs.length} IP ranges; skipped update of ${list.name}`;
	}

	const operationId = await updateIpList(env, list.id, cidrs);
	await waitForBulkOperation(env, operationId);
	await env.STATE.put(cidrHashKey(env.IP_LIST_NAME), hash);

	return `Synced ${cidrs.length} IP ranges to Cloudflare IP list ${list.name}`;
}
