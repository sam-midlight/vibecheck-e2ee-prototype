import type { NextConfig } from "next";
import { execSync } from "child_process";

function getGitVersion(): { buildNumber: string; gitSha: string } {
  try {
    const buildNumber = execSync("git rev-list --count HEAD", { stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
    const gitSha = execSync("git rev-parse --short HEAD", { stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
    return { buildNumber, gitSha };
  } catch {
    return { buildNumber: "0", gitSha: "unknown" };
  }
}

function getBuildTime(): string {
  // UTC+10 (AEST, no DST adjustment)
  const now = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(now.getUTCFullYear()).slice(2);
  return `${dd}/${mm}/${yy}`;
}

const { buildNumber, gitSha } = getGitVersion();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_NUMBER: buildNumber,
    NEXT_PUBLIC_GIT_SHA: gitSha,
    NEXT_PUBLIC_BUILD_TIME: getBuildTime(),
  },
};

export default nextConfig;
