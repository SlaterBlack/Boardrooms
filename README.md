# DiscussIt

DiscussIt is an AI chat hub. Configure advisors with different roles,
providers, models, and instructions; bring one or more into a boardroom; and
work through an ongoing chat or build a report together.

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
characters for network sign-in. Set `MAGNIFIC_API_KEY` to enable the Magnific
image processor. Provider keys stay on the DiscussIt server and are never sent to the
browser. Do not commit `.env`. If `.env` already exists, edit it rather than
replacing it.

## Run locally

```sh
npm install
npm run dev
```

The React app runs at <http://localhost:5173>. The Express API runs at
<http://localhost:3001>; Vite proxies `/api` requests to it. Provider requests
are made server-side.

## How a boardroom works

- Use the **Chats** tab to create an ongoing chat, choose its type, and select
  up to five agents from the roster. Each profile has a default boardroom role;
  that role is preselected when the agent is added.
- Use the **Agents** tab to add, edit, or delete agent profiles. Configure each
  agent's provider, model ID, perspective, knowledge, skills, and instructions.
- OpenRouter agents use the OpenAI-compatible API. Enter the provider-prefixed
  model slug from your OpenRouter model catalog (for example,
  `openai/gpt-4o-mini`).
- Assign roles to agents per chat. Each new boardroom needs one
  **Orchestrator** and at least one **Meeting Member**. The Orchestrator makes
  one additional request per message and routes it to the smallest effective
  sequence of one to three agents. Start a message with `@{advisor name}` to
  address one Meeting Member directly; for example,
  `@{Bonnie Green} assess the low-carbon options`. Follow-up messages include
  the earlier conversation for context.
- A **Researcher** uses the provider's web-search integration and includes
  source links. Attach a PNG, JPEG, or WebP image (up to 7 MB) to have the
  **Image Analyser** inspect it. The **Image Generator** works with models
  marked as image-capable, including Magnific Mystic; generated images are
  saved in the private server data directory and shared through the signed-in
  app. Image generation and Magnific processing may incur provider charges.
- The **Facilitator** asks focused clarifying questions when required, the
  **Critic** identifies risks and mitigations, the **Synthesizer** reconciles
  contributions, and the **Executor** turns approved decisions into usable
  artifacts.
- Report/document-building chats have **Chat** and **Report preview** tabs.
  The Orchestrator routes each turn and the team synthesizes the chat. Choose
  **Generate report** beneath a team synthesis to create a scope
  document, review document, or custom report. Each advisor drafts relevant
  sections from their expertise and the **Document Formatter** applies the
  final document style. Configure company style rules in that agent's
  instructions or knowledge. Downloading a saved PDF makes no provider request.
- The **Image Processor** uses Magnific to upscale PNG, JPEG, or WebP images
  (2x–16x); uploads are sent to Magnific and may incur charges.

Agent profiles, meeting details, discussion transcripts, and chat messages are
stored by the server in `.boardrooms-data/state.json`, so they are shared across
signed-in browsers and devices. Generated reports are saved with their
boardroom. This private data directory is excluded from Git. On first
connection, existing browser data is imported into the server store. Editing an
agent updates its settings in existing boardrooms for future chat turns.
Previously saved structured meetings remain available as legacy records, but
new boardrooms are chat-only.

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
- `POST /api/boardrooms/images/upscale` — upscales an uploaded image through
  Magnific and returns its result URL.
- `GET /api/boardrooms/images/generated/:file` — serves a generated image to
  an authenticated boardroom session.
