# DiscussIt

DiscussIt is an AI chat hub. Configure advisors with different roles,
providers, models, and instructions; bring one or more into a boardroom; and
work through an ongoing chat or build a report together.

## Requirements

- Node.js 22.12+
- npm
- An API key for at least one supported provider

## Configure provider keys

Copy `.env.example` to `.env` and add the provider keys you want to use:

```sh
test -f .env || cp .env.example .env
chmod 600 .env
```

Set any of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or
`OPENROUTER_API_KEY` in `.env`, and set `BOARDROOMS_PASSWORD` to a unique
password of at least 16 characters for network sign-in. `GEMINI_API_KEY` is a
Gemini Developer API key from Google AI Studio. Set `MAGNIFIC_API_KEY` to enable
the Magnific image processor. Provider keys stay on the DiscussIt server and
are never sent to the browser. Do not commit `.env`. If `.env` already exists,
edit it rather than replacing it.

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
  up to five agents from the roster. Each boardroom needs one text-capable
  **Orchestrator** and at least one other text-capable agent.
- Use the **Agents** tab to add, edit, or delete agent profiles. Configure each
  agent's provider, model ID, perspective, knowledge, skills, and instructions.
  Model capabilities such as image input, image generation, image processing,
  and web search are shown on the profile and derived from the selected model.
- OpenRouter agents use the OpenAI-compatible API. Enter the provider-prefixed
  model slug from your OpenRouter model catalog (for example,
  `openai/gpt-4o-mini`).
- `google/gemini-decision-1` is available as a routing-only Orchestrator via
  OpenRouter's Decisions API. It selects responding agents with typed choices;
  it does not generate chat text and cannot be selected as a responder. Its
  advertised standard pricing is input-token based, so it is inexpensive but
  not free; verify current provider pricing before use.
- Gemini agents use Google's Gemini Developer API with model discovery, image
  understanding, streamed responses, Google Search grounding for Researcher
  roles, and native image generation on compatible models. Google Search
  grounding can incur separate search usage charges in addition to model-token
  charges; check Google AI Studio pricing and quotas.
- The Orchestrator makes one routing request per message and assigns temporary
  roles to the smallest effective sequence of up to three agents, constrained
  by their model capabilities. Start a message with `@{agent name}` to address
  one agent directly; for example, `@{Bonnie Green} assess the low-carbon
  options`. Follow-up messages include the earlier conversation for context.
- Agent replies and facilitator synthesis stream into the chat as they are
  generated. Internal Orchestrator routing and memory compaction remain
  non-streamed; streaming changes when text appears, not the model calls or
  token-based provider charges.
- Depending on the request, the Orchestrator can select roles such as
  Researcher, Facilitator, Critic, Synthesizer, Image Analyser, or Executor.
  Attach a PNG, JPEG, or WebP image (up to 7 MB) for analysis by a model with
  image-input support. For image creation, it selects one model with image
  generation support, including Magnific Mystic. Generated images are saved
  in the private server data directory. Image generation and Magnific
  processing may incur provider charges.
- Attach up to three PDF, DOCX, TXT, Markdown, CSV, XLSX, or PPTX files
  (10 MB each) to a chat message. Originals are stored in the private server
  data directory and can be downloaded from the conversation. DiscussIt extracts
  selectable text for model context, capped at 12,000 characters per file and
  18,000 characters across a message. Scanned PDFs and image-only content are
  not OCR-processed.
- Report/document-building chats have **Chat** and **Report preview** tabs.
  The Orchestrator routes each turn and the team synthesizes the chat. Choose
  **Generate report** beneath a team synthesis to create a scope document,
  review document, or custom report. The agents contribute relevant sections,
  and the Orchestrator selects an agent to assemble the final report. Configure
  company style rules in agent instructions or knowledge. Downloading a saved
  PDF makes no provider request.
- Image-processing-capable services such as Magnific can upscale PNG, JPEG, or
  WebP images (2x–16x); uploads are sent to Magnific and may incur charges.

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
