import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPluginApp,
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "./vendor/rift-plugin-build-0.42.1.mjs";
import { pluginBuildRiftVersion } from "./plugin-build-provenance.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const appOnly = arguments_[0] === "--app-only";
const pluginArgument = arguments_[appOnly ? 1 : 0];
if (appOnly && pluginArgument === undefined) {
  throw new Error("--app-only requires a plugin path");
}
const pluginPath = resolve(pluginArgument ?? process.cwd());

const toolchain = await resolvePluginBuildToolchain(repositoryRoot);
const files = [];
if (!appOnly) {
  const server = await buildPluginServer(
    pluginPath,
    pluginBuildRiftVersion,
    toolchain,
  );
  files.push(server.jsPath, server.mapPath, server.metaPath);
}
const manifest = JSON.parse(
  await readFile(resolve(pluginPath, "package.json"), "utf8"),
);
if (typeof manifest.rift?.app === "string") {
  const app = await buildPluginApp(pluginPath, pluginBuildRiftVersion, toolchain);
  files.push(app.jsPath, app.cssPath, app.metaPath);
} else if (appOnly) {
  throw new Error(`${manifest.name}: --app-only requires rift.app`);
}

for (const file of files) console.log(file);
