import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { INTENTS } from "./intents";
import { ENTITY_TYPES } from "./entities";

const classificationSchema = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  detected_language: z.enum(["en", "hi", "hinglish"]),
  entities: z.array(
    z.object({
      name: z.string(),
      value: z.union([z.string(), z.number()]),
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
4. Extract entities with typed values (numbers as numbers, strings as strings)
5. If input is unrelated to energy trading, use "off_topic"

SELL vs AUTO_BID RULE (CRITICAL):
- Use "sell_energy" ONLY if user explicitly mentions a quantity/units (e.g., "sell 50 units", "50 kWh bechna hai")
- If user wants to sell but does NOT mention quantity, use "auto_bid" instead
- Examples:
  - "sell 50 units tomorrow" → sell_energy (has quantity)
  - "I want to sell energy" → auto_bid (no quantity)
  - "bijli bechni hai" → auto_bid (no quantity)
  - "sell my solar power" → auto_bid (no quantity)
  - "mujhe 100 unit bechna hai" → sell_energy (has quantity)

ENTITY VALUE RULES (CRITICAL):
- Return ONLY the raw value, NEVER include units in the value
- quantity: Return as NUMBER (e.g., "fifty units" → 50, "100 kWh" → 100)
- price: Return as NUMBER (e.g., "5 rupees" → 5, "₹3.50" → 3.5)
- time_window: Return as SINGLE ISO 8601 timestamp string (the start time only, NOT an object)
- meter_id: Return as STRING (just the ID)
- source_type: Return as STRING (one of: solar, wind, battery, grid)

TIME WINDOW RULES:
- ALWAYS convert relative dates to actual ISO 8601 timestamps
- "today" → current date
- "tomorrow" → next day's date
- "day after tomorrow" → date + 2 days
- "kal" (Hindi for tomorrow) → next day's date
- "parso" (Hindi for day after tomorrow) → date + 2 days
- Time like "3PM", "3 baje", "15:00" → actual hour in 24h format
- Return time_window as SINGLE string timestamp (the start time)
- If no date given but time given, assume tomorrow
- Return all times in IST with +05:30 offset (NOT UTC)
- "subah" (morning) → 10:00
- "dopahar" (afternoon) → 14:00
- "shaam" (evening) → 18:00

Entity examples:
- "50 units" → { name: "quantity", value: 50 }
- "₹5 per kWh" → { name: "price", value: 5 }
- "tomorrow 3PM" (current date 2026-02-03) → { name: "time_window", value: "2026-02-04T15:00:00.000+05:30" }
- "kal subah 10 baje" → { name: "time_window", value: "2026-02-04T10:00:00.000+05:30" }
- "meter 41434064" → { name: "meter_id", value: "41434064" }
- "solar power" → { name: "source_type", value: "solar" }

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
