import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { INTENTS } from "./intents";
import { ENTITY_TYPES } from "./entities";

// Schema for time_window entity value
const timeWindowValueSchema = z.object({
  start: z.string(),
  end: z.string(),
});

const classificationSchema = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  detected_language: z.enum(["en", "hi", "hinglish"]),
  entities: z.array(
    z.object({
      name: z.string(),
      value: z.union([z.string(), timeWindowValueSchema]),
      type: z.string(),
    }),
  ),
});

function buildPrompt(text: string) {
  // Current time reference for relative date conversion
  const now = new Date();
  const currentTimestamp = now.toISOString();

  const intentList = INTENTS.map((i) => {
    const examples = i.examples?.length
      ? `\n    Examples: ${i.examples.map((e) => `"${e}"`).join(", ")}`
      : "";
    return `  - ${i.name}: ${i.description}${examples}`;
  }).join("\n");

  const entityList = Object.entries(ENTITY_TYPES)
    .map(([name, e]: [string, any]) => {
      const extra = e.values ? ` (values: ${e.values.join(", ")})` : "";
      return `  - ${name}: ${e.description}${extra}`;
    })
    .join("\n");

  return `You are an intent classifier for a P2P energy trading app.

CURRENT TIME: ${currentTimestamp} (Use this as reference for relative dates)
TIMEZONE: IST (UTC+5:30) - Indian Standard Time

INTENTS (choose exactly one):
${intentList}

ENTITIES (extract if present):
${entityList}

RULES:
1. Return the single best matching intent
2. Set confidence 0-1 based on how well the input matches
3. Detect language: "en" (English), "hi" (Hindi/Devanagari), "hinglish" (romanized Hindi or mix)
4. Extract and normalize entities to typed values (e.g., "fifty" → 50)
5. If input is unrelated to energy trading, use "off_topic"

TIME WINDOW RULES (CRITICAL):
- ALWAYS convert relative dates to actual ISO 8601 timestamps
- "today" → current date
- "tomorrow" → next day's date
- "day after tomorrow" → date + 2 days
- "kal" (Hindi for tomorrow) → next day's date
- "parso" (Hindi for day after tomorrow) → date + 2 days
- Time like "3PM", "3 baje", "15:00" → actual hour in 24h format
- Return time_window as object with "start" and "end" ISO strings
- If only one time given (e.g., "3PM"), assume 1-hour window (3PM to 4PM)
- If no date given but time given, assume tomorrow
- All times should be converted to UTC (IST is UTC+5:30)
- "subah" (morning) typically means 6AM-10AM, use 10AM if unspecified
- "dopahar" (afternoon) typically means 12PM-4PM, use 2PM if unspecified
- "shaam" (evening) typically means 5PM-8PM, use 6PM if unspecified

Example time_window outputs:
- Input "tomorrow 3PM" with current time 2026-02-03T10:00:00Z → { "start": "2026-02-04T09:30:00.000Z", "end": "2026-02-04T10:30:00.000Z" }
- Input "kal subah 10 baje" → { "start": "2026-02-04T04:30:00.000Z", "end": "2026-02-04T05:30:00.000Z" }
- Input "today 5PM to 7PM" with current date 2026-02-03 → { "start": "2026-02-03T11:30:00.000Z", "end": "2026-02-03T13:30:00.000Z" }

USER INPUT: "${text}"`;
}

export async function classifyIntent(text: string) {
  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: classificationSchema,
    prompt: buildPrompt(text),
  });
  return object;
}
