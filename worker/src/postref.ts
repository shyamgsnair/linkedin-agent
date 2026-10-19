/**
 * Turns whatever the user (or a notification email) gives us into a LinkedIn post URN.
 * Accepts raw URNs, linkedin.com post/feed URLs, and URL-encoded variants. Short links
 * (lnkd.in) must be resolved to a full URL first; see resolveShortLink in linkedin.ts.
 */

export type UrnKind = "share" | "ugcPost" | "activity";

export interface ParsedRef {
	urn: string;
	kind: UrnKind;
	id: string;
}

const URN = /urn:li:(share|ugcPost|activity):(\d+)/i;
const SLUG = /[-/](activity|ugcPost|share)[-:](\d{10,})/i;

function normaliseKind(k: string): UrnKind {
	const lower = k.toLowerCase();
	if (lower === "ugcpost") return "ugcPost";
	return lower as UrnKind;
}

export function parsePostRef(input: string): ParsedRef | null {
	let s = input.trim();
	try {
		s = decodeURIComponent(s);
	} catch {
		// leave as is
	}
	const m = s.match(URN) ?? s.match(SLUG);
	if (!m) return null;
	const kind = normaliseKind(m[1]);
	return { urn: `urn:li:${kind}:${m[2]}`, kind, id: m[2] };
}

export function isShortLink(input: string): boolean {
	try {
		const u = new URL(input.trim());
		return u.hostname === "lnkd.in" || u.hostname.endsWith(".lnkd.in");
	} catch {
		return false;
	}
}

export function postUrl(urn: string): string {
	return `https://www.linkedin.com/feed/update/${urn}/`;
}
