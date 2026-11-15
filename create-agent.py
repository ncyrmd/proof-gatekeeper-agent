#!/usr/bin/env python3
"""Create the Proof Gatekeeper agent for account #1 via addAgentAction.

Posts to /dashboard/agents with Next-Action: <addAgentAction id> and a JSON
array body [ {name, events, repoUrl, endpoint} ] (same wire format as
register.py's call_register_action).

SECURITY: the returned HMAC secret is written ONLY to .env.production
(mode 600, gitignored) and to agent-state.json WITHOUT the secret.
It is NEVER printed to stdout or any log. Only the agentId, name, and
ok/error are printed.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "workspace/agent-games"))
import register as R

BASE = R.BASE
ADD_AGENT_ACTION_ID = "406c653ffdf23ce1306a90d56bab9777bd095b4999"
WORKDIR = Path.home() / "workspace/agent-games/gatekeeper"
ENV_FILE = WORKDIR / ".env.production"
STATE_FILE = WORKDIR / "agent-state.json"

AGENT_NAME = "NCYGK-1"
EVENTS = ["Proof Gatekeeper"]
REPO_URL = "https://github.com/ncyrmd/proof-gatekeeper-agent"
ENDPOINT = ""  # optional at creation; set later via updateAgentEndpoint


def call_add_agent(session, args):
    body = json.dumps([args])
    headers = {
        "Next-Action": ADD_AGENT_ACTION_ID,
        "Accept": "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
    }
    r = R.req(session, "POST", f"{BASE}/dashboard/agents", data=body, headers=headers)
    return r.status_code, r.text


def main():
    wallets = R.load_wallets()
    w1 = next(w for w in wallets if w["line"] == 40)
    print(f"account #1: {w1['email']} {w1['address']}")
    s = R.requests.Session()
    s.headers.update({"User-Agent": R.UA})
    ok = R.sign_in(s, w1, "7V7PW2RJ")
    print(f"sign_in account #1: {ok}")
    if not ok:
        print("BLOCKER: could not sign in as account #1")
        return
    args = {"name": AGENT_NAME, "events": EVENTS, "repoUrl": REPO_URL, "endpoint": ENDPOINT}
    print(f"calling addAgentAction: name={AGENT_NAME} events={EVENTS} repoUrl={REPO_URL} endpoint=(empty)")
    status, text = call_add_agent(s, args)
    print(f"addAgentAction -> HTTP {status} len={len(text)}")
    # The Flight response embeds the return value as JSON-ish text.
    # Look for ok / error / agentId / secret WITHOUT printing the secret.
    print("response head (first 800 chars, secret redacted):")
    head = text[:800]
    import re
    head = re.sub(r'"secret"\s*:\s*"[^"]*"', '"secret":"<REDACTED>"', head)
    head = re.sub(r'secret[^,}\"]{0,80}', 'secret<REDACTED>', head)
    print(head)
    # Extract fields
    m_ok = re.search(r'"ok"\s*:\s*(true|false)', text)
    m_err = re.search(r'"error"\s*:\s*"([^"]*)"', text)
    m_id = re.search(r'"agentId"\s*:\s*"([^"]+)"', text)
    m_secret = re.search(r'"secret"\s*:\s*"([^"]+)"', text)
    m_name = re.search(r'"name"\s*:\s*"([^"]+)"', text)
    print(f"parsed: ok={m_ok.group(1) if m_ok else None} error={m_err.group(1) if m_err else None} agentId={m_id.group(1) if m_id else None} name={m_name.group(1) if m_name else None} secret_present={bool(m_secret)}")
    if m_ok and m_ok.group(1) == "true" and m_id and m_secret:
        agent_id = m_id.group(1)
        secret = m_secret.group(1)
        # Write the secret ONLY to .env.production (mode 600)
        ENV_FILE.write_text(f"AGENT_GAMES_HMAC_SECRET={secret}\n")
        ENV_FILE.chmod(0o600)
        state = {
            "agentId": agent_id,
            "name": m_name.group(1) if m_name else AGENT_NAME,
            "events": EVENTS,
            "repoUrl": REPO_URL,
            "endpointUrl": ENDPOINT,
            "secretStoredIn": str(ENV_FILE),
            "preflight": "not-run",
        }
        STATE_FILE.write_text(json.dumps(state, indent=1))
        print(f"AGENT CREATED: agentId={agent_id} name={state['name']}")
        print(f"secret saved to {ENV_FILE} (mode 600, gitignored) — NOT printed here")
    else:
        print("AGENT NOT CREATED — see error above (repo URL may need to exist first, or name/events invalid)")


if __name__ == "__main__":
    main()
