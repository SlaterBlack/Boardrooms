# BoardMeetings

A full-stack React and Express starter for a board-meeting workspace.

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Run locally

```sh
npm install
npm run dev
```

The React app runs at <http://localhost:5173>. The Express API runs at
<http://localhost:3001>, and Vite proxies `/api` requests to it.

## Production

```sh
npm run build
npm start
```

The server serves the built React app and the API from the same port. Set
`PORT` to change the default port (`3001`).

## API

- `GET /api/health` — returns the API service status.
