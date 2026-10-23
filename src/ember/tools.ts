// Ember's tools as Claude sees them. The device runs every one of them (EmberToolbox on iPhone,
// WatchBrain on Apple Watch) and sends back only what the tool concluded, already de-identified.
//
// The device sends each tool's definition with the turn (one description of each tool, kept with
// the code that runs it: Ember/Services/Brain/EmberToolbox.swift). This file holds the allowlist
// of names a device may offer, checked on every turn, so a client can never invent a tool, and
// fallback definitions for devices that send names only.

const days = ['today', 'tomorrow', 'this week', 'next week', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export type EmberTool = {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
};

const none = { type: 'object', properties: {}, required: [] } as const;

export const EMBER_TOOLS: Record<string, EmberTool> = {
  household_people: {
    name: 'household_people',
    description: 'Lists who is in the household as tokens ([P1], [P2]) with roles and ages, and who is asking.',
    input_schema: { ...none, properties: {}, required: [] },
  },
  meals_planned: {
    name: 'meals_planned',
    description: "Gets what BigTable has planned for breakfast, lunch or dinner on a day or a week, and who isn't eating.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'string', enum: days, description: 'Which days. Use "today" for tonight.' },
        meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'all'] },
      },
      required: ['days', 'meal'],
    },
  },
  meal_fits_household: {
    name: 'meal_fits_household',
    description: "Checks on the device whether a planned meal fits everyone's food allergies. Returns only yes or no.",
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: days },
        meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'] },
      },
      required: ['day', 'meal'],
    },
  },
  meal_times: {
    name: 'meal_times',
    description: 'Gets when the family eats breakfast, lunch and dinner.',
    input_schema: { ...none, properties: {}, required: [] },
  },
  grocery_status: {
    name: 'grocery_status',
    description: "Gets how many things are left on BigTable's grocery list and what the list should cost.",
    input_schema: { ...none, properties: {}, required: [] },
  },
  budget_status: {
    name: 'budget_status',
    description: "Gets this month's grocery budget from Suffice: left, spent and planned.",
    input_schema: { ...none, properties: {}, required: [] },
  },
  allowance_recent: {
    name: 'allowance_recent',
    description: 'Gets the allowance Caloma paid each kid in the last 30 days.',
    input_schema: { ...none, properties: {}, required: [] },
  },
  study_today: {
    name: 'study_today',
    description: "Gets today's scripture reading from Hearken and whether it's done.",
    input_schema: { ...none, properties: {}, required: [] },
  },
  open_app: {
    name: 'open_app',
    description: "Adds a button that opens the right Hearth app to change something there. Ember can't change other apps' data itself.",
    input_schema: {
      type: 'object',
      properties: {
        place: { type: 'string', enum: ['grocery_list', 'meal_plan', 'budget', 'chores', 'calendar', 'reading', 'food_log'] },
      },
      required: ['place'],
    },
  },
  message_draft: {
    name: 'message_draft',
    description: 'Drafts a text message the person sends themselves from Messages, after picking who it goes to.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: "The message, in the person's own voice" } },
      required: ['text'],
    },
  },
  place_call: {
    name: 'place_call',
    description: "Calls a person from the device's Contacts or a business from Apple Maps, using where they are (a named town means the nearest town by that name). With one match the device opens its call screen and they tap Call; with several it lists them so you can ask which. Numbers never come back here.",
    input_schema: {
      type: 'object',
      properties: {
        who: { type: 'string', description: 'Who to call: a person or a business, as they said it' },
        near: { type: 'string', description: 'The town or area they named, or an empty string' },
        which: { type: 'string', description: 'Only after Ember asked which of several: their answer, like a street or "the closest". Otherwise an empty string' },
      },
      required: ['who', 'near'],
    },
  },
  household_facts: {
    name: 'household_facts',
    description: "Apple Watch only: the day's meals, grocery and budget figures and reading, as the iPhone last shared them.",
    input_schema: { ...none, properties: {}, required: [] },
  },
};

/** Every tool a device may offer. A name not here is refused (400). */
export const EMBER_TOOL_NAMES = [
  ...Object.keys(EMBER_TOOLS),
  // General
  'remember', 'forget',
  // Money (Suffice)
  'spending', 'budgets', 'bills', 'purchases', 'log_spending', 'mark_bill_paid',
  // Meals (BigTable)
  'grocery_list', 'add_groceries', 'check_off_groceries',
  // Family (Caloma)
  'chores', 'chores_waiting', 'approve_chores', 'mark_chore_done', 'family_calendar', 'add_family_event',
  // Food (Sated)
  'food_log', 'log_food',
  // Phone
  'send_text', 'draft_email', 'add_reminder', 'set_timer', 'set_alarm', 'my_calendar', 'add_my_event', 'directions',
  // Places (Apple Maps, on the device)
  'find_places',
].filter((name, index, all) => all.indexOf(name) === index) as [string, ...string[]];

/** The most tools one turn may offer. */
export const MAX_TOOLS = 48;
