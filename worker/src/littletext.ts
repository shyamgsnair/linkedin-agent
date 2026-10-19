/**
 * LinkedIn's Posts API takes `commentary` in "little text" format, where these characters
 * are reserved: \ | { } @ [ ] ( ) < > # * _ ~
 * Unescaped reserved characters can silently truncate or corrupt a post, so everything is
 * escaped. Hashtags written as #word are converted to LinkedIn's hashtag template so they
 * still render as real hashtags.
 */

const RESERVED = /[\\|{}@\[\]()<>#*_~]/g;

export function escapeLittleText(text: string): string {
	return text.replace(RESERVED, (ch) => `\\${ch}`);
}

const HASHTAG = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu;

export function toLittleText(text: string): string {
	let out = "";
	let last = 0;
	for (const m of text.matchAll(HASHTAG)) {
		const start = m.index! + m[1].length; // position of '#'
		out += escapeLittleText(text.slice(last, start));
		out += `{hashtag|\\#|${escapeLittleText(m[2])}}`;
		last = start + 1 + m[2].length;
	}
	out += escapeLittleText(text.slice(last));
	return out;
}
