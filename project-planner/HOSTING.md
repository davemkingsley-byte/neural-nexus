# Hosting ProjectDesk for your team

ProjectDesk runs on the Mac mini (always-on via the `com.projectdesk.server`
LaunchAgent) and is exposed to the team at **https://planner.treatbiosciences.com**
through the existing Cloudflare Tunnel, gated by **Cloudflare Access**.

```
team member ──HTTPS──▶ Cloudflare Access (login) ──▶ Tunnel ──▶ mini :4180
                        (email OTP / Google SSO)      (cloudflared)   (server.js)
```

Two independent locks guard the plans:
1. **Cloudflare Access** at the edge — only people you list can even reach the app.
2. **The server verifies the Access JWT itself** (`auth.js`) — even if the edge
   policy is ever misconfigured or removed, the origin still rejects any request
   that doesn't carry a valid, unexpired, correctly-signed token for this app.
   Remote requests are **rejected until `auth.json` is filled in** (fail closed).

## One-time setup (≈10 minutes in the Cloudflare dashboard — your part)

Everything below is done by **you** in the Cloudflare Zero Trust dashboard; I
can't create login policies or accept dashboard terms on your behalf. The tunnel
ingress + DNS route are already wired by the deploy (see the end).

### 1. Create the Access application

1. Go to **Cloudflare Zero Trust dashboard → Access → Applications → Add an
   application → Self-hosted**.
2. **Application name**: `ProjectDesk`
3. **Session duration**: pick what suits you (e.g. 24 hours or 1 week).
4. **Application domain**: `planner.treatbiosciences.com` (path empty).
5. Save and continue to policies.

### 2. Add the access policy (who can log in)

1. **Policy name**: `Team`
2. **Action**: Allow
3. **Include** → **Emails** → add each team member's email, **including your own**
   (`davemkingsley@gmail.com`). Or use **Emails ending in** `@treatbiosciences.com`
   if everyone shares the domain.
4. Save. (Login method — one-time PIN by email works with zero extra config;
   for Google SSO add a Google login provider under **Settings → Authentication**.)

### 3. Copy the two values the server needs

1. Open the ProjectDesk application → **Overview** (or **Settings**) and copy the
   **Application Audience (AUD) Tag** — a long hex string.
2. Your **team domain** is `https://<your-team-name>.cloudflareaccess.com` (shown
   under **Settings → Custom Pages**, or it's the team name you chose for Zero Trust).

### 4. Configure the server (on the mini)

```bash
cd ~/.openclaw/workspace/neural-nexus/project-planner
cp auth.example.json auth.json
# edit auth.json:
#   cloudflareAccess.teamDomain = "https://<your-team>.cloudflareaccess.com"
#   cloudflareAccess.aud        = "<the AUD tag from step 3>"
#   editors = ["davemkingsley@gmail.com", ...anyone who should edit]
#   viewers = "any-authenticated"   (everyone the Access policy lets in can view)
launchctl kickstart -k gui/$(id -u)/com.projectdesk.server   # reload with auth
```

`auth.json` and the `*.audit.jsonl` logs are gitignored — they never leave the
mini.

### 5. Verify

- `curl -s localhost:4180/api/me` on the mini → `{"role":"editor","remote":false}`.
- From a phone/another machine, open `https://planner.treatbiosciences.com` →
  Cloudflare login → the planner. A non-editor email sees a **view-only** banner
  and disabled editing; edit attempts are refused by the server, not just hidden.

## Roles

| Who | How | Can |
|-----|-----|-----|
| You / editors | email in `editors[]` | full editing (grid, dialogs, risks, CLI) |
| Team viewers | any other allowed email | see live plans + risk register, read-only |
| The mini itself | local (no tunnel) | editor — this is how the CLI/AI drive plans |

Change roles by editing `auth.json` and kickstarting the service. Every write is
stamped with the editor's email and appended to `projects/<name>.audit.jsonl`.

## Turning remote access off

- **Pause**: remove the `planner` ingress rule from `~/.cloudflared/config.yml`
  and restart cloudflared — the app stays fully usable locally.
- **Lock down hard**: delete `auth.json` → all remote requests 503 immediately.
- **Revoke one person**: remove their email from the Access policy (edge) and/or
  from `auth.json` `editors`.

## What is NOT covered

- The mini must be on for the site to be up (it's the origin).
- This is small-team scale (single-process origin, file-per-project). Fine for a
  team; not a SaaS.
