import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const allowDirty = process.argv.includes("--allow-dirty");

const versionFiles = {
  packageJson: path.join(repoRoot, "package.json"),
  packageLock: path.join(repoRoot, "package-lock.json"),
  cargoToml: path.join(repoRoot, "src-tauri", "Cargo.toml"),
  tauriConfig: path.join(repoRoot, "src-tauri", "tauri.conf.json"),
};

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  return typeof output === "string" ? output.trim() : "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    fail(`Unsupported version format: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left, right) {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }

  return left.patch - right.patch;
}

function findLatestTaggedVersion() {
  const tags = run("git", ["tag"]);
  if (!tags) {
    return null;
  }

  return tags
    .split(/\r?\n/)
    .map((tag) => /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? null)
    .filter(Boolean)
    .map((version) => ({ version, parsed: parseSemver(version) }))
    .sort((left, right) => compareSemver(left.parsed, right.parsed))
    .at(-1) ?? null;
}

function formatJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureCleanWorktree() {
  if (allowDirty) {
    return;
  }

  const status = run("git", ["status", "--porcelain"]);
  if (status) {
    fail("Working tree is not clean. Commit or stash changes before running release:minor.");
  }
}

function ensureOnBranch() {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    fail("Detached HEAD is not supported for release:minor.");
  }

  return branch;
}

function ensureTagDoesNotExist(tagName) {
  try {
    run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`]);
    fail(`Tag ${tagName} already exists locally.`);
  } catch (error) {
    if (error.status !== 1) {
      throw error;
    }
  }
}

function updateVersions(nextVersion) {
  const packageJson = JSON.parse(readFileSync(versionFiles.packageJson, "utf8"));
  const packageLock = JSON.parse(readFileSync(versionFiles.packageLock, "utf8"));
  const cargoToml = readFileSync(versionFiles.cargoToml, "utf8");
  const tauriConfig = JSON.parse(readFileSync(versionFiles.tauriConfig, "utf8"));

  packageJson.version = nextVersion;
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
  tauriConfig.version = nextVersion;

  const nextCargoToml = cargoToml.replace(
    /^version\s*=\s*"[^"]+"$/m,
    `version = "${nextVersion}"`,
  );

  if (nextCargoToml === cargoToml) {
    fail("Could not update version in src-tauri/Cargo.toml.");
  }

  if (dryRun) {
    console.log(`Dry run: would update version to ${nextVersion}`);
    return;
  }

  formatJson(versionFiles.packageJson, packageJson);
  formatJson(versionFiles.packageLock, packageLock);
  formatJson(versionFiles.tauriConfig, tauriConfig);
  writeFileSync(versionFiles.cargoToml, nextCargoToml);
}

function main() {
  ensureCleanWorktree();
  const branch = ensureOnBranch();

  const packageJson = JSON.parse(readFileSync(versionFiles.packageJson, "utf8"));
  const currentVersion = packageJson.version;
  const currentParsed = parseSemver(currentVersion);
  const latestTagged = findLatestTaggedVersion();
  const baseline =
    latestTagged && compareSemver(latestTagged.parsed, currentParsed) > 0
      ? latestTagged
      : { version: currentVersion, parsed: currentParsed };
  const nextVersion = `${baseline.parsed.major}.${baseline.parsed.minor + 1}.0`;
  const tagName = `v${nextVersion}`;

  ensureTagDoesNotExist(tagName);
  updateVersions(nextVersion);

  console.log(`Current version: ${currentVersion}`);
  if (latestTagged) {
    console.log(`Latest tag: v${latestTagged.version}`);
  }
  if (baseline.version !== currentVersion) {
    console.log(`Baseline version: ${baseline.version}`);
  }
  console.log(`Next version: ${nextVersion}`);

  if (dryRun) {
    console.log(`Dry run: would commit, tag ${tagName}, and push branch ${branch} to origin.`);
    return;
  }

  run("git", [
    "add",
    "package.json",
    "package-lock.json",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
  ]);
  run("git", ["commit", "-m", `chore(release): v${nextVersion}`], { stdio: "inherit" });
  run("git", ["tag", "-a", tagName, "-m", `Release ${tagName}`], { stdio: "inherit" });
  run("git", ["push", "origin", branch], { stdio: "inherit" });
  run("git", ["push", "origin", tagName], { stdio: "inherit" });

  console.log(`Released ${tagName}. GitHub Actions will publish the release from the tag push.`);
}

try {
  main();
} catch (error) {
  if (error?.stderr) {
    process.stderr.write(error.stderr);
  }
  fail(error.message);
}
