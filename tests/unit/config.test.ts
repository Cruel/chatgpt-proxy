import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, parseConfigText } from "../../src/config/index.js";

const HOME_DIRECTORY = "/tmp/chatgpt-proxy-test-home";
const BASE_DIRECTORY = "/tmp/chatgpt-proxy-project";

const MINIMAL_CONFIG = `
[server]
api_token = "test-token"

[chatgpt]
project_url = "https://chatgpt.com/g/g-p-example/project"
`;

describe("configuration", () => {
  it("applies safe defaults", () => {
    const config = parseConfigText(MINIMAL_CONFIG, {
      homeDirectory: HOME_DIRECTORY,
      baseDirectory: BASE_DIRECTORY,
    });

    expect(config.server).toEqual({
      listenHost: "127.0.0.1",
      listenPort: 7421,
      apiToken: "test-token",
    });
    expect(config.chatGpt.deleteRemoteThread).toBe(false);
    expect(config.chatGpt.headless).toBe(false);
    expect(config.chatGpt.profileDirectory).toBe(
      join(BASE_DIRECTORY, ".playwright-profile"),
    );
    expect(config.browser.maxConcurrentRuns).toBe(3);
    expect(config.browser.channel).toBe("chromium");
    expect(config.limits.maxInputCharacters).toBe(100_000);
    expect(config.database.path).toBe(
      join(BASE_DIRECTORY, "state.sqlite3"),
    );
    expect(config.diagnostics.artifactDirectory).toBe(
      join(BASE_DIRECTORY, ".artifacts"),
    );
    expect(config.liveTests).toEqual({
      enabled: false,
      projectUrl: "",
      threadPrefix: "chatgpt-proxy-e2e",
      allowRemoteDeletion: false,
    });
  });

  it("allows remote deletion only when explicitly configured", () => {
    const config = parseConfigText(MINIMAL_CONFIG, {
      homeDirectory: HOME_DIRECTORY,
      baseDirectory: BASE_DIRECTORY,
    });

    expect(config.chatGpt.deleteRemoteThread).toBe(false);

    const enabled = parseConfigText(
      `
[server]
api_token = "test-token"

[chatgpt]
project_url = "https://chatgpt.com/g/g-p-example/project"
delete_remote_thread = true
`,
      {
        homeDirectory: HOME_DIRECTORY,
        baseDirectory: BASE_DIRECTORY,
      },
    );

    expect(enabled.chatGpt.deleteRemoteThread).toBe(true);
  });

  it("expands home paths before requiring absolute paths", () => {
    const config = parseConfigText(
      `
[server]
api_token = "test-token"

[chatgpt]
project_url = "https://chatgpt.com/g/g-p-example/project"
profile_dir = "~/.profiles/chatgpt"
`,
      {
        homeDirectory: HOME_DIRECTORY,
        baseDirectory: BASE_DIRECTORY,
      },
    );

    expect(config.chatGpt.profileDirectory).toBe(
      join(HOME_DIRECTORY, ".profiles", "chatgpt"),
    );
  });

  it("resolves relative runtime paths from the config directory", () => {
    const config = parseConfigText(
      `
[server]
api_token = "test-token"

[chatgpt]
project_url = "https://chatgpt.com/g/g-p-example/project"
profile_dir = "./.profile"

[database]
path = "./data/state.sqlite3"

[diagnostics]
artifact_dir = "./artifacts"
`,
      {
        homeDirectory: HOME_DIRECTORY,
        baseDirectory: BASE_DIRECTORY,
      },
    );

    expect(config.chatGpt.profileDirectory).toBe(
      join(BASE_DIRECTORY, ".profile"),
    );
    expect(config.database.path).toBe(
      join(BASE_DIRECTORY, "data", "state.sqlite3"),
    );
    expect(config.diagnostics.artifactDirectory).toBe(
      join(BASE_DIRECTORY, "artifacts"),
    );
  });

  it("rejects non-loopback listeners and non-ChatGPT project URLs", () => {
    expect(() =>
      parseConfigText(
        `
[server]
listen_host = "0.0.0.0"
api_token = "test-token"

[chatgpt]
project_url = "https://example.com/project"
`,
        { homeDirectory: HOME_DIRECTORY },
      ),
    ).toThrow(ConfigError);
  });

  it("requires a separate project URL when live tests are enabled", () => {
    expect(() =>
      parseConfigText(
        `${MINIMAL_CONFIG}

[live_tests]
enabled = true
`,
        { homeDirectory: HOME_DIRECTORY },
      ),
    ).toThrow(/live-test project URL/);
  });

  it("requires both live-test and production deletion gates", () => {
    expect(() =>
      parseConfigText(
        `${MINIMAL_CONFIG}

[live_tests]
allow_remote_deletion = true
`,
        { homeDirectory: HOME_DIRECTORY },
      ),
    ).toThrow(/live tests are disabled/);

    expect(() =>
      parseConfigText(
        `${MINIMAL_CONFIG}

[live_tests]
enabled = true
project_url = "https://chatgpt.com/g/g-p-live/project"
allow_remote_deletion = true
`,
        { homeDirectory: HOME_DIRECTORY },
      ),
    ).toThrow(/chatgpt\.delete_remote_thread/);

    const enabled = parseConfigText(
      `
[server]
api_token = "test-token"

[chatgpt]
project_url = "https://chatgpt.com/g/g-p-example/project"
delete_remote_thread = true

[live_tests]
enabled = true
project_url = "https://chatgpt.com/g/g-p-live/project"
allow_remote_deletion = true
`,
      { homeDirectory: HOME_DIRECTORY },
    );
    expect(enabled.liveTests.allowRemoteDeletion).toBe(true);
  });

  it("rejects persistent browser profiles on mounted Windows drives", () => {
    expect(() =>
      parseConfigText(
        `
[server]
api_token = "test-token"

[chatgpt]
project_url = "https://chatgpt.com/g/g-p-example/project"
profile_dir = "/mnt/c/Users/example/chrome-profile"
`,
        { homeDirectory: HOME_DIRECTORY, baseDirectory: "/tmp/project" },
      ),
    ).toThrow(/WSL filesystem/);
  });
});
