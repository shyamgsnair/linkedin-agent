/**
 * Entry point. workers-oauth-provider makes this Worker an OAuth server for Claude and
 * protects /mcp; LinkedInHandler handles the LinkedIn sign-in; LinkedInMCP holds the tools.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { env as workerEnv } from "cloudflare:workers";
import { LinkedInHandler } from "./linkedin-handler";
import { LinkedInMCP } from "./mcp";
import { allRedirectUrisAllowed } from "./security";

export { LinkedInMCP };

const provider = new OAuthProvider({
	apiHandler: LinkedInMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	tokenEndpoint: "/token",
	defaultHandler: LinkedInHandler as any,
	allowPlainPKCE: false,
	// Only Claude's own callback URLs (plus localhost, if explicitly enabled) may register.
	clientRegistrationCallback: ({ clientMetadata }) => {
		const allowLocalhost = String((workerEnv as Env).ALLOW_LOCALHOST_CLIENTS) === "true";
		if (!allRedirectUrisAllowed(clientMetadata.redirect_uris, allowLocalhost)) {
			console.warn("Refused client registration", { redirect_uris: clientMetadata.redirect_uris });
			return { code: "invalid_redirect_uri", description: "This server only accepts Claude.", status: 403 };
		}
	},
});

const RATE_LIMITED_PATHS = new Set(["/authorize", "/callback", "/register", "/token"]);

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (RATE_LIMITED_PATHS.has(pathname) && env.AUTH_RATE_LIMITER) {
			const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
			const { success } = await env.AUTH_RATE_LIMITER.limit({ key: `${pathname}:${ip}` });
			if (!success) {
				console.warn("Rate limited", { pathname, ip });
				return new Response("Too many requests", { status: 429, headers: { "Retry-After": "60" } });
			}
		}

		return provider.fetch(request, env, ctx);
	},
};
