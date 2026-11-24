const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src");
const OUT = path.join(__dirname, "douyin-auto-like.user.js");

const read = (file) => fs.readFileSync(path.join(SRC, file), "utf8").replace(/\r\n/g, "\n").trim();

const escapeTemplate = (text) => text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const ui = read(path.join("ui", "ui.js"))
  .replace("__PANEL_CSS__", () => "\n" + escapeTemplate(read(path.join("ui", "panel.css"))) + "\n")
  .replace("__PANEL_HTML__", () => "\n" + escapeTemplate(read(path.join("ui", "panel.html"))) + "\n");

const output = [
  read("header.txt"),
  "(function () {",
  '  "use strict";',
  read("config.js"),
  read("utils.js"),
  read("state.js"),
  read("platform.js"),
  read("records.js"),
  read("auto-like.js"),
  read("sleep-timer.js"),
  ui,
  read("init.js"),
  "})();",
].join("\n\n") + "\n";

fs.writeFileSync(OUT, output, "utf8");
console.log(`built -> ${path.basename(OUT)}`);
