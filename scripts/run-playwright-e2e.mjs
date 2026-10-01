import {spawn} from "node:child_process";
import {createServer} from "node:http";
import path from "node:path";

import next from "next";

const projectRoot = process.cwd();
const playwrightCli = path.join(projectRoot, "node_modules", "@playwright", "test", "cli.js");
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const ownedBaseUrl = "http://127.0.0.1:3000";

const runPlaywright = (baseUrl) => new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [playwrightCli, "test", ...process.argv.slice(2)],
    {
      cwd: projectRoot,
      env: {...process.env, PLAYWRIGHT_BASE_URL: baseUrl},
      stdio: "inherit",
    },
  );
  child.once("error", reject);
  child.once("close", (code, signal) => resolve(
    Number.isInteger(code) ? code : signal ? 1 : 0,
  ));
});

const buildE2eApplication = () => new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, "node_modules", "next", "dist", "bin", "next"), "build"],
    {
      cwd: projectRoot,
      env: {...process.env, PAX_E2E_BUILD: "1"},
      stdio: "inherit",
    },
  );
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`E2E application build failed (${code ?? signal ?? "unknown"})`));
  });
});

if (externalBaseUrl) {
  process.exitCode = await runPlaywright(externalBaseUrl);
} else {
  await buildE2eApplication();
  process.env.PAX_E2E_BUILD = "1";
  const app = next({
    dev: false,
    dir: projectRoot,
    hostname: "127.0.0.1",
    port: 3000,
  });
  const handle = app.getRequestHandler();
  await app.prepare();
  const server = createServer((request, response) => handle(request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(3000, "127.0.0.1", resolve);
  });
  try {
    process.exitCode = await runPlaywright(ownedBaseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    await app.close();
  }
}
