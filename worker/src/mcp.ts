/**
 * The MCP tools Claude sees. Write tools (create_post, reshare_post, delete_post) must only be
 * called after the user has explicitly approved the exact text and visibility in chat; the
 * skill enforces that, and the tool descriptions repeat it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
	createPost,
	deletePost,
	LinkedInError,
	resolvePostRef,
	type Props,
	type Visibility,
} from "./linkedin";
import { postUrl } from "./postref";
import { normaliseForDedupe, sha256Hex } from "./security";
import {
	appendHistory,
	getConfig,
	getDedupe,
	getHistory,
	setDedupe,
	updateConfig,
	type HistoryKind,
} from "./store";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
	content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const visibilitySchema = z
	.enum(["PUBLIC", "CONNECTIONS"])
	.optional()
	.describe("PUBLIC (anyone) or CONNECTIONS (your connections only). Defaults to the configured default_visibility.");

const APPROVAL_NOTE =
	"Only call this after the user has explicitly approved the exact final text and visibility in this conversation. Never call it to 'test' or retry on your own.";

export class LinkedInMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "LinkedIn Post Agent", version: "0.1.0" });

	private get props_(): Props {
		if (!this.props) throw new LinkedInError("Not signed in.", "auth");
		return this.props;
	}

	/** Returns an error result if the LinkedIn token has expired, so we don't even try. */
	private tokenProblem(): ToolResult | null {
		const p = this.props_;
		if (Date.now() >= p.expiresAt) {
			return fail(
				"Your LinkedIn sign-in has expired (LinkedIn tokens last about 60 days). Reconnect the LinkedIn connector in Claude's settings, then try again.",
			);
		}
		return null;
	}

	private async visibilityOrDefault(v?: Visibility): Promise<Visibility> {
		if (v) return v;
		const cfg = await getConfig(this.env.DATA_KV);
		return cfg.default_visibility ?? "CONNECTIONS";
	}

	private async publish(opts: {
		kind: "post" | "reshare";
		text: string;
		visibility: Visibility;
		article?: { url: string; title: string };
		parent?: string;
		override: boolean;
	}): Promise<ToolResult> {
		const expired = this.tokenProblem();
		if (expired) return expired;
		const p = this.props_;
		const kv = this.env.DATA_KV;

		const hash = await sha256Hex(
			normaliseForDedupe(opts.text, `${opts.kind}|${opts.parent ?? ""}|${opts.article?.url ?? ""}`),
		);
		const seen = await getDedupe(kv, hash);
		if (seen && !opts.override) {
			return fail(
				`Refused: identical content was already sent at ${seen.at}${seen.urn ? ` (${postUrl(seen.urn)})` : " and its result is unknown"}. ` +
					"Check LinkedIn first. If it truly did not post, ask the user to confirm and call again with override_duplicate_check=true.",
			);
		}

		try {
			const { urn } = await createPost({
				accessToken: p.accessToken,
				version: this.env.LINKEDIN_API_VERSION,
				memberId: p.memberId,
				text: opts.text,
				visibility: opts.visibility,
				article: opts.article,
				reshareParent: opts.parent,
			});
			await setDedupe(kv, hash, urn);
			await appendHistory(kv, {
				kind: opts.kind,
				urn,
				parent: opts.parent,
				post_url: postUrl(urn),
				visibility: opts.visibility,
				text_preview: opts.text.slice(0, 200),
			});
			return ok({ status: "published", urn, url: postUrl(urn), visibility: opts.visibility });
		} catch (e) {
			const err = e instanceof LinkedInError ? e : new LinkedInError(String(e), "unknown");
			if (err.kind === "unknown") {
				// Might have gone through. Block an automatic second attempt.
				await setDedupe(kv, hash);
				await appendHistory(kv, {
					kind: "unknown",
					parent: opts.parent,
					visibility: opts.visibility,
					text_preview: opts.text.slice(0, 200),
					reason: err.message,
				});
				return fail(
					`Status unknown: ${err.message}. The post may or may not have been published. Do NOT retry automatically. ` +
						"Ask the user to check their LinkedIn activity first.",
				);
			}
			return fail(err.message);
		}
	}

	async init() {
		const kv = () => this.env.DATA_KV;

		this.server.registerTool(
			"whoami",
			{
				title: "Who am I",
				description: "Shows which LinkedIn member this connector posts as, and how many days until the sign-in expires.",
				annotations: { readOnlyHint: true },
			},
			async () => {
				const p = this.props_;
				const days = Math.floor((p.expiresAt - Date.now()) / 86_400_000);
				return ok({
					name: p.name,
					member_id: p.memberId,
					linkedin_token_expires_at: new Date(p.expiresAt).toISOString(),
					days_until_reconnect_needed: days,
				});
			},
		);

		this.server.registerTool(
			"create_post",
			{
				title: "Publish a LinkedIn post",
				description: `Publishes a new text post on the user's LinkedIn profile, optionally with a link card. ${APPROVAL_NOTE} Write hashtags as #word; they are converted automatically. Identical content within 24 hours is refused.`,
				inputSchema: {
					text: z.string().min(1).max(3000).describe("Exact post text the user approved."),
					visibility: visibilitySchema,
					link_url: z.string().url().optional().describe("Optional URL to attach as a link card."),
					link_title: z.string().max(200).optional().describe("Title for the link card. Required if link_url is set."),
					override_duplicate_check: z
						.boolean()
						.optional()
						.describe("Only true when the user confirmed an earlier identical attempt did NOT post."),
				},
				annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
			},
			async ({ text, visibility, link_url, link_title, override_duplicate_check }) => {
				if (link_url && !link_title) return fail("link_title is required when link_url is set.");
				return this.publish({
					kind: "post",
					text,
					visibility: await this.visibilityOrDefault(visibility),
					article: link_url ? { url: link_url, title: link_title! } : undefined,
					override: override_duplicate_check ?? false,
				});
			},
		);

		this.server.registerTool(
			"reshare_post",
			{
				title: "Reshare a LinkedIn post with commentary",
				description: `Reshares someone else's post on the user's profile with the user's commentary on top. ${APPROVAL_NOTE} 'post' can be a post URL, an lnkd.in short link, or a URN (urn:li:share:…, urn:li:ugcPost:…, urn:li:activity:…).`,
				inputSchema: {
					post: z.string().min(5).describe("URL, short link or URN of the post to reshare."),
					commentary: z.string().min(1).max(3000).describe("Exact commentary the user approved."),
					visibility: visibilitySchema,
					override_duplicate_check: z.boolean().optional(),
				},
				annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
			},
			async ({ post, commentary, visibility, override_duplicate_check }) => {
				const { ref, resolvedUrl } = await resolvePostRef(post);
				if (!ref) {
					return fail(
						`Couldn't find a post ID in that reference${resolvedUrl ? ` (it led to ${resolvedUrl})` : ""}. ` +
							"Ask the user for the post URL from the post's ⋯ menu → 'Copy link to post', or the URN from '⋯ → Embed this post'.",
					);
				}
				const result = await this.publish({
					kind: "reshare",
					text: commentary,
					visibility: await this.visibilityOrDefault(visibility),
					parent: ref.urn,
					override: override_duplicate_check ?? false,
				});
				if (result.isError && ref.kind === "activity") {
					result.content.push({
						type: "text",
						text: `Note: this used an activity ID (${ref.urn}). If LinkedIn rejected it, try the share/ugcPost URN from the post's '⋯ → Embed this post' code instead.`,
					});
				}
				return result;
			},
		);

		this.server.registerTool(
			"resolve_post_reference",
			{
				title: "Resolve a post link",
				description: "Read-only. Turns a post URL, short link or URN into the URN LinkedIn uses, without posting anything.",
				inputSchema: { post: z.string().min(5) },
				annotations: { readOnlyHint: true, openWorldHint: true },
			},
			async ({ post }) => {
				const { ref, resolvedUrl } = await resolvePostRef(post);
				return ok({ input: post, resolved_url: resolvedUrl ?? null, urn: ref?.urn ?? null, kind: ref?.kind ?? null });
			},
		);

		this.server.registerTool(
			"delete_post",
			{
				title: "Delete one of your LinkedIn posts",
				description: "Permanently deletes a post or reshare the user made. Only call after the user explicitly asks to delete that specific post.",
				inputSchema: { urn: z.string().regex(/^urn:li:(share|ugcPost):\d+$/).describe("URN returned when the post was created.") },
				annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
			},
			async ({ urn }) => {
				const expired = this.tokenProblem();
				if (expired) return expired;
				try {
					await deletePost(this.props_.accessToken, this.env.LINKEDIN_API_VERSION, urn);
					await appendHistory(kv(), { kind: "deleted", urn });
					return ok({ status: "deleted", urn });
				} catch (e) {
					return fail(e instanceof Error ? e.message : String(e));
				}
			},
		);

		this.server.registerTool(
			"get_config",
			{
				title: "Get agent settings",
				description: "Returns the voice guide, watchlist and default visibility. Read this before drafting.",
				annotations: { readOnlyHint: true },
			},
			async () => ok(await getConfig(kv())),
		);

		this.server.registerTool(
			"update_config",
			{
				title: "Update agent settings",
				description: "Updates parts of the settings. Only fields you pass are changed. Use for '/li watch add', voice-guide edits, or changing the default visibility.",
				inputSchema: {
					voice_guide: z.string().max(20_000).optional(),
					watchlist: z
						.array(
							z.object({
								name: z.string(),
								profile_url: z.string().url().optional(),
								notes: z.string().optional(),
							}),
						)
						.max(25)
						.optional()
						.describe("The full watchlist (replaces the existing list)."),
					default_visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
				},
				annotations: { destructiveHint: false, idempotentHint: true },
			},
			async (patch) => ok(await updateConfig(kv(), patch)),
		);

		this.server.registerTool(
			"get_history",
			{
				title: "Get post history",
				description: "Lists past posts, reshares, suggestions and rejections (newest first). Use it to avoid suggesting a post twice.",
				inputSchema: {
					limit: z.number().int().min(1).max(200).optional(),
					kind: z.enum(["post", "reshare", "deleted", "suggested", "rejected", "skipped", "unknown"]).optional(),
					post: z.string().optional().describe("Filter to entries about this post (URL, short link or URN)."),
				},
				annotations: { readOnlyHint: true },
			},
			async ({ limit, kind, post }) => {
				let entries = await getHistory(kv());
				if (kind) entries = entries.filter((e) => e.kind === kind);
				if (post) {
					const { ref } = await resolvePostRef(post);
					const id = ref?.id;
					entries = id ? entries.filter((e) => e.urn?.endsWith(`:${id}`) || e.parent?.endsWith(`:${id}`)) : [];
				}
				return ok(entries.slice(0, limit ?? 25));
			},
		);

		this.server.registerTool(
			"log_decision",
			{
				title: "Record a suggestion decision",
				description: "Records that a post was suggested to the user, or that they rejected or skipped it, so it is not suggested again.",
				inputSchema: {
					kind: z.enum(["suggested", "rejected", "skipped"]),
					post: z.string().min(5).describe("URL, short link or URN of the post being considered."),
					reason: z.string().max(500).optional(),
				},
				annotations: { destructiveHint: false },
			},
			async ({ kind, post, reason }) => {
				const { ref } = await resolvePostRef(post);
				const entry = await appendHistory(kv(), {
					kind: kind as HistoryKind,
					parent: ref?.urn ?? post,
					post_url: ref ? postUrl(ref.urn) : post,
					reason,
				});
				return ok(entry);
			},
		);
	}
}
