import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeLittleText, toLittleText } from "../src/littletext.ts";
import { parsePostRef, isShortLink } from "../src/postref.ts";
import { allRedirectUrisAllowed, checkMember, isAllowedRedirectUri, normaliseForDedupe, sha256Hex } from "../src/security.ts";

test("escapes all little-text reserved characters", () => {
	assert.equal(escapeLittleText("a (b) [c] {d} <e> @f #g *h _i ~j |k \\l"), "a \\(b\\) \\[c\\] \\{d\\} \\<e\\> \\@f \\#g \\*h \\_i \\~j \\|k \\\\l");
});

test("converts hashtags to LinkedIn's template and escapes the rest", () => {
	assert.equal(toLittleText("Built it (finally) #AI #FP_A"), "Built it \\(finally\\) {hashtag|\\#|AI} {hashtag|\\#|FP\\_A}");
	assert.equal(toLittleText("#GBS first"), "{hashtag|\\#|GBS} first");
	assert.equal(toLittleText("issue #1 vs a#b"), "issue {hashtag|\\#|1} vs a\\#b");
	assert.equal(toLittleText("plain text"), "plain text");
});

test("parses URNs and post URLs", () => {
	assert.deepEqual(parsePostRef("urn:li:share:7123456789012345678"), { urn: "urn:li:share:7123456789012345678", kind: "share", id: "7123456789012345678" });
	assert.equal(parsePostRef("https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/")?.urn, "urn:li:activity:7123456789012345678");
	assert.equal(parsePostRef("https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7123456789012345678")?.urn, "urn:li:ugcPost:7123456789012345678");
	assert.equal(parsePostRef("https://www.linkedin.com/posts/jane-doe_finance-ai-activity-7123456789012345678-AbCd?utm_source=share")?.urn, "urn:li:activity:7123456789012345678");
	assert.equal(parsePostRef("https://www.linkedin.com/posts/jane_x-ugcPost-7123456789012345678-zz")?.kind, "ugcPost");
	assert.equal(parsePostRef("https://www.linkedin.com/in/jane-doe/"), null);
	assert.equal(parsePostRef("https://lnkd.in/p/eE-EH-GZ"), null);
	assert.equal(isShortLink("https://lnkd.in/p/eE-EH-GZ"), true);
	assert.equal(isShortLink("https://www.linkedin.com/feed/"), false);
});

test("only Claude callbacks are allowed unless localhost is enabled", () => {
	assert.equal(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", false), true);
	assert.equal(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback", false), true);
	assert.equal(isAllowedRedirectUri("https://evil.example/api/mcp/auth_callback", false), false);
	assert.equal(isAllowedRedirectUri("https://claude.ai.evil.example/api/mcp/auth_callback", false), false);
	assert.equal(isAllowedRedirectUri("http://localhost:6274/oauth/callback", false), false);
	assert.equal(isAllowedRedirectUri("http://localhost:6274/oauth/callback", true), true);
	assert.equal(isAllowedRedirectUri("http://localhost.evil.example/cb", true), false);
	assert.equal(allRedirectUrisAllowed(["https://claude.ai/api/mcp/auth_callback"], false), true);
	assert.equal(allRedirectUrisAllowed(["https://claude.ai/api/mcp/auth_callback", "https://x.example/cb"], false), false);
	assert.equal(allRedirectUrisAllowed([], false), false);
	assert.equal(allRedirectUrisAllowed(undefined, false), false);
});

test("member lock fails closed", () => {
	assert.deepEqual(checkMember("abc", undefined), { ok: false, reason: "not_configured" });
	assert.deepEqual(checkMember("abc", "   "), { ok: false, reason: "not_configured" });
	assert.deepEqual(checkMember("abc", "xyz"), { ok: false, reason: "not_allowed" });
	assert.deepEqual(checkMember("", "xyz"), { ok: false, reason: "not_allowed" });
	assert.deepEqual(checkMember("abc", " abc "), { ok: true });
});

test("dedupe fingerprint ignores whitespace and case", async () => {
	const a = await sha256Hex(normaliseForDedupe("Hello   World\n", "post"));
	const b = await sha256Hex(normaliseForDedupe("hello world", "post"));
	const c = await sha256Hex(normaliseForDedupe("hello world", "reshare"));
	assert.equal(a, b);
	assert.notEqual(a, c);
});
