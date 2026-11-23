# BoardMeetings

BoardMeetings is an AI meeting hub. Configure advisors with different roles,
providers, models, and instructions; bring one or more into a boardroom; and
give them a task to discuss. The facilitator then synthesizes their discussion
into a decision-ready conclusion.

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

Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or both in `.env`, and set
`BOARDMEETINGS_PASSWORD` to a unique password of at least 16 characters for
network sign-in. Provider keys stay on the server and are never sent to the
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

- Use the **Meetings** tab to create meetings, add an agenda, and choose one to
  five named agents from the roster.
- Use the **Agents** tab to add, edit, or delete agent profiles. Configure each
  agent's provider, model ID, perspective, knowledge, skills, and instructions.
- Choose one to three discussion rounds and a facilitator.
- Each advisor speaks in turn and can respond to the earlier discussion. The
  facilitator makes a final synthesis.
- A run makes one provider request per advisor per round, plus one synthesis
  request. Provider usage may incur charges.

Agent profiles, meeting details, and transcripts are saved in that browser's
local storage; the server does not persist them or synchronize them across
devices. Meetings keep a snapshot of the agents selected when they are created.

## Production and system service

```sh
npm run build
npm start
```

The production server serves both the app and API on port `3001` by default.
Set `PORT` to change it. The systemd unit binds to `0.0.0.0` and requires
`BOARDMEETINGS_PASSWORD`; sign-in uses a signed, HTTP-only cookie and throttles
repeated failed attempts. Use this direct HTTP setup only on a trusted LAN. For
untrusted networks, put it behind an HTTPS reverse proxy.

On this host, install and start the systemd unit:

```sh
sudo install -D -m 0644 deploy/boardmeetings.service /etc/systemd/system/boardmeetings.service
sudo systemctl daemon-reload
sudo systemctl enable --now boardmeetings
```

Check it with `systemctl status boardmeetings` and
`curl http://localhost:3001/api/health`. On the LAN, open
`http://<server-lan-ip>:3001` and sign in with `BOARDMEETINGS_PASSWORD`. After
updating code or `.env`, rebuild with `npm run build` and restart with
`sudo systemctl restart boardmeetings`.

## API

- `GET /api/health` — server health.
- `GET /api/providers` — provider-key availability (never returns key values).
- `POST /api/boardrooms/run` — streams boardroom progress as newline-delimited
  JSON events.
