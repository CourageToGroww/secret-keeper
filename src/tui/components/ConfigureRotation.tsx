import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import {
  SecretMetadata,
  ProviderType,
  ProviderConfig,
  CustomConfig,
  OpenAIConfig,
  AWSConfig,
  GitHubConfig,
} from "../../types";

interface ConfigureRotationProps {
  secrets: SecretMetadata[];
  existingConfigs: string[]; // Names of secrets that already have rotation
  onSave: (
    secretName: string,
    providerType: ProviderType,
    scheduleDays: number,
    providerConfig: ProviderConfig
  ) => void;
  onBack: () => void;
}

type Step = "secret" | "provider" | "schedule" | "config" | "confirm";

const PROVIDER_OPTIONS: Array<{ label: string; value: ProviderType }> = [
  { label: "Custom Command", value: "custom" },
  { label: "OpenAI", value: "openai" },
  { label: "AWS IAM", value: "aws" },
  { label: "GitHub", value: "github" },
];

export function ConfigureRotation({
  secrets,
  existingConfigs,
  onSave,
  onBack,
}: ConfigureRotationProps): React.ReactElement {
  const [step, setStep] = useState<Step>("secret");
  const [selectedSecret, setSelectedSecret] = useState<string>("");
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>("custom");
  const [scheduleDays, setScheduleDays] = useState("30");
  const [providerConfig, setProviderConfig] = useState<Partial<ProviderConfig>>({});
  const [configField, setConfigField] = useState<string>("rotateCommand");

  useInput((input, key) => {
    if (key.escape) {
      if (step === "secret") {
        onBack();
      } else {
        const steps: Step[] = ["secret", "provider", "schedule", "config", "confirm"];
        const idx = steps.indexOf(step);
        if (idx > 0) {
          setStep(steps[idx - 1]);
        }
      }
    }
  });

  const availableSecrets = secrets.filter((s) => !existingConfigs.includes(s.name));

  const handleSecretSelect = (item: { value: string }) => {
    if (item.value === "back") {
      onBack();
      return;
    }
    setSelectedSecret(item.value);
    setStep("provider");
  };

  const handleProviderSelect = (item: { value: string }) => {
    if (item.value === "back") {
      setStep("secret");
      return;
    }
    setSelectedProvider(item.value as ProviderType);
    
    // Initialize config based on provider
    switch (item.value) {
      case "custom":
        setProviderConfig({ type: "custom", rotateCommand: "" });
        setConfigField("rotateCommand");
        break;
      case "openai":
        setProviderConfig({ type: "openai", apiKeyName: selectedSecret });
        break;
      case "aws":
        setProviderConfig({ type: "aws", accessKeyIdName: "", secretAccessKeyName: selectedSecret });
        setConfigField("accessKeyIdName");
        break;
      case "github":
        setProviderConfig({ type: "github", tokenName: selectedSecret, scopes: [] });
        break;
    }
    
    setStep("schedule");
  };

  const handleScheduleSubmit = () => {
    const days = parseInt(scheduleDays, 10);
    if (isNaN(days) || days < 1) {
      return;
    }
    
    // Skip config step for simple providers
    if (selectedProvider === "openai" || selectedProvider === "github") {
      setStep("confirm");
    } else {
      setStep("config");
    }
  };

  const handleConfigSubmit = (value: string) => {
    if (selectedProvider === "custom") {
      const config = providerConfig as Partial<CustomConfig>;
      if (configField === "rotateCommand") {
        setProviderConfig({ ...config, type: "custom", rotateCommand: value });
        setStep("confirm");
      }
    } else if (selectedProvider === "aws") {
      const config = providerConfig as Partial<AWSConfig>;
      if (configField === "accessKeyIdName") {
        setProviderConfig({ ...config, accessKeyIdName: value });
        setStep("confirm");
      }
    }
  };

  const handleConfirm = (item: { value: string }) => {
    if (item.value === "save") {
      const fullConfig = buildProviderConfig();
      onSave(selectedSecret, selectedProvider, parseInt(scheduleDays, 10), fullConfig);
      onBack();
    } else if (item.value === "back") {
      setStep("config");
    } else if (item.value === "cancel") {
      onBack();
    }
  };

  const buildProviderConfig = (): ProviderConfig => {
    switch (selectedProvider) {
      case "custom":
        return {
          type: "custom",
          rotateCommand: (providerConfig as CustomConfig).rotateCommand || "",
        };
      case "openai":
        return {
          type: "openai",
          apiKeyName: selectedSecret,
        };
      case "aws":
        return {
          type: "aws",
          accessKeyIdName: (providerConfig as AWSConfig).accessKeyIdName || "",
          secretAccessKeyName: selectedSecret,
        };
      case "github":
        return {
          type: "github",
          tokenName: selectedSecret,
          scopes: [],
        };
    }
  };

  // Render steps
  if (step === "secret") {
    if (availableSecrets.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="cyan">
            Configure Rotation
          </Text>
          <Box marginTop={1}>
            <Text dimColor>
              {secrets.length === 0
                ? "No secrets found. Add some first with 'secret-keeper add'."
                : "All secrets already have rotation configured."}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Escape to go back</Text>
          </Box>
        </Box>
      );
    }

    const items = [
      ...availableSecrets.map((s) => ({ label: s.name, value: s.name })),
      { label: "← Back", value: "back" },
    ];

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Select Secret to Configure
        </Text>
        <Box marginTop={1}>
          <SelectInput items={items} onSelect={handleSecretSelect} />
        </Box>
      </Box>
    );
  }

  if (step === "provider") {
    const items = [
      ...PROVIDER_OPTIONS,
      { label: "← Back", value: "back" },
    ];

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Select Provider for {selectedSecret}
        </Text>
        <Box marginTop={1}>
          <SelectInput items={items} onSelect={handleProviderSelect} />
        </Box>
      </Box>
    );
  }

  if (step === "schedule") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Rotation Schedule for {selectedSecret}
        </Text>
        <Box marginTop={1}>
          <Text>Rotate every </Text>
          <TextInput
            value={scheduleDays}
            onChange={setScheduleDays}
            onSubmit={handleScheduleSubmit}
          />
          <Text> days</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Enter to continue, Escape to go back</Text>
        </Box>
      </Box>
    );
  }

  if (step === "config") {
    let prompt = "";
    let currentValue = "";

    if (selectedProvider === "custom") {
      prompt = "Rotate command (outputs new secret value):";
      currentValue = (providerConfig as CustomConfig).rotateCommand || "";
    } else if (selectedProvider === "aws") {
      prompt = "AWS Access Key ID secret name:";
      currentValue = (providerConfig as AWSConfig).accessKeyIdName || "";
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Configure {selectedProvider} Provider
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{prompt}</Text>
          <TextInput
            value={currentValue}
            onChange={(value) => {
              if (selectedProvider === "custom") {
                setProviderConfig({ ...providerConfig, rotateCommand: value });
              } else if (selectedProvider === "aws") {
                setProviderConfig({ ...providerConfig, accessKeyIdName: value });
              }
            }}
            onSubmit={handleConfigSubmit}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Enter to continue, Escape to go back</Text>
        </Box>
      </Box>
    );
  }

  if (step === "confirm") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Confirm Configuration
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            Secret: <Text color="yellow">{selectedSecret}</Text>
          </Text>
          <Text>
            Provider: <Text color="yellow">{selectedProvider}</Text>
          </Text>
          <Text>
            Schedule: <Text color="yellow">Every {scheduleDays} days</Text>
          </Text>
          {selectedProvider === "custom" && (
            <Text>
              Command: <Text dimColor>{(providerConfig as CustomConfig).rotateCommand}</Text>
            </Text>
          )}
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "✓ Save Configuration", value: "save" },
              { label: "← Edit", value: "back" },
              { label: "✗ Cancel", value: "cancel" },
            ]}
            onSelect={handleConfirm}
          />
        </Box>
      </Box>
    );
  }

  return <Text>Unknown step</Text>;
}
