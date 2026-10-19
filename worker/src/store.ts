/**
 * Agent data in the DATA_KV namespace:
 *   config        - voice guide, watchlist, default visibility (synced from the private config repo)
 *   history       - every post, reshare, suggestion and rejection (newest first, capped)
 *   dedupe:<hash> - recent post fingerprints, expire after 24h
 */
import type { Visibility } from "./linkedin";

export interface WatchlistEntry {
	name: string;
	profile_url?: string;
	notes?: string;
}

export interface AgentConfig {
	voice_guide?: string;
	watchlist?: WatchlistEntry[];
	default_visibility?: Visibility;
	updated_at?: string;
}

export type HistoryKind = "post" | "reshare" | "deleted" | "suggested" | "rejected" | "skipped" | "unknown";

export interface HistoryEntry {
	id: string;
	at: string;
	kind: HistoryKind;
	urn?: string; // the post we created (post/reshare/deleted)
	parent?: string; // the post we reshared or considered (suggested/rejected/skipped)
	post_url?: string;
	visibility?: Visibility;
	text_preview?: string;
	reason?: string;
}

const HISTORY_KEY = "history";
const HISTORY_CAP = 500;
const DEDUPE_TTL_SECONDS = 24 * 3600;

export async function getConfig(kv: KVNamespace): Promise<AgentConfig> {
	return ((await kv.get("config", "json")) as AgentConfig | null) ?? {};
}

export async function updateConfig(kv: KVNamespace, patch: Partial<AgentConfig>): Promise<AgentConfig> {
	const current = await getConfig(kv);
	const next: AgentConfig = { ...current };
	for (const [k, v] of Object.entries(patch)) {
		if (v !== undefined) (next as Record<string, unknown>)[k] = v;
	}
	next.updated_at = new Date().toISOString();
	await kv.put("config", JSON.stringify(next));
	return next;
}

export async function getHistory(kv: KVNamespace): Promise<HistoryEntry[]> {
	return ((await kv.get(HISTORY_KEY, "json")) as HistoryEntry[] | null) ?? [];
}

export async function appendHistory(
	kv: KVNamespace,
	entry: Omit<HistoryEntry, "id" | "at">,
): Promise<HistoryEntry> {
	const full: HistoryEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
	const history = await getHistory(kv);
	history.unshift(full);
	await kv.put(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_CAP)));
	return full;
}

export async function getDedupe(kv: KVNamespace, hash: string): Promise<{ at: string; urn?: string } | null> {
	return (await kv.get(`dedupe:${hash}`, "json")) as { at: string; urn?: string } | null;
}

export async function setDedupe(kv: KVNamespace, hash: string, urn?: string): Promise<void> {
	await kv.put(`dedupe:${hash}`, JSON.stringify({ at: new Date().toISOString(), urn }), {
		expirationTtl: DEDUPE_TTL_SECONDS,
	});
}
