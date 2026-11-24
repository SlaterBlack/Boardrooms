# Boardrooms

Boardrooms is an AI meeting hub. Configure advisors with different roles,
providers, models, and instructions; bring one or more into a boardroom; and
work through a structured discussion or an ongoing chat.

## Requirements

- Node.js 20.19+ or 22.12+
- npm
- An API key for at least one supported provider

## Configure provider keys

Copy `.env.example` to `.env` and add the provider keys you want to use:

```sh
test -f .env || cp .env.example .env
chmod 600 .env
```

Set any of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY` in
`.env`, and set `BOARDROOMS_PASSWORD` to a unique password of at least 16
characters for network sign-in. Provider keys stay on the server and are never
sent to the browser. Do not commit `.env`. If `.env` already exists, edit it
rather than replacing it.

## Run locally

```sh
npm install
npm run dev
```

The React app runs at <http://localhost:5173>. The Express API runs at
<http://localhost:3001>; Vite proxies `/api` requests to it. Provider requests
are made server-side.

## How a boardroom works

- Use the **Meetings** tab to create a structured meeting or ongoing chat, then
  choose one to five named agents from the roster.
- Use the **Agents** tab to add, edit, or delete agent profiles. Configure each
  agent's provider, model ID, perspective, knowledge, skills, and instructions.
- OpenRouter agents use the OpenAI-compatible API. Enter the provider-prefixed
  model slug from your OpenRouter model catalog (for example,
  `openai/gpt-4o-mini`).
- Choose one to three discussion rounds and a facilitator.
- Each advisor speaks in turn and can respond to the earlier discussion. The
  facilitator makes a final synthesis.
- A run makes one provider request per advisor per round, plus one synthesis
  request. Provider usage may incur charges.
- In an ongoing chat, send a message and each advisor responds before the
  facilitator synthesizes the board's recommendation. Follow-up messages use
  the preceding conversation for context. Each message makes one request per
  advisor plus one synthesis request, so provider usage may incur charges.
- Choose **Generate report** beneath a chat conclusion to create a scope
  document, review document, or custom report. Each advisor drafts relevant
  sections from their expertise and the facilitator assembles the final
  document. Report generation makes one request per advisor plus one facilitator
  request; downloading the saved PDF does not make another provider request.

Agent profiles, meeting details, discussion transcripts, and chat messages are
stored by the server in `.boardrooms-data/state.json`, so they are shared across
signed-in browsers and devices. Generated reports are saved with their
boardroom. This private data directory is excluded from Git. On first
connection, existing browser data is imported into the server store. Editing an
agent updates its settings in existing meetings; choose **Run again** to start
a fresh structured discussion with those settings.

OpenRouter's free model pricing does not bypass account usage or rate limits.
Free model requests can still fail if the OpenRouter account's configured quota
is exhausted.

## Production and system service

```sh
npm run build
npm start
```

The production server serves both the app and API on port `3001` by default.
Set `PORT` to change it. The systemd unit binds to `0.0.0.0` and requires
`BOARDROOMS_PASSWORD`; sign-in uses a signed, HTTP-only cookie and throttles
repeated failed attempts. Use this direct HTTP setup only on a trusted LAN. For
untrusted networks, put it behind an HTTPS reverse proxy.

On this host, install and start the systemd unit:

```sh
sudo install -D -m 0644 deploy/boardrooms.service /etc/systemd/system/boardrooms.service
sudo systemctl daemon-reload
sudo systemctl enable --now boardrooms
```

Check it with `systemctl status boardrooms` and
`curl http://localhost:3001/api/health`. On the LAN, open
`http://<server-lan-ip>:3001` and sign in with `BOARDROOMS_PASSWORD`. After
updating code or `.env`, rebuild with `npm run build`, reinstall the unit if its
permissions changed, and restart with
`sudo systemctl restart boardrooms`.

## API

- `GET /api/health` — server health.
- `GET /api/state` — shared advisor profiles, meetings, and transcripts.
- `POST /api/state/import` — one-time import of existing browser data.
- `PUT /api/state` — save shared advisor and meeting data.
- `GET /api/providers` — provider-key availability (never returns key values).
- `POST /api/boardrooms/run` — streams boardroom progress as newline-delimited
  JSON events.
- `POST /api/boardrooms/report` — streams advisor contributions and the completed
  report as newline-delimited JSON events.
