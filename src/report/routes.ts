import { Router } from "express";
import { z } from "zod";

import { authMiddleware } from "../auth/routes";
import { generateReport, toCSV } from "../services/report-service";

import type { Request, Response } from "express";

// Date string validation (YYYY-MM-DD)
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const reportQuerySchema = z.object({
  from: z.string().regex(dateRegex, "from must be YYYY-MM-DD").optional(),
  to: z.string().regex(dateRegex, "to must be YYYY-MM-DD").optional(),
  format: z.enum(["csv", "json"]).optional().default("csv"),
});

export function reportRoutes(): Router {
  const router = Router();

  /**
   * GET /api/report/settlement?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|json
   *
   * Generates a settlement report.
   * Defaults: today's date for both from/to, CSV format.
   */
  router.get(
    "/report/settlement",
    authMiddleware,
    async (req: Request, res: Response) => {
      try {
        const parsed = reportQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message:
                parsed.error.issues[0]?.message || "Invalid query parameters",
              details: parsed.error.issues.map((e) => ({
                field: e.path.join("."),
                message: e.message,
              })),
            },
          });
        }

        const today = new Date().toISOString().split("T")[0];
        const { from = today, to = today, format: fmt } = parsed.data;

        const report = await generateReport(from, to);

        if (fmt === "json") {
          return res.json({ success: true, data: report });
        }

        // CSV response
        const csv = toCSV(report);
        const filename = `settlement-report-${from}-to-${to}.csv`;

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        return res.send(csv);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error("[Report] Error generating report:", message);
        return res.status(500).json({
          success: false,
          error: {
            code: "REPORT_ERROR",
            message: "Failed to generate settlement report",
          },
        });
      }
    },
  );

  return router;
}
