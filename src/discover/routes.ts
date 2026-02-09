import axios, { isAxiosError } from "axios";
import { Router } from "express";
import z from "zod";

import { buildDiscoverRequest } from "../bidding/services/market-analyzer";
import { SourceType } from "../types";

import type { Request, Response} from "express";

const discoverSchema = z.object({
  sourceType: z.enum(SourceType).default(SourceType.SOLAR),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  minQty: z.coerce.number().optional(),
  maxQty: z.coerce.number().optional(),
  sortBy: z.enum(["price", "energy"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  itemId: z.string().optional(),
  isActive: z.enum(["true", "false"]).transform((val) => val === "true").default(true),
  tag: z.enum(['farmer']).optional(),
});

export const discoverRoutes = () => {
  const router = Router();

  router.get("/discover", async (req: Request, res: Response) => {
    const discoverUrl = `https://p2p.terrarexenergy.com/bap/caller/discover`;
    const query = discoverSchema.parse(req.query);

    try {
      const request = buildDiscoverRequest(query);

      const response = await axios.post(discoverUrl, request, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000, // 15 second timeout
      });

      const data = response.data;

      // Apply date filter & sort
      if (data?.message?.catalogs) {
        const catalogs = data.message.catalogs;

        // 2. Sort
        if (query.sortBy) {
          const sortOrder = query.order === "desc" ? -1 : 1;

          // 1. Sort Offers within each Catalog
          catalogs.forEach((catalog: any) => {
            if (catalog["beckn:offers"]) {
              catalog["beckn:offers"].sort((a: any, b: any) => {
                let valA = 0;
                let valB = 0;

                if (query.sortBy === "price") {
                  valA = Number(
                    a["beckn:price"]?.["schema:price"] ||
                    a["beckn:offerAttributes"]?.["beckn:price"]?.value ||
                    Number.MAX_VALUE
                  );
                  valB = Number(
                    b["beckn:price"]?.["schema:price"] ||
                    b["beckn:offerAttributes"]?.["beckn:price"]?.value ||
                    Number.MAX_VALUE
                  );
                } else if (query.sortBy === "energy") {
                  valA = Number(
                    a["beckn:offerAttributes"]?.maximumQuantity || 
                    a["beckn:offerAttributes"]?.["beckn:maxQuantity"]?.unitQuantity ||
                    0
                  );
                  valB = Number(
                    b["beckn:offerAttributes"]?.maximumQuantity || 
                    b["beckn:offerAttributes"]?.["beckn:maxQuantity"]?.unitQuantity ||
                    0
                  );
                }
                return (valA - valB) * sortOrder;
              });
            }
          });

          // 2. Sort Catalogs (by their best offer)
          catalogs.sort((a: any, b: any) => {
             const getBestValue = (cat: any) => {
               const offers = cat["beckn:offers"];
               if (!offers || offers.length === 0) return query.sortBy === "price" ? Number.MAX_VALUE : 0;
               // Offers are already sorted, so [0] is the "best" (min price or min energy?)
               // Wait, for energy we might want max? 
               // Standard logic: Sort is usually ascending for price.
               // If functionality requires descending for energy (max quantity), strictly following 'asc/desc' param is safer. 
               // Assuming [0] is the one that comes first based on current sort order.
               
               const best = offers[0]; 
                if (query.sortBy === "price") {
                  return Number(
                    best["beckn:price"]?.["schema:price"] ||
                    best["beckn:offerAttributes"]?.["beckn:price"]?.value ||
                    Number.MAX_VALUE
                  );
                } else if (query.sortBy === "energy") {
                   return Number(
                    best["beckn:offerAttributes"]?.maximumQuantity || 
                    best["beckn:offerAttributes"]?.["beckn:maxQuantity"]?.unitQuantity ||
                    0
                  );
                }
                return 0;
             };

             const valA = getBestValue(a);
             const valB = getBestValue(b);
             return (valA - valB) * sortOrder;
          });
        }

        if(query.tag === 'farmer') {
          catalogs.forEach((catalog:any) => {
            catalog["beckn:items"] = catalog["beckn:items"].filter((item:any) => item["beckn:provider"]?.["beckn:descriptor"]?.["schema:name"] === 'Suresh - BRPL Prosumer');
          })
        }
        
        data.message.catalogs = catalogs.filter((p:any) => p["beckn:items"].length > 0);
      }

      return res.status(200).json({
        success: true,
        data: data
      });
    } catch (error: any) {
      console.log(`[DiscoverService] CDS fetch failed: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: isAxiosError(error) ? error.response?.data : error.message,
      });
    }
  });

  return router;
};
