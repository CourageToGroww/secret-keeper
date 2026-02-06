import { ProviderType, ProviderConfig, RotationConfig, AWSConfig, RotationError } from "../../types";
import { BaseProvider } from "./base";

/**
 * AWS IAM access key rotation provider
 * Creates a new access key and deletes the old one
 */
export class AWSProvider extends BaseProvider {
  readonly type: ProviderType = "aws";
  readonly displayName = "AWS IAM";

  async rotate(config: RotationConfig, currentValue: string): Promise<string> {
    const awsConfig = config.providerConfig as AWSConfig;

    // AWS rotation requires the AWS CLI to be installed
    // We'll use the CLI for reliable cross-platform support

    // First verify current credentials work
    const region = awsConfig.region || "us-east-1";
    
    // Get current user info
    const getUserCmd = `AWS_ACCESS_KEY_ID="${process.env[awsConfig.accessKeyIdName] || ""}" ` +
      `AWS_SECRET_ACCESS_KEY="${currentValue}" ` +
      `AWS_DEFAULT_REGION="${region}" ` +
      `aws sts get-caller-identity --output json`;

    let userInfo: any;
    try {
      const output = await this.executeCommand(getUserCmd);
      userInfo = JSON.parse(output);
    } catch (error) {
      throw new RotationError(`Failed to verify AWS credentials: ${error}`);
    }

    // Extract username from ARN
    const arnParts = userInfo.Arn.split("/");
    const userName = arnParts[arnParts.length - 1];

    // Create new access key
    const createKeyCmd = `AWS_ACCESS_KEY_ID="${process.env[awsConfig.accessKeyIdName] || ""}" ` +
      `AWS_SECRET_ACCESS_KEY="${currentValue}" ` +
      `AWS_DEFAULT_REGION="${region}" ` +
      `aws iam create-access-key --user-name "${userName}" --output json`;

    let newKeyInfo: any;
    try {
      const output = await this.executeCommand(createKeyCmd);
      newKeyInfo = JSON.parse(output);
    } catch (error) {
      throw new RotationError(`Failed to create new access key: ${error}`);
    }

    const newAccessKeyId = newKeyInfo.AccessKey.AccessKeyId;
    const newSecretKey = newKeyInfo.AccessKey.SecretAccessKey;

    // Verify the new key works (may take a moment to propagate)
    await new Promise(resolve => setTimeout(resolve, 5000));

    const verifyCmd = `AWS_ACCESS_KEY_ID="${newAccessKeyId}" ` +
      `AWS_SECRET_ACCESS_KEY="${newSecretKey}" ` +
      `AWS_DEFAULT_REGION="${region}" ` +
      `aws sts get-caller-identity --output json`;

    try {
      await this.executeCommand(verifyCmd);
    } catch (error) {
      // If verification fails, delete the new key and throw error
      const deleteNewCmd = `AWS_ACCESS_KEY_ID="${process.env[awsConfig.accessKeyIdName] || ""}" ` +
        `AWS_SECRET_ACCESS_KEY="${currentValue}" ` +
        `AWS_DEFAULT_REGION="${region}" ` +
        `aws iam delete-access-key --user-name "${userName}" --access-key-id "${newAccessKeyId}"`;
      
      try {
        await this.executeCommand(deleteNewCmd);
      } catch {
        // Ignore cleanup errors
      }

      throw new RotationError(`New access key verification failed: ${error}`);
    }

    // Delete old access key
    const oldAccessKeyId = process.env[awsConfig.accessKeyIdName] || "";
    if (oldAccessKeyId) {
      const deleteOldCmd = `AWS_ACCESS_KEY_ID="${newAccessKeyId}" ` +
        `AWS_SECRET_ACCESS_KEY="${newSecretKey}" ` +
        `AWS_DEFAULT_REGION="${region}" ` +
        `aws iam delete-access-key --user-name "${userName}" --access-key-id "${oldAccessKeyId}"`;

      try {
        await this.executeCommand(deleteOldCmd);
      } catch (error) {
        // Log but don't fail - the new key is already working
        console.warn(`Warning: Failed to delete old access key: ${error}`);
      }
    }

    // Return both the new access key ID and secret key as JSON
    // The rotation manager will need to handle updating both secrets
    return JSON.stringify({
      accessKeyId: newAccessKeyId,
      secretAccessKey: newSecretKey,
    });
  }

  async validateConfig(config: ProviderConfig): Promise<boolean> {
    if (config.type !== "aws") {
      return false;
    }

    const awsConfig = config as AWSConfig;
    return !!awsConfig.accessKeyIdName && !!awsConfig.secretAccessKeyName;
  }

  async testRotation(config: RotationConfig, currentValue: string): Promise<boolean> {
    const awsConfig = config.providerConfig as AWSConfig;
    const region = awsConfig.region || "us-east-1";

    // Test that AWS CLI is installed and credentials are valid
    const testCmd = `AWS_ACCESS_KEY_ID="${process.env[awsConfig.accessKeyIdName] || ""}" ` +
      `AWS_SECRET_ACCESS_KEY="${currentValue}" ` +
      `AWS_DEFAULT_REGION="${region}" ` +
      `aws sts get-caller-identity --output json`;

    try {
      await this.executeCommand(testCmd);
      return true;
    } catch {
      return false;
    }
  }
}
