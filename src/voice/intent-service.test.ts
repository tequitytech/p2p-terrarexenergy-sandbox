import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { classifyIntent } from "./intent-service";

jest.mock("ai", () => ({
  generateObject: jest.fn(),
}));

jest.mock("@ai-sdk/openai", () => ({
  openai: jest.fn(() => "mock-model"),
}));

const mockedGenerateObject = generateObject as jest.Mock;

describe("voice/intent-service", () => {
  it("should call LLM with correct schema and return classified object", async () => {
    const fakeObject = {
      intent: "buy_energy",
      confidence: 0.9,
      detected_language: "en",
      entities: [{ name: "quantity", value: 10 }],
    };

    mockedGenerateObject.mockResolvedValue({ object: fakeObject });

    const text = "I want to buy 10 units";
    const result = await classifyIntent(text);

    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
    const call = mockedGenerateObject.mock.calls[0][0];

    expect(call.model).toBe("mock-model");
    expect(call.schema).toBeDefined();
    expect(typeof call.prompt).toBe("string");
    expect(call.prompt).toContain("INTENTS (choose exactly one):");
    expect(call.prompt).toContain(text);

    expect(result).toEqual(fakeObject);
  });
});

