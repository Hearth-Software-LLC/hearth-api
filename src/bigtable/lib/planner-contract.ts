export const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export const SLOTS = ["breakfast", "lunch", "dinner"] as const;

export type DayOfWeek = (typeof DAYS)[number];
export type MealSlotType = (typeof SLOTS)[number];
