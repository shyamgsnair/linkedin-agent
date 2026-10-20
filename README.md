# linkedin-agent

A personal LinkedIn posting agent for Claude:

- **Draft and publish:** brainstorm a post with Claude, go back and forth, then publish it with an explicit command.
- **Reshare suggestions:** Claude watches LinkedIn post-notification emails from a few people you follow and proposes one post a day to reshare with your commentary. You approve, edit or reject.

Nothing is posted without your explicit approval.

It has two parts:

| Part | What it is | Where |
|---|---|---|
| **Connector** | A remote MCP server on Cloudflare Workers (free plan). It signs you in with LinkedIn and exposes tools to post, reshare, delete and keep history. | [`worker/`](worker/) |
| **Skill** | Instructions that tell Claude how to draft in your voice, when to ask, and when it may publish. | [`skills/linkedin-agent/`](skills/linkedin-agent/SKILL.md) |

Everyone deploys **their own copy** of the connector with **their own LinkedIn app**. The server is locked to a single LinkedIn member ID and refuses everyone else.

## How it works

```
Claude app ──OAuth──▶ your Worker (MCP server) ──OAuth──▶ LinkedIn API
```

1. You add your Worker's `/mcp` URL as a custom connector in Claude.
2. Claude registers with the Worker; the Worker sends you to LinkedIn to sign in.
3. The Worker checks your LinkedIn member ID against `ALLOWED_MEMBER_ID` and refuses anyone else (it fails closed if that is unset).
4. Your LinkedIn token is stored encrypted inside the OAuth grant. Claude never sees it.

Only LinkedIn's self-serve scopes are used: `openid`, `profile` and `w_member_social`.

## Tools

| Tool | Does |
|---|---|
| `whoami` | Who you're posting as; days until the LinkedIn sign-in expires (about 60 days) |
| `create_post` | Publish a text post, optionally with a link card |
| `reshare_post` | Reshare a post (URL, `lnkd.in` link or URN) with your commentary |
| `resolve_post_reference` | Read-only: show the URN a link resolves to |
| `delete_post` | Delete one of your posts |
| `get_config` / `update_config` | Voice guide, watchlist, default visibility |
| `get_history` / `log_decision` | Past posts, reshares, suggestions and rejections |

Safety built in: identical content is refused for 24 hours; writes are never retried automatically (an ambiguous failure is reported as "status unknown, check LinkedIn first"); an expired token returns a clear "reconnect" message.

## Setup

You need a Cloudflare account, Node 20+, and a LinkedIn developer app (linked to a LinkedIn Page you admin) with the **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** products. In the app's Auth tab, add these redirect URLs:

- `http://localhost:8788/callback`
- `https://li-agent.<your-workers-subdomain>.workers.dev/callback`

### 1. Install and log in

```bash
git clone https://github.com/<you>/linkedin-agent.git
cd linkedin-agent/worker
npm install
npx wrangler login
```

### 2. Create the two KV namespaces

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create DATA_KV
```

Paste each printed `id` into `worker/wrangler.jsonc`, replacing the existing `OAUTH_KV` and `DATA_KV` ids (those belong to the author's account). Answer **n** when Wrangler offers to add them for you. These IDs are not secret.

### 3. Run locally

```bash
cp .dev.vars.example .dev.vars        # then fill in your LinkedIn client ID and secret
openssl rand -hex 32                  # paste the output as COOKIE_ENCRYPTION_KEY
npx wrangler dev
```

Test with the MCP Inspector: set `ALLOW_LOCALHOST_CLIENTS=true` in `.dev.vars`, run `npx @modelcontextprotocol/inspector`, and connect to `http://localhost:8788/mcp`.

The **first** sign-in is refused on purpose and shows your LinkedIn member ID. Put it in `.dev.vars` as `ALLOWED_MEMBER_ID`, restart `wrangler dev`, and sign in again.

> Use Chrome for local testing. The sign-in uses secure cookies, which some browsers don't allow on `http://localhost`.

### 4. Deploy

```bash
npx wrangler secret put LINKEDIN_CLIENT_ID
npx wrangler secret put LINKEDIN_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put ALLOWED_MEMBER_ID
npx wrangler deploy
```

### 5. Connect Claude

In Claude, add a custom connector with the URL `https://li-agent.<your-workers-subdomain>.workers.dev/mcp`, then click **Connect** and sign in with LinkedIn.

### 6. Install the skill

**Claude Code:**

```
/plugin install linkedin-agent --marketplace shyamgsnair/linkedin-agent
```

**Claude app:** upload [`skills/linkedin-agent/SKILL.md`](skills/linkedin-agent/SKILL.md) as a skill in your Claude settings (or zip the `skills/linkedin-agent` folder).

### 7. Set your voice and watchlist

Copy [`config.example/`](config.example/) into a **private** repo and fill in `voice-guide.md` and `config.json`. Then ask Claude: *"Load my voice guide and watchlist into the LinkedIn connector"*, or use `/li voice edit` and `/li watch add`.

For the daily reshare suggestion, connect **Gmail** in Claude, turn on the 🔔 bell (All posts) for each watched person on LinkedIn, and keep LinkedIn's email notifications on.

## Using it

| Say | Claude does |
|---|---|
| `/li draft <idea>` | Works the post up with you in your voice. Asks for the concrete detail if the idea is too abstract. |
| `/li publish` | Shows the exact text and visibility, asks "Post this now?", publishes once on a clear yes. |
| `/li suggest` | Reads LinkedIn notification emails, picks one post from people you watch, drafts commentary. Approve, edit, reject or skip. |
| `/li watch add <name>` | Adds someone to the watchlist. |
| `/li history` | Recent posts, reshares and decisions. |

## Development

```bash
cd worker
npm run type-check
npm test
```

Secret scanning: CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push. To scan locally before each commit, run `pre-commit install` once.

## License

MIT
