// Tiny static server for the sample shop app.
// Variants: /?variant=pr (default, new behaviour), /?variant=base (old behaviour),
// /?variant=pr&bug=toast-name (toast shows wrong product), &bug=badge (badge not incremented),
// &bug=color (button stays blue).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "public");
const port = Number(process.env.PORT || process.argv[2] || 3000);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const p = path.join(pub, path.normalize(file));
    if (!p.startsWith(pub) || !fs.existsSync(p)) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(p).pipe(res);
  })
  .listen(port, () => console.log(`sample-app listening on http://localhost:${port}`));
