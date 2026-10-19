/**
 * Access rules that keep this server private to one LinkedIn member and to Claude.
 * Pure functions only, so they can be unit-tested outside the Workers runtime.
 */

export const CLAUDE_REDIRECT_URIS = [
	"https://claude.ai/api/mcp/auth_callback",
	"https://claude.com/api/mcp/auth_callback",
];

export function isAllowedRedirectUri(uri: string, allowLocalhost: boolean): boolean {
	if (CLAUDE_REDIRECT_URIS.includes(uri)) return true;
	if (!allowLocalhost) return false;
	try {
		const u = new URL(uri);
		return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
	} catch {
		return false;
	}
}

export function allRedirectUrisAllowed(uris: unknown, allowLocalhost: boolean): boolean {
	if (!Array.isArray(uris) || uris.length === 0) return false;
	return uris.every((u) => typeof u === "string" && isAllowedRedirectUri(u, allowLocalhost));
}

export type MemberCheck =
	| { ok: true }
	| { ok: false; reason: "not_configured" | "not_allowed" };

/** Fail closed: if ALLOWED_MEMBER_ID is unset or blank, nobody gets in. */
export function checkMember(memberId: string, allowedMemberId: string | undefined): MemberCheck {
	const allowed = (allowedMemberId ?? "").trim();
	if (!allowed) return { ok: false, reason: "not_configured" };
	if (!memberId || memberId !== allowed) return { ok: false, reason: "not_allowed" };
	return { ok: true };
}

export async function sha256Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalise post content before hashing so trivial whitespace changes still count as duplicates. */
export function normaliseForDedupe(text: string, extra = ""): string {
	return `${text.replace(/\s+/g, " ").trim().toLowerCase()}|${extra.trim().toLowerCase()}`;
}
