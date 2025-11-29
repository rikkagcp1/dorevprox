import http from "node:http";
import * as utils from "../src/utils"

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
	const url = req.url ?? "/";
	res.statusCode = 200;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify({ ok: true, method: req.method, url }));
});

server.listen(port, () => {
	console.log(utils.randomInt(1024, 65536));
	console.log(`Listening on http://localhost:${port}`);
});
