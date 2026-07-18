# 🏀 NBA All-Time Draft

A realtime, multiplayer draft game. Everyone joins from their own phone or laptop,
snake-drafts a 12-player roster from **266 players** (current NBA stars + all-time
legends, ratings pulled from 2K), then votes on whose team is best in custom categories.

Run your actual head-to-head sims on NBA 2K — this app handles the drafting and the voting.

## Requirements
- [Node.js](https://nodejs.org) 18 or newer.

## Setup
```bash
cd nba-draft
npm install      # installs the one dependency (ws)
npm start        # starts the server on http://localhost:3000
```

You'll see:
```
🏀  NBA All-Time Draft running
    Local:   http://localhost:3000
    Network: http://<your-LAN-IP>:3000
```

## How players connect
- **Same machine / testing:** open `http://localhost:3000`.
- **Friends on the same WiFi:** share `http://<your-LAN-IP>:3000` (find your IP with
  `ipconfig` on Windows or `ifconfig`/`ip a` on Mac/Linux, e.g. `192.168.1.42`).
- **Friends over the internet:** run it on a small VPS, or expose your local server with a
  tunnel like [ngrok](https://ngrok.com) (`ngrok http 3000`) and share the https URL.
  Set a custom port with `PORT=8080 npm start` if needed.

## How to play
1. **Host** clicks *Create room* and gets a 4-letter code.
2. Everyone else enters the code + their team name to join (up to **16 drafters**).
3. Host sets **roster size** (default 12) and an optional **pick timer**, shuffles the
   draft order if desired, and starts the draft.
4. **Snake draft:** order reverses each round. When it's your turn, search/filter the pool
   and hit *Draft*. If the pick timer runs out, the best available player is auto-picked.
5. When every roster is full, the host adds **voting categories** (e.g. *Best Offense*,
   *Best Starting 5*, *Most Fun to Watch*) and opens voting.
6. Everyone votes for a team per category (change your vote any time until reveal).
7. Host hits **Reveal results** — winners per category, vote bars, and a category-crown
   leaderboard. Start a new game in the same room whenever you like.

## Notes
- Reconnecting: if someone's browser drops, reopening the URL rejoins them automatically
  (the draft keeps their team and picks).
- The player pool lives in `public/players.json` — edit it to add, remove, or re-rate
  players. Each entry: `{ id, name, overall, positions, height, team, era }`.
- **Persistent rooms:** active games are saved to `data/rooms.json` and restored when the
  server restarts, so a mid-draft crash or reboot won't lose picks or votes. Players
  reconnect automatically. Rooms untouched for 48 hours are pruned. Delete `data/rooms.json`
  to wipe all saved games.

## Refreshing ratings
Ratings came from 2kratings.com. To update after a new roster update, regenerate
`public/players.json` in the same shape and restart the server.
