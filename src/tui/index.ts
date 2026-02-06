import React from "react";
import { render } from "ink";
import { App } from "./App";
import { SecretDatabase } from "../database";
import { RotationManager } from "../rotation";

/**
 * Launch the Ink TUI for rotation management
 */
export async function launchTUI(db: SecretDatabase, password: string | null): Promise<void> {
  const manager = new RotationManager(db);

  // Clear terminal and reset state
  process.stdout.write('\x1b[2J\x1b[H'); // Clear screen and move cursor to top

  const { waitUntilExit } = render(
    React.createElement(App, { db, manager, password })
  );

  await waitUntilExit();
}

export { App } from "./App";
