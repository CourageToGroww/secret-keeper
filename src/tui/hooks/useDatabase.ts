import { useState, useCallback } from "react";
import { SecretDatabase } from "../../database";
import { RotationManager } from "../../rotation";
import {
  RotationConfig,
  RotationHistoryEntry,
  SecretMetadata,
  RotationResult,
  AuditEntry,
  ProviderType,
  ProviderConfig,
} from "../../types";

export interface DatabaseState {
  secrets: SecretMetadata[];
  rotationConfigs: RotationConfig[];
  rotationHistory: RotationHistoryEntry[];
  auditLog: AuditEntry[];
  isUnlocked: boolean;
  vaultPath: string;
  isLocal: boolean;
  secretCount: number;
}

export interface DatabaseActions {
  refresh: () => void;

  // Secret operations
  addSecret: (name: string, value: string, description?: string) => Promise<void>;
  addSecretEntry: (name: string, value: string, sensitive: boolean) => Promise<void>;
  deleteSecret: (name: string) => Promise<void>;
  getSecret: (name: string) => Promise<string>;
  getAllSecrets: () => Promise<Record<string, string>>;
  importFromEnv: (content: string, secretsOnly?: boolean) => Promise<[number, string[], string[]]>;
  
  // Rotation operations
  rotateNow: (secretName: string) => Promise<RotationResult>;
  enableRotation: (secretName: string) => void;
  disableRotation: (secretName: string) => void;
  deleteRotationConfig: (secretName: string) => void;
  testRotation: (secretName: string) => Promise<{ success: boolean; error?: string }>;
  configureRotation: (
    secretName: string,
    providerType: ProviderType,
    scheduleDays: number,
    providerConfig: ProviderConfig
  ) => Promise<void>;
  
  // Vault operations
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

export function useDatabase(
  db: SecretDatabase,
  manager: RotationManager
): [DatabaseState, DatabaseActions] {
  const [state, setState] = useState<DatabaseState>(() => ({
    secrets: db.listSecrets(),
    rotationConfigs: manager.listRotationConfigs(),
    rotationHistory: manager.getHistory(undefined, 50),
    auditLog: db.getAuditLog(50),
    isUnlocked: db.isUnlocked(),
    vaultPath: db.getPath(),
    isLocal: db.isLocal(),
    secretCount: db.getSecretCount(),
  }));

  const refresh = useCallback(() => {
    setState({
      secrets: db.listSecrets(),
      rotationConfigs: manager.listRotationConfigs(),
      rotationHistory: manager.getHistory(undefined, 50),
      auditLog: db.getAuditLog(50),
      isUnlocked: db.isUnlocked(),
      vaultPath: db.getPath(),
      isLocal: db.isLocal(),
      secretCount: db.getSecretCount(),
    });
  }, [db, manager]);

  // Secret operations
  const addSecret = useCallback(
    async (name: string, value: string, description?: string): Promise<void> => {
      await db.addSecret(name, value, { description });
      refresh();
    },
    [db, refresh]
  );

  const addSecretEntry = useCallback(
    async (name: string, value: string, sensitive: boolean): Promise<void> => {
      await db.addSecret(name, value, { sensitive });
      refresh();
    },
    [db, refresh]
  );

  const deleteSecret = useCallback(
    async (name: string): Promise<void> => {
      await db.deleteSecret(name);
      refresh();
    },
    [db, refresh]
  );

  const getSecret = useCallback(
    async (name: string): Promise<string> => {
      return db.getSecret(name);
    },
    [db]
  );

  const getAllSecrets = useCallback(
    async (): Promise<Record<string, string>> => {
      return db.getAllSecrets();
    },
    [db]
  );

  const importFromEnv = useCallback(
    async (content: string, secretsOnly: boolean = true): Promise<[number, string[], string[]]> => {
      const result = await db.importFromEnv(content, { secretsOnly });
      refresh();
      return result;
    },
    [db, refresh]
  );

  // Rotation operations
  const rotateNow = useCallback(
    async (secretName: string): Promise<RotationResult> => {
      const result = await manager.rotateNow(secretName);
      refresh();
      return result;
    },
    [manager, refresh]
  );

  const enableRotation = useCallback(
    (secretName: string) => {
      manager.enableRotation(secretName);
      refresh();
    },
    [manager, refresh]
  );

  const disableRotation = useCallback(
    (secretName: string) => {
      manager.disableRotation(secretName);
      refresh();
    },
    [manager, refresh]
  );

  const deleteRotationConfig = useCallback(
    (secretName: string) => {
      manager.deleteRotationConfig(secretName);
      refresh();
    },
    [manager, refresh]
  );

  const testRotation = useCallback(
    async (secretName: string): Promise<{ success: boolean; error?: string }> => {
      return manager.testRotation(secretName);
    },
    [manager]
  );

  const configureRotation = useCallback(
    async (
      secretName: string,
      providerType: ProviderType,
      scheduleDays: number,
      providerConfig: ProviderConfig
    ): Promise<void> => {
      await manager.configureRotation(secretName, providerType, scheduleDays, providerConfig);
      refresh();
    },
    [manager, refresh]
  );

  // Vault operations
  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<void> => {
      await db.changePassword(currentPassword, newPassword);
      refresh();
    },
    [db, refresh]
  );

  const actions: DatabaseActions = {
    refresh,
    addSecret,
    addSecretEntry,
    deleteSecret,
    getSecret,
    getAllSecrets,
    importFromEnv,
    rotateNow,
    enableRotation,
    disableRotation,
    deleteRotationConfig,
    testRotation,
    configureRotation,
    changePassword,
  };

  return [state, actions];
}
