import { vi } from "vitest";

export type TableBuilder = () => unknown;
export type TableMap = Record<string, TableBuilder>;

export function createFromTableMap(tableMap: TableMap) {
  return vi.fn((table: string) => {
    const builder = tableMap[table];
    if (!builder) {
      throw new Error(`Unexpected table ${table}`);
    }
    return builder();
  });
}
