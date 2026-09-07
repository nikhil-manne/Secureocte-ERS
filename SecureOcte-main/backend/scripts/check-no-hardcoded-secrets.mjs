import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const scanRoots = [
  "config",
  "middlewares",
  "monitoring",
  "queues",
  "routes",
  "services",
  "socket",
  "models",
  "server.js",
  "gemini.js",
];

const textExtensions = new Set([".js", ".cjs", ".mjs", ".json", ".html"]);
const findings = [];

const patterns = [
  {
    name: "Google API key",
    regex: /AIza[0-9A-Za-z\-_]{35}/g,
  },
  {
    name: "Bearer token literal",
    regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  },
  {
    name: "Suspicious env assignment",
    regex: /\b(?:JWT_SECRET|ADMIN_PASSWORD|GEMINI_API_KEY|REDIS_URL|MONGO_URI)\s*[:=]\s*["'][^"']+["']/g,
  },
];

function shouldSkip(fullPath) {
  const normalized = fullPath.replace(/\\/g, "/");
  return normalized.includes("/node_modules/") || normalized.includes("/scripts/");
}

function walk(targetPath) {
  const fullPath = path.join(rootDir, targetPath);
  if (!fs.existsSync(fullPath)) return;

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(fullPath)) {
      walk(path.join(targetPath, entry));
    }
    return;
  }

  if (shouldSkip(fullPath)) return;
  if (!textExtensions.has(path.extname(fullPath))) return;

  const contents = fs.readFileSync(fullPath, "utf8");
  for (const pattern of patterns) {
    const matches = [...contents.matchAll(pattern.regex)];
    for (const match of matches) {
      findings.push({
        file: targetPath.replace(/\\/g, "/"),
        type: pattern.name,
        snippet: match[0].slice(0, 80),
      });
    }
  }
}

for (const scanRoot of scanRoots) {
  walk(scanRoot);
}

if (findings.length > 0) {
  console.error("Hardcoded secret scan failed.");
  for (const finding of findings) {
    console.error(`- ${finding.type} in ${finding.file}: ${finding.snippet}`);
  }
  process.exit(1);
}

console.log("No hardcoded secrets detected in backend scan paths.");
