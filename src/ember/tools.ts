// Ember's tools as Claude sees them. The device runs every one of them (Ember's EmberToolbox on
// iPhone, WatchBrain on Apple Watch) and sends back only what the tool concluded, already
// de-identified. The client names the tools it will run; the schemas live here, so a client can
// never invent a tool. Keep in step with Ember/Services/Brain/EmberTools.swift.

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
  household_facts: {
    name: 'household_facts',
    description: "Apple Watch only: the day's meals, grocery and budget figures and reading, as the iPhone last shared them.",
    input_schema: { ...none, properties: {}, required: [] },
  },
};

export const EMBER_TOOL_NAMES = Object.keys(EMBER_TOOLS) as [string, ...string[]];
