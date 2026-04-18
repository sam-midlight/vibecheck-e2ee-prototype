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

const { buildNumber, gitSha } = getGitVersion();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_NUMBER: buildNumber,
    NEXT_PUBLIC_GIT_SHA: gitSha,
  },
};

export default nextConfig;
