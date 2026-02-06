import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";

export interface MenuItem {
  label: string;
  value: string;
}

interface MenuProps {
  items: MenuItem[];
  onSelect: (item: MenuItem) => void;
  title?: string;
}

export function Menu({ items, onSelect, title }: MenuProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      {title && (
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {title}
          </Text>
        </Box>
      )}
      <SelectInput
        items={items}
        onSelect={onSelect}
        indicatorComponent={({ isSelected }) => (
          <Text color={isSelected ? "green" : undefined}>
            {isSelected ? "❯ " : "  "}
          </Text>
        )}
        itemComponent={({ isSelected, label }) => (
          <Text color={isSelected ? "green" : undefined} bold={isSelected}>
            {label}
          </Text>
        )}
      />
    </Box>
  );
}
