const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

const BULK_POLL_INITIAL_DELAY_MS = 1_000;
const BULK_POLL_MAX_DELAY_MS = 10_000;
const BULK_POLL_TIMEOUT_MS = 120_000;
const BULK_POLL_MAX_ATTEMPTS = 25;

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

type CloudflareAccount = {
	id: string;
	name: string;
};

type CloudflareApiResponse<T> = {
	result: T;
	success: boolean;
	errors: CloudflareApiError[];
	messages: unknown[];
};

type BulkOperationStatus = 'pending' | 'running' | 'completed' | 'failed';

type CloudflareBulkOperation = {
	id: string;
	status: BulkOperationStatus;
	error?: string;
};

type SyncOutcome =
	| { kind: 'skipped'; cidrCount: number; listId: string; listName: string }
	| { kind: 'complete'; cidrCount: number; listId: string; listName: string; listCreated: boolean; operationId: string };

type SyncOptions = {
	scheduledTime?: number;
};

function errorFields(err: unknown): { message: string; stack?: string } {
	if (err instanceof Error) {
		return { message: err.message, stack: err.stack };
	}
	return { message: String(err) };
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const { scheduledTime } = controller;
		ctx.waitUntil(
			sync(env, { scheduledTime }).catch((err) => {
				console.error({
					event: 'sync.failed',
					listName: env.IP_LIST_NAME,
					scheduledTime,
					...errorFields(err),
				});
				throw err;
			}),
		);
	},
} satisfies ExportedHandler<Env>;

/** Calls the Cloudflare API and returns `result`, throwing `Failed to <action>: …` on any HTTP or API error. */
async function cfApi<T>(env: Env, path: string, action: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
	const res = await fetch(`${CLOUDFLARE_API}${path}`, {
		method: init.method ?? 'GET',
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
			...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});

	let data: CloudflareApiResponse<T> | undefined;
	try {
		data = await res.json<CloudflareApiResponse<T>>();
	} catch {
		// Non-JSON body, e.g. an HTML error page from a proxy.
	}

	if (!res.ok || !data?.success) {
		const details = data?.errors?.length ? data.errors.map((error) => `${error.message} (${error.code})`).join(', ') : 'no error details';
		throw new Error(`Failed to ${action}: HTTP ${res.status}, ${details}`);
	}

	return data.result;
}

async function resolveAccountId(env: Env) {
	if (env.ACCOUNT_ID) {
		return env.ACCOUNT_ID;
	}

	const accounts = await cfApi<CloudflareAccount[]>(env, '/accounts', 'fetch Cloudflare accounts');
	if (accounts.length !== 1) {
		throw new Error(`API token has access to ${accounts.length} accounts; set ACCOUNT_ID to choose one`);
	}

	return accounts[0].id;
}

async function findIpList(env: Env, accountId: string) {
	const lists = await cfApi<CloudflareIpList[]>(env, `/accounts/${accountId}/rules/lists`, 'fetch Cloudflare IP lists');
	return lists.find((list) => list.name === env.IP_LIST_NAME);
}

async function createIpList(env: Env, accountId: string) {
	return cfApi<CloudflareIpList>(env, `/accounts/${accountId}/rules/lists`, 'create Cloudflare IP list', {
		method: 'POST',
		body: { name: env.IP_LIST_NAME, kind: 'ip', description: 'Google IP ranges' },
	});
}

async function updateIpList(env: Env, accountId: string, listId: string, cidrs: string[]) {
	const result = await cfApi<{ operation_id: string } | null>(
		env,
		`/accounts/${accountId}/rules/lists/${listId}/items`,
		'update Cloudflare IP list',
		{ method: 'PUT', body: cidrs.map((cidr) => ({ ip: cidr })) },
	);

	const operationId = result?.operation_id;
	if (!operationId) {
		throw new Error('Failed to update Cloudflare IP list: missing operation_id');
	}

	return operationId;
}

type BulkPollOptions = {
	initialDelayMs?: number;
	maxDelayMs?: number;
	timeoutMs?: number;
	maxAttempts?: number;
};

export function bulkPollDelay(attempt: number, initialDelayMs = BULK_POLL_INITIAL_DELAY_MS, maxDelayMs = BULK_POLL_MAX_DELAY_MS) {
	return Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
}

/** Polls the bulk operation until it completes and returns the number of status requests made. */
export async function waitForBulkOperation(env: Env, accountId: string, operationId: string, options: BulkPollOptions = {}) {
	const initialDelayMs = options.initialDelayMs ?? BULK_POLL_INITIAL_DELAY_MS;
	const maxDelayMs = options.maxDelayMs ?? BULK_POLL_MAX_DELAY_MS;
	const timeoutMs = options.timeoutMs ?? BULK_POLL_TIMEOUT_MS;
	const maxAttempts = options.maxAttempts ?? BULK_POLL_MAX_ATTEMPTS;
	const startedAt = Date.now();
	const deadline = startedAt + timeoutMs;

	let attempts = 0;
	while (attempts < maxAttempts && Date.now() < deadline) {
		attempts++;
		const operation = await cfApi<CloudflareBulkOperation | null>(
			env,
			`/accounts/${accountId}/rules/lists/bulk_operations/${operationId}`,
			'fetch bulk operation status',
		);
		if (!operation) {
			throw new Error('Failed to fetch bulk operation status: empty result');
		}

		const { status, error } = operation;
		if (status === 'completed') {
			return attempts;
		}
		if (status === 'failed') {
			throw new Error(`Bulk operation failed: ${error ?? 'unknown error'}`);
		}

		const delayMs = Math.min(bulkPollDelay(attempts - 1, initialDelayMs, maxDelayMs), deadline - Date.now());
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	throw new Error(`Bulk operation ${operationId} timed out after ${attempts} polls / ${Date.now() - startedAt}ms`);
}

function cidrHashKey(listName: string) {
	return `${listName}:cidr-hash`;
}

async function hashCidrs(cidrs: string[]) {
	const bytes = new TextEncoder().encode(cidrs.join('\n'));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sync(env: Env, options: SyncOptions = {}): Promise<SyncOutcome> {
	const startedAt = Date.now();
	const { scheduledTime } = options;

	console.log({
		event: 'sync.start',
		listName: env.IP_LIST_NAME,
		scheduledTime,
	});

	const res = await fetch(env.GOOGLE_IP_RANGES_URL);
	if (!res.ok) {
		throw new Error(`Failed to fetch Google IP ranges: ${res.statusText}`);
	}

	const data = await res.json<GoogleIpRanges>();
	const cidrs = data.prefixes
		.map((prefix) => prefix.ipv4Prefix ?? prefix.ipv6Prefix)
		.filter((cidr): cidr is string => cidr !== undefined)
		.toSorted();

	const hash = await hashCidrs(cidrs);
	const accountId = await resolveAccountId(env);
	const [stored, existing] = await Promise.all([env.STATE.get(cidrHashKey(env.IP_LIST_NAME)), findIpList(env, accountId)]);

	const listCreated = !existing;
	const list = existing ?? (await createIpList(env, accountId));
	if (existing && stored === hash && existing.num_items === cidrs.length) {
		console.log({
			event: 'sync.skipped',
			listName: env.IP_LIST_NAME,
			cidrCount: cidrs.length,
			listId: list.id,
			scheduledTime,
			durationMs: Date.now() - startedAt,
		});
		return { kind: 'skipped', cidrCount: cidrs.length, listId: list.id, listName: list.name };
	}

	const operationId = await updateIpList(env, accountId, list.id, cidrs);
	const pollCount = await waitForBulkOperation(env, accountId, operationId);
	await env.STATE.put(cidrHashKey(env.IP_LIST_NAME), hash);

	console.log({
		event: 'sync.complete',
		listName: env.IP_LIST_NAME,
		cidrCount: cidrs.length,
		listId: list.id,
		listCreated,
		operationId,
		pollCount,
		scheduledTime,
		durationMs: Date.now() - startedAt,
	});
	return { kind: 'complete', cidrCount: cidrs.length, listId: list.id, listName: list.name, listCreated, operationId };
}
