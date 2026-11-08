import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

function serve(stateDirectory) {
  const state = resolve(stateDirectory);
  const endpointFile = join(state, "endpoint.json");
  function readJson(file) {
    return JSON.parse(readFileSync(file, "utf8"));
  }

  // The process holds this separate SQLite lock for its lifetime. Two deployers,
  // including one recovering from an interrupted launch, cannot create two listeners.
  const lease = new DatabaseSync(join(state, "service-lease.sqlite"));
  lease.exec("BEGIN IMMEDIATE");
  let port = 0;
  try {
    port = readJson(endpointFile).port;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const instanceId = randomUUID();
  const controlToken = randomUUID();
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/_team/identity" && req.method === "GET") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ instanceId }));
        return;
      }
      if (req.url === "/_team/stop" && req.method === "POST") {
        if (req.headers.authorization !== "Bearer " + controlToken) {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(200, { Connection: "close" }).end("stopping");
        server.close();
        return;
      }
      const deployment = readJson(join(state, "active.json"));
      if (!/^[a-f\d]{64}$/.test(deployment.candidateDigest))
        throw Error("invalid deployment digest");
      const module = join(
        state,
        "candidates",
        deployment.candidateDigest,
        "orders-http.mjs",
      );
      const { orderHttpHandler } = await import(pathToFileURL(module).href);
      orderHttpHandler(req, res, deployment.candidateDigest);
    } catch (error) {
      console.error(error.message);
      if (!res.headersSent) res.writeHead(503);
      res.end();
    }
  });
  server.on("close", () => lease.close());
  server.once("error", (error) => {
    console.error(error.message);
    lease.close();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const endpoint = {
      instanceId,
      controlToken,
      port: server.address().port,
      pid: process.pid,
    };
    const next = endpointFile + "." + instanceId;
    writeFileSync(next, JSON.stringify(endpoint), { mode: 0o600 });
    renameSync(next, endpointFile);
  });
}

if (process.argv[2]) {
  serve(process.argv[2]);
} else if (!process.env.NODE_TEST_CONTEXT) {
  console.error("usage: node test-environment.mjs <target state directory>");
  process.exitCode = 2;
}
