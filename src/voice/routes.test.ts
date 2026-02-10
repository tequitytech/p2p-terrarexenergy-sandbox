import express from "express";
import request from "supertest";

import { classifyIntent } from "./intent-service";
import { ENTITY_TYPES } from "./entities";
import { voiceRoutes } from "./routes";

jest.mock("./intent-service");

const mockClassifyIntent = classifyIntent as jest.MockedFunction<
  typeof classifyIntent
>;

describe("Voice Routes — POST /api/voice/intent", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/voice", voiceRoutes());

    jest.clearAllMocks();
  });

  it("should return 400 when text field is missing", async () => {
    const res = await request(app).post("/api/voice/intent").send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 when text is empty string", async () => {
    const res = await request(app).post("/api/voice/intent").send({ text: "" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toBe("Text is required");
  });

  it("should return 400 when text exceeds 50 word limit", async () => {
    const longText = Array(51).fill("word").join(" ");
    const res = await request(app)
      .post("/api/voice/intent")
      .send({ text: longText });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toBe("Input text exceeds 50 word limit");
  });

  it("should return classified intent with confidence and entities", async () => {
    mockClassifyIntent.mockResolvedValue({
      intent: "buy_energy",
      confidence: 0.92,
      detected_language: "en",
      entities: [
        { name: "quantity", value: 100 },
        { name: "source_type", value: "solar" },
      ],
    });

    const res = await request(app)
      .post("/api/voice/intent")
      .send({ text: "buy 100 units of solar" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.intent).toBe("buy_energy");
    expect(res.body.data.confidence).toBe(0.92);
    expect(res.body.data.low_confidence).toBe(false);
    expect(res.body.data.detected_language).toBe("en");
    expect(res.body.data.entities.quantity).toEqual({
      value: 100,
      unit: "kWh",
    });
    expect(res.body.data.entities.source_type).toEqual({
      value: "solar",
      unit: "enum",
    });

    expect(mockClassifyIntent).toHaveBeenCalledWith("buy 100 units of solar");
  });

  it("should set low_confidence=true when confidence < 0.5", async () => {
    mockClassifyIntent.mockResolvedValue({
      intent: "off_topic",
      confidence: 0.3,
      detected_language: "en",
      entities: [],
    });

    const res = await request(app)
      .post("/api/voice/intent")
      .send({ text: "hello world" });

    expect(res.status).toBe(200);
    expect(res.body.data.low_confidence).toBe(true);
    expect(res.body.data.confidence).toBe(0.3);
  });

  it("should return 503 when LLM service throws", async () => {
    mockClassifyIntent.mockRejectedValue(new Error("OpenAI API rate limited"));

    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await request(app)
      .post("/api/voice/intent")
      .send({ text: "buy solar energy" });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("LLM_SERVICE_UNAVAILABLE");
    expect(res.body.error.message).toBe(
      "Intent classification service temporarily unavailable"
    );

    consoleSpy.mockRestore();
  });

  it("should map entity names to ENTITY_TYPES units", async () => {
    mockClassifyIntent.mockResolvedValue({
      intent: "sell_energy",
      confidence: 0.95,
      detected_language: "hi",
      entities: [
        { name: "quantity", value: 50 },
        { name: "price", value: 5 },
        { name: "time_window", value: "2026-02-09T15:00:00.000+05:30" },
        { name: "meter_id", value: "41434064" },
        { name: "source_type", value: "solar" },
      ],
    });

    const res = await request(app)
      .post("/api/voice/intent")
      .send({ text: "mujhe 50 unit 5 rupees mein bechna hai" });

    expect(res.status).toBe(200);

    const { entities } = res.body.data;
    expect(entities.quantity).toEqual({ value: 50, unit: "kWh" });
    expect(entities.price).toEqual({ value: 5, unit: "INR/kWh" });
    expect(entities.time_window).toEqual({
      value: "2026-02-09T15:00:00.000+05:30",
      unit: "ISO8601",
    });
    expect(entities.meter_id).toEqual({ value: "41434064", unit: "mRID" });
    expect(entities.source_type).toEqual({ value: "solar", unit: "enum" });

    // Verify each unit matches ENTITY_TYPES
    expect(entities.quantity.unit).toBe(ENTITY_TYPES.quantity.unit);
    expect(entities.price.unit).toBe(ENTITY_TYPES.price.unit);
    expect(entities.time_window.unit).toBe(ENTITY_TYPES.time_window.unit);
    expect(entities.meter_id.unit).toBe(ENTITY_TYPES.meter_id.unit);
    expect(entities.source_type.unit).toBe(ENTITY_TYPES.source_type.unit);
  });
});
