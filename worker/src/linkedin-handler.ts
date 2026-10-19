/**
 * Sign-in flow. Claude (the MCP client) is sent here by workers-oauth-provider; we show a
 * consent screen, send the user to LinkedIn, and on the way back:
 *   1. exchange LinkedIn's code for a LinkedIn access token,
 *   2. look up the member ID (OIDC `sub`),
 *   3. refuse anyone who is not ALLOWED_MEMBER_ID (fail closed if it is unset),
 *   4. hand Claude a token whose encrypted props carry the LinkedIn token.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { authorizeUrl, exchangeCode, fetchUserInfo, type Props } from "./linkedin";
import { checkMember, isAllowedRedirectUri } from "./security";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	sanitizeText,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

function page(title: string, body: string, status: number): Response {
	return new Response(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
			`<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;line-height:1.5;color:#222}code{background:#f2f2f2;padding:2px 6px;border-radius:4px;word-break:break-all}</style></head>` +
			`<body><h1>${title}</h1>${body}</body></html>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
}

function allowLocalhost(env: Env): boolean {
	return String(env.ALLOW_LOCALHOST_CLIENTS) === "true";
}

function redirectToLinkedIn(env: Env, request: Request, stateToken: string, headers: HeadersInit = {}) {
	const h = new Headers(headers);
	h.set("location", authorizeUrl(env.LINKEDIN_CLIENT_ID, new URL("/callback", request.url).href, stateToken));
	return new Response(null, { status: 302, headers: h });
}

app.get("/", () => page("Private server", "<p>This is a private MCP server.</p>", 200));

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId, redirectUri } = oauthReqInfo;
	if (!clientId) return c.text("Invalid request", 400);

	// Only Claude's own callback (and localhost, if explicitly enabled) may start a sign-in.
	if (!isAllowedRedirectUri(redirectUri, allowLocalhost(c.env))) {
		console.warn("Refused authorize: redirect URI not allowed", { redirectUri, clientId });
		return page("Not allowed", "<p>This server only accepts connections from Claude.</p>", 403);
	}

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToLinkedIn(c.env, c.req.raw, stateToken, { "Set-Cookie": setCookie });
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			name: "LinkedIn Post Agent",
			description:
				"Lets Claude publish and reshare LinkedIn posts as you, only after you approve each one. You'll sign in with LinkedIn next.",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") return c.text("Missing state", 400);

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}
		const info = state.oauthReqInfo;
		if (!info?.clientId) return c.text("Invalid request", 400);
		if (!isAllowedRedirectUri(info.redirectUri, allowLocalhost(c.env))) {
			console.warn("Refused authorize (POST): redirect URI not allowed", { redirectUri: info.redirectUri });
			return page("Not allowed", "<p>This server only accepts connections from Claude.</p>", 403);
		}

		const approvedClientCookie = await addApprovedClient(c.req.raw, info.clientId, c.env.COOKIE_ENCRYPTION_KEY);
		const { stateToken } = await createOAuthState(info, c.env.OAUTH_KV);
		const { setCookie: sessionCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionCookie);
		return redirectToLinkedIn(c.env, c.req.raw, stateToken, headers);
	} catch (error: any) {
		if (error instanceof OAuthError) return error.toResponse();
		console.error("POST /authorize error", error);
		return c.text("Internal server error", 500);
	}
});

app.get("/callback", async (c) => {
	if (c.req.query("error")) {
		return page(
			"LinkedIn sign-in cancelled",
			`<p>${sanitizeText(c.req.query("error_description") ?? c.req.query("error") ?? "")}</p>`,
			400,
		);
	}

	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;
	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}
	if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

	const code = c.req.query("code");
	if (!code) return c.text("Missing code", 400);

	let accessToken: string;
	let expiresAt: number;
	let user: { sub: string; name: string };
	try {
		({ accessToken, expiresAt } = await exchangeCode({
			code,
			clientId: c.env.LINKEDIN_CLIENT_ID,
			clientSecret: c.env.LINKEDIN_CLIENT_SECRET,
			redirectUri: new URL("/callback", c.req.url).href,
		}));
		user = await fetchUserInfo(accessToken);
	} catch (e) {
		console.error("LinkedIn sign-in failed", e);
		return page("LinkedIn sign-in failed", "<p>LinkedIn did not complete the sign-in. Please try again.</p>", 502);
	}

	// The lock: only the configured member gets a token. Fail closed.
	const check = checkMember(user.sub, c.env.ALLOWED_MEMBER_ID);
	if (!check.ok) {
		console.warn("Refused sign-in", { reason: check.reason, memberId: user.sub });
		if (check.reason === "not_configured") {
			// First-run helper: the person signing in sees only their own ID.
			return page(
				"Almost there",
				`<p>This server has no allowed member configured yet, so the sign-in was refused.</p>` +
					`<p>Your LinkedIn member ID is:</p><p><code>${sanitizeText(user.sub)}</code></p>` +
					`<p>If this is your server, run <code>npx wrangler secret put ALLOWED_MEMBER_ID</code> and paste that ID ` +
					`(or add it to <code>.dev.vars</code> when running locally), then connect again.</p>`,
				403,
			);
		}
		return page("Not allowed", "<p>This server is private.</p>", 403);
	}

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: user.name },
		props: { memberId: user.sub, name: user.name, accessToken, expiresAt } satisfies Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: user.sub,
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
	return new Response(null, { status: 302, headers });
});

export { app as LinkedInHandler };
