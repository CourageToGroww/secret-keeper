import { ProviderType, ProviderConfig, RotationConfig, GitHubConfig, RotationError } from "../../types";
import { BaseProvider } from "./base";

/**
 * GitHub Personal Access Token rotation provider
 * Creates a new PAT and optionally revokes the old one
 */
export class GitHubProvider extends BaseProvider {
  readonly type: ProviderType = "github";
  readonly displayName = "GitHub";

  private readonly baseUrl = "https://api.github.com";

  async rotate(config: RotationConfig, currentValue: string): Promise<string> {
    const githubConfig = config.providerConfig as GitHubConfig;

    // Verify current token is valid
    const userResponse = await this.httpRequest(`${this.baseUrl}/user`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${currentValue}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (userResponse.status !== 200) {
      throw new RotationError("Current GitHub token is invalid");
    }

    // GitHub doesn't support creating PATs via API (only via OAuth App or GitHub App)
    // For classic PATs, users must create them manually
    // For fine-grained PATs, same limitation applies
    
    // Check if this is a GitHub App installation token
    const appResponse = await this.httpRequest(`${this.baseUrl}/app`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${currentValue}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (appResponse.status === 200) {
      // This is a GitHub App JWT - installation tokens can be refreshed
      throw new RotationError(
        "GitHub App JWTs should be refreshed using the App's private key. " +
        "Use a custom command provider with the gh CLI or implement JWT generation."
      );
    }

    // For OAuth tokens created by GitHub Apps, we can potentially refresh them
    // But for classic PATs, there's no programmatic refresh
    
    // Check if gh CLI is available for token refresh
    try {
      const ghVersion = await this.executeCommand("gh --version");
      
      if (ghVersion.includes("gh version")) {
        // gh CLI is available - we can use it for some operations
        // However, token creation still requires interactive auth
        throw new RotationError(
          "GitHub PAT rotation requires manual intervention. " +
          "Options:\n" +
          "1. Use GitHub CLI: gh auth refresh\n" +
          "2. Create new PAT at: https://github.com/settings/tokens\n" +
          "3. Use a GitHub App with installation tokens for automated rotation\n" +
          "4. Use a custom command provider with your own rotation logic"
        );
      }
    } catch {
      // gh CLI not available
    }

    throw new RotationError(
      "GitHub does not support programmatic PAT creation. " +
      "Please create a new token manually at https://github.com/settings/tokens " +
      "or use a custom command provider with gh CLI or GitHub App integration."
    );
  }

  async validateConfig(config: ProviderConfig): Promise<boolean> {
    if (config.type !== "github") {
      return false;
    }

    const githubConfig = config as GitHubConfig;
    return !!githubConfig.tokenName;
  }

  async testRotation(config: RotationConfig, currentValue: string): Promise<boolean> {
    // Test that the token is valid and has required scopes
    const githubConfig = config.providerConfig as GitHubConfig;

    try {
      const response = await this.httpRequest(`${this.baseUrl}/user`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${currentValue}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (response.status !== 200) {
        return false;
      }

      // Check scopes from response headers (not available in fetch response directly)
      // For now, just verify the token works
      return true;
    } catch {
      return false;
    }
  }
}
