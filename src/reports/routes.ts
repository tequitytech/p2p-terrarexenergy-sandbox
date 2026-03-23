import { Router } from "express";
import { generateSettlementReport, toCSV } from "../services/report-service";
import type { Request, Response } from "express";
import { format as formatDate } from "date-fns";
import { authMiddleware } from "../auth/routes";

export function reportRoutes(): Router {
    const router = Router();

    // GET /api/reports/eod-trades?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&format=csv|json
    router.get("/eod-trades", authMiddleware, async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            if (!user) {
                return res.status(401).json({ success: false, error: "Unauthorized" });
            }
            const startDateStr = req.query.startDate as string;
            const endDateStr = req.query.endDate as string;
            const format = (req.query.format as string || "json").toLowerCase();

            const today = formatDate(new Date(), "yyyy-MM-dd");
            const startStr = startDateStr || today;
            const endStr = endDateStr || today;

            const report = await generateSettlementReport(startStr, endStr);

            if (format === "csv") {
                const csv = toCSV(report);
                const filename = `eod-report-${startStr}-to-${endStr}.csv`;
                res.setHeader("Content-Type", "text/csv");
                res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
                return res.status(200).send(csv);
            }

            return res.status(200).json({
                success: true,
                ...report
            });

        } catch (error: any) {
            console.error("[API] Error generating EOD report:", error);
            return res.status(500).json({ success: false, error: "Failed to generate EOD report" });
        }
    });

    return router;
}
