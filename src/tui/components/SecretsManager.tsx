import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { SecretMetadata } from "../../types";

interface SecretsManagerProps {
  secrets: SecretMetadata[];
  onAddSecret: (name: string, value: string, description?: string) => Promise<void>;
  onDeleteSecret: (name: string) => Promise<void>;
  onGetSecret: (name: string) => Promise<string>;
  onBack: () => void;
}

type Screen = "list" | "add" | "view" | "delete-confirm";

export function SecretsManager({
  secrets,
  onAddSecret,
  onDeleteSecret,
  onGetSecret,
  onBack,
}: SecretsManagerProps): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("list");
  const [selectedSecret, setSelectedSecret] = useState<string | null>(null);
  const [secretValue, setSecretValue] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null);

  // Add secret form state
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [addStep, setAddStep] = useState<"name" | "value" | "description" | "confirm">("name");

  useInput((input, key) => {
    if (key.escape) {
      if (screen === "list") {
        onBack();
      } else {
        setScreen("list");
        setSelectedSecret(null);
        setSecretValue(null);
        setMessage(null);
        setNewName("");
        setNewValue("");
        setNewDescription("");
        setAddStep("name");
      }
    }
  });

  const handleSelect = async (item: { value: string }) => {
    if (item.value === "__back__") {
      onBack();
      return;
    }
    if (item.value === "__add__") {
      setScreen("add");
      setAddStep("name");
      return;
    }

    // Selected a secret
    setSelectedSecret(item.value);
    setIsLoading(true);
    try {
      const value = await onGetSecret(item.value);
      setSecretValue(value);
      setScreen("view");
    } catch (error) {
      setMessage({ text: `Error: ${error}`, color: "red" });
    }
    setIsLoading(false);
  };

  const handleAddSubmit = async () => {
    if (addStep === "name") {
      if (newName.trim()) {
        setAddStep("value");
      }
      return;
    }
    if (addStep === "value") {
      if (newValue.trim()) {
        setAddStep("description");
      }
      return;
    }
    if (addStep === "description") {
      setAddStep("confirm");
      return;
    }
    if (addStep === "confirm") {
      setIsLoading(true);
      try {
        await onAddSecret(newName.trim(), newValue, newDescription.trim() || undefined);
        setMessage({ text: `Secret '${newName}' added successfully!`, color: "green" });
        setNewName("");
        setNewValue("");
        setNewDescription("");
        setAddStep("name");
        setScreen("list");
      } catch (error) {
        setMessage({ text: `Error: ${error}`, color: "red" });
      }
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedSecret) return;
    setIsLoading(true);
    try {
      await onDeleteSecret(selectedSecret);
      setMessage({ text: `Secret '${selectedSecret}' deleted.`, color: "green" });
      setSelectedSecret(null);
      setSecretValue(null);
      setScreen("list");
    } catch (error) {
      setMessage({ text: `Error: ${error}`, color: "red" });
    }
    setIsLoading(false);
  };

  // Loading state
  if (isLoading) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text color="green">
            <Spinner type="dots" />
          </Text>
          <Text> Processing...</Text>
        </Box>
      </Box>
    );
  }

  // Add secret screen
  if (screen === "add") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Add New Secret
        </Text>

        <Box marginTop={1} flexDirection="column">
          {addStep === "name" && (
            <>
              <Text>Secret name:</Text>
              <TextInput
                value={newName}
                onChange={setNewName}
                onSubmit={handleAddSubmit}
                placeholder="e.g., OPENAI_API_KEY"
              />
            </>
          )}

          {addStep === "value" && (
            <>
              <Text>
                Name: <Text color="yellow">{newName}</Text>
              </Text>
              <Text>Secret value:</Text>
              <TextInput
                value={newValue}
                onChange={setNewValue}
                onSubmit={handleAddSubmit}
                mask="*"
              />
            </>
          )}

          {addStep === "description" && (
            <>
              <Text>
                Name: <Text color="yellow">{newName}</Text>
              </Text>
              <Text>Description (optional, press Enter to skip):</Text>
              <TextInput
                value={newDescription}
                onChange={setNewDescription}
                onSubmit={handleAddSubmit}
                placeholder="e.g., Production API key"
              />
            </>
          )}

          {addStep === "confirm" && (
            <>
              <Text>
                Name: <Text color="yellow">{newName}</Text>
              </Text>
              <Text>
                Value: <Text dimColor>{"*".repeat(Math.min(newValue.length, 20))}</Text>
              </Text>
              {newDescription && (
                <Text>
                  Description: <Text dimColor>{newDescription}</Text>
                </Text>
              )}
              <Box marginTop={1}>
                <SelectInput
                  items={[
                    { label: "✓ Save Secret", value: "save" },
                    { label: "✗ Cancel", value: "cancel" },
                  ]}
                  onSelect={(item) => {
                    if (item.value === "save") {
                      handleAddSubmit();
                    } else {
                      setScreen("list");
                      setNewName("");
                      setNewValue("");
                      setNewDescription("");
                      setAddStep("name");
                    }
                  }}
                />
              </Box>
            </>
          )}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>Press Escape to cancel</Text>
        </Box>
      </Box>
    );
  }

  // View secret screen
  if (screen === "view" && selectedSecret) {
    const secretMeta = secrets.find((s) => s.name === selectedSecret);
    const isSensitive = secretMeta?.sensitive !== false;

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {isSensitive ? "🔒" : "📝"} {selectedSecret}
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text>
            Type: <Text color={isSensitive ? "yellow" : "cyan"}>{isSensitive ? "Secret (sensitive)" : "Credential (visible)"}</Text>
          </Text>
          <Text>
            Value: <Text color="yellow">{secretValue}</Text>
          </Text>
          {secretMeta?.description && (
            <Text>
              Description: <Text dimColor>{secretMeta.description}</Text>
            </Text>
          )}
          <Text>
            Created: <Text dimColor>{secretMeta?.createdAt.split("T")[0]}</Text>
          </Text>
          <Text>
            Updated: <Text dimColor>{secretMeta?.updatedAt.split("T")[0]}</Text>
          </Text>
        </Box>

        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "🗑️  Delete Secret", value: "delete" },
              { label: "← Back to List", value: "back" },
            ]}
            onSelect={(item) => {
              if (item.value === "delete") {
                setScreen("delete-confirm");
              } else {
                setScreen("list");
                setSelectedSecret(null);
                setSecretValue(null);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // Delete confirmation
  if (screen === "delete-confirm" && selectedSecret) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">
          Delete Secret?
        </Text>
        <Box marginTop={1}>
          <Text>
            Are you sure you want to delete <Text color="yellow">{selectedSecret}</Text>?
          </Text>
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "✗ Cancel", value: "cancel" },
              { label: "🗑️  Yes, Delete", value: "delete" },
            ]}
            onSelect={(item) => {
              if (item.value === "delete") {
                handleDelete();
              } else {
                setScreen("view");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // List screen (default)
  const items = [
    { label: "➕ Add New Secret", value: "__add__" },
    ...secrets.map((s) => ({
      label: `${s.sensitive ? "🔒" : "📝"} ${s.name}${s.description ? ` - ${s.description.substring(0, 30)}` : ""}`,
      value: s.name,
    })),
    { label: "← Back", value: "__back__" },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Secrets Manager
      </Text>

      {message && (
        <Box marginY={1}>
          <Text color={message.color as any}>{message.text}</Text>
        </Box>
      )}

      {secrets.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>No secrets stored yet.</Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "➕ Add New Secret", value: "add" },
                { label: "← Back", value: "back" },
              ]}
              onSelect={(item) => {
                if (item.value === "add") {
                  setScreen("add");
                  setAddStep("name");
                } else {
                  onBack();
                }
              }}
            />
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <SelectInput items={items} onSelect={handleSelect} />
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {secrets.length} entries (🔒 secret | 📝 credential) • Select to view • Press Escape to go back
        </Text>
      </Box>
    </Box>
  );
}
