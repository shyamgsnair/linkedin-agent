/**
 * Thin client for the parts of LinkedIn's official API this server uses.
 * Only self-serve scopes: openid, profile (sign-in) and w_member_social (posting).
 */
import { toLittleText } from "./littletext";
import { isShortLink, parsePostRef, type ParsedRef } from "./postref";

export const LI_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LI_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LI_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
export const LI_POSTS_URL = "https://api.linkedin.com/rest/posts";
export const LI_SCOPES = "openid profile w_member_social";

/** Context stored (encrypted) in the OAuth grant and exposed to the MCP agent as this.props. */
export type Props = {
	memberId: string; // LinkedIn OIDC `sub`
	name: string;
	accessToken: string; // LinkedIn access token
	expiresAt: number; // epoch ms
};

export type Visibility = "PUBLIC" | "CONNECTIONS";

export class LinkedInError extends Error {
	constructor(
		message: string,
		public kind: "auth" | "forbidden" | "invalid" | "rate_limited" | "unknown",
		public status?: number,
	) {
		super(message);
	}
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
	const u = new URL(LI_AUTHORIZE_URL);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("client_id", clientId);
	u.searchParams.set("redirect_uri", redirectUri);
	u.searchParams.set("scope", LI_SCOPES);
	u.searchParams.set("state", state);
	return u.href;
}

export async function exchangeCode(opts: {
	code: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}): Promise<{ accessToken: string; expiresAt: number }> {
	const resp = await fetch(LI_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: opts.code,
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
			redirect_uri: opts.redirectUri,
		}).toString(),
	});
	if (!resp.ok) {
		console.error("LinkedIn token exchange failed", resp.status, await resp.text());
		throw new LinkedInError("LinkedIn token exchange failed", "auth", resp.status);
	}
	const body = (await resp.json()) as { access_token?: string; expires_in?: number };
	if (!body.access_token) throw new LinkedInError("LinkedIn returned no access token", "auth");
	const ttlSeconds = body.expires_in ?? 60 * 24 * 3600;
	return { accessToken: body.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
}

export async function fetchUserInfo(accessToken: string): Promise<{ sub: string; name: string }> {
	const resp = await fetch(LI_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!resp.ok) throw new LinkedInError(`userinfo failed (${resp.status})`, "auth", resp.status);
	const body = (await resp.json()) as { sub: string; name?: string; given_name?: string };
	return { sub: body.sub, name: body.name ?? body.given_name ?? "" };
}

function restHeaders(accessToken: string, version: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"LinkedIn-Version": version,
		"X-Restli-Protocol-Version": "2.0.0",
		"Content-Type": "application/json",
	};
}

async function classify(resp: Response): Promise<LinkedInError> {
	const text = await resp.text().catch(() => "");
	let detail = text.slice(0, 500);
	try {
		const j = JSON.parse(text) as { message?: string };
		if (j.message) detail = j.message;
	} catch {
		// not JSON
	}
	if (resp.status === 401)
		return new LinkedInError(
			"LinkedIn rejected the token (expired or revoked). Reconnect the LinkedIn connector in Claude's settings.",
			"auth",
			401,
		);
	if (resp.status === 403)
		return new LinkedInError(`LinkedIn refused the request (403): ${detail}`, "forbidden", 403);
	if (resp.status === 429)
		return new LinkedInError("LinkedIn rate limit hit. Try again later.", "rate_limited", 429);
	if (resp.status >= 400 && resp.status < 500)
		return new LinkedInError(`LinkedIn rejected the post (${resp.status}): ${detail}`, "invalid", resp.status);
	return new LinkedInError(`LinkedIn returned ${resp.status}: ${detail}`, "unknown", resp.status);
}

export interface CreatePostInput {
	accessToken: string;
	version: string;
	memberId: string;
	text: string;
	visibility: Visibility;
	article?: { url: string; title: string };
	reshareParent?: string;
}

/**
 * Creates a post or reshare. Never retries: a timeout or 5xx is reported as kind "unknown"
 * so the caller can tell the user to check LinkedIn before trying again.
 */
export async function createPost(input: CreatePostInput): Promise<{ urn: string }> {
	const body: Record<string, unknown> = {
		author: `urn:li:person:${input.memberId}`,
		commentary: toLittleText(input.text),
		visibility: input.visibility,
		distribution: {
			feedDistribution: "MAIN_FEED",
			targetEntities: [],
			thirdPartyDistributionChannels: [],
		},
		lifecycleState: "PUBLISHED",
		isReshareDisabledByAuthor: false,
	};
	if (input.article) {
		body.content = { article: { source: input.article.url, title: input.article.title } };
	}
	if (input.reshareParent) {
		body.reshareContext = { parent: input.reshareParent };
	}

	let resp: Response;
	try {
		resp = await fetch(LI_POSTS_URL, {
			method: "POST",
			headers: restHeaders(input.accessToken, input.version),
			body: JSON.stringify(body),
		});
	} catch (e) {
		throw new LinkedInError(`Network error talking to LinkedIn: ${(e as Error).message}`, "unknown");
	}
	if (resp.status !== 201 && !resp.ok) throw await classify(resp);
	const urn = resp.headers.get("x-restli-id") ?? resp.headers.get("x-linkedin-id") ?? "";
	if (!urn) throw new LinkedInError("LinkedIn accepted the post but returned no ID.", "unknown", resp.status);
	return { urn };
}

export async function deletePost(accessToken: string, version: string, urn: string): Promise<void> {
	const resp = await fetch(`${LI_POSTS_URL}/${encodeURIComponent(urn)}`, {
		method: "DELETE",
		headers: restHeaders(accessToken, version),
	});
	if (resp.status !== 204 && !resp.ok) throw await classify(resp);
}

/**
 * Follows lnkd.in redirects (without fetching the final LinkedIn page) until a URL
 * containing a post reference appears.
 */
export async function resolveShortLink(url: string, maxHops = 4): Promise<string> {
	let current = url.trim();
	for (let i = 0; i < maxHops; i++) {
		if (parsePostRef(current)) return current;
		const resp = await fetch(current, { method: "GET", redirect: "manual" });
		const next = resp.headers.get("location");
		if (!next) break;
		current = new URL(next, current).href;
	}
	return current;
}

export async function resolvePostRef(input: string): Promise<{ ref: ParsedRef | null; resolvedUrl?: string }> {
	const direct = parsePostRef(input);
	if (direct) return { ref: direct };
	if (isShortLink(input)) {
		const resolvedUrl = await resolveShortLink(input);
		return { ref: parsePostRef(resolvedUrl), resolvedUrl };
	}
	return { ref: null };
}
