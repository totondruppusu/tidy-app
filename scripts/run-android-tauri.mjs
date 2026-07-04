#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MINIMUM_JAVA_MAJOR = 17;
const MAXIMUM_JAVA_MAJOR = 21;
const androidArgs = process.argv.slice(2);

if (androidArgs.length === 0) {
  console.error("Usage: node scripts/run-android-tauri.mjs <android-subcommand> [...args]");
  process.exit(1);
}

function parseJavaMajor(versionOutput) {
  const match = versionOutput.match(/version "([^"]+)"/);
  if (!match) {
    return null;
  }

  const rawVersion = match[1];
  if (rawVersion.startsWith("1.")) {
    const legacyMajor = Number(rawVersion.split(".")[1]);
    return Number.isFinite(legacyMajor) ? legacyMajor : null;
  }

  const major = Number(rawVersion.split(".")[0]);
  return Number.isFinite(major) ? major : null;
}

function getJavaMajor(javaExecutable) {
  try {
    const result = spawnSync(javaExecutable, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return parseJavaMajor(output);
  } catch {
    return null;
  }
}

function resolveMacOsJavaHome(versionSpec) {
  try {
    return execFileSync("/usr/libexec/java_home", ["-v", versionSpec], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveBrewJavaHome(formulaName) {
  try {
    const brewPrefix = execFileSync("brew", ["--prefix", formulaName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const javaHome = path.join(brewPrefix, "libexec", "openjdk.jdk", "Contents", "Home");
    return isUsableJavaHome(javaHome) ? javaHome : null;
  } catch {
    return null;
  }
}

function isUsableJavaHome(javaHome) {
  if (!javaHome) {
    return false;
  }

  const javaExecutable = path.join(javaHome, "bin", "java");
  const major = getJavaMajor(javaExecutable);
  return major !== null && major >= MINIMUM_JAVA_MAJOR && major <= MAXIMUM_JAVA_MAJOR;
}

function resolveKnownJavaHome(javaHome) {
  return isUsableJavaHome(javaHome) ? javaHome : null;
}

function resolveJavaHomeFromPath() {
  try {
    const javaPath = execFileSync("which", ["java"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const resolvedJavaPath = fs.realpathSync(javaPath);
    let javaHome = path.dirname(path.dirname(resolvedJavaPath));
    if (path.basename(javaHome) === "jre") {
      javaHome = path.dirname(javaHome);
    }
    return isUsableJavaHome(javaHome) ? javaHome : null;
  } catch {
    return null;
  }
}

function findJavaHome() {
  if (isUsableJavaHome(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }

  if (process.platform === "darwin") {
    const androidStudioCandidates = [
      "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
      "/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
    ];
    for (const javaHome of androidStudioCandidates) {
      const resolvedJavaHome = resolveKnownJavaHome(javaHome);
      if (resolvedJavaHome) {
        return resolvedJavaHome;
      }
    }

    const macCandidates = ["21+", "17+"];
    for (const versionSpec of macCandidates) {
      const javaHome = resolveMacOsJavaHome(versionSpec);
      if (isUsableJavaHome(javaHome)) {
        return javaHome;
      }
    }

    const brewCandidates = ["openjdk@21", "openjdk@17"];
    for (const formulaName of brewCandidates) {
      const javaHome = resolveBrewJavaHome(formulaName);
      if (javaHome) {
        return javaHome;
      }
    }
  }

  return resolveJavaHomeFromPath();
}

const javaHome = findJavaHome();
if (!javaHome) {
  console.error(
    `Android builds require Java ${MINIMUM_JAVA_MAJOR}-${MAXIMUM_JAVA_MAJOR}.\n` +
      "Use Android Studio's bundled JDK or install a compatible JDK and set JAVA_HOME before running the Android commands."
  );
  process.exit(1);
}

const tauriExecutable = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri"
);

const child = spawnSync(tauriExecutable, ["android", ...androidArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
    PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  },
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

process.exit(child.status ?? 1);
