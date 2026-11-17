// Runs on Render's free plan after the move to Cloudflare: sends every request on the
// old onrender.com address (including ?room= invite links) to the Cloudflare Worker.
const http = require('http');
const TARGET = process.env.REDIRECT_TO || 'https://nba-draft.rahulchonkria.workers.dev';
http.createServer((req, res) => {
  res.writeHead(301, { Location: TARGET + req.url, 'Cache-Control': 'public, max-age=86400' });
  res.end();
}).listen(process.env.PORT || 3000);
