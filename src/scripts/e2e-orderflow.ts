import axios, { isAxiosError } from "axios";
import { MongoClient } from "mongodb";
import dotenv from "dotenv"
dotenv.config();

const MONGO_URI =
  process.env.MONGO_URI_UAT;
if (!MONGO_URI) {
  throw new Error("Provide Mongodb URI");
}
const MONGO_DB = process.env.MONDO_DB ?? "p2p_trading";

const createContext = (
  action: string,
  transactionId: string,
  {
    bppId,
    bppUri,
    location,
  }: {
    bppId?: string;
    bppUri?: string;
    location?: {
      city: {
        code: string;
        name: string;
      };
      country: {
        code: string;
        name: string;
      };
    };
  } = {},
) => {
  return {
    version: "2.0.0",
    action: action,
    message_id: "82d6264d-a296-48e8-b9f8-66c009ba1f0f",
    bap_id: "p2p.terrarexenergy.com",
    bap_uri: "https://p2p.terrarexenergy.com/bap/receiver",
    bpp_id: bppId || "p2p.terrarexenergy.com",
    bpp_uri: bppUri || "https://p2p.terrarexenergy.com/bpp/receiver",
    ttl: "PT30S",
    domain: "beckn.one:deg:p2p-trading:2.0.0",
    timestamp: new Date().toISOString(),
    transaction_id: transactionId,
    location,
  };
};

const publishEnergy = async ({
  itemId,
  offerId,
}: {
  itemId: string;
  offerId: string;
}) => {
  const data = {
    context: createContext("catalog_publish", crypto.randomUUID()),
    message: {
      catalogs: [
        {
          "@context":
            "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
          "@type": "beckn:Catalog",
          "beckn:id": "terrarex-solar-catalog-002",
          "beckn:descriptor": {
            "@type": "beckn:Descriptor",
            "schema:name": "My Solar Energy Trading Catalog",
          },
          "beckn:bppId": "p2p.terrarexenergy.com",
          "beckn:bppUri": "https://p2p.terrarexenergy.com/bpp/receiver",
          "beckn:items": [
            {
              "@context":
                "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
              "@type": "beckn:Item",
              "beckn:id": itemId,
              "beckn:descriptor": {
                "@type": "beckn:Descriptor",
                "schema:name": "Solar Energy - 30.5 kWh",
                "beckn:shortDesc": "Carbon Offset Certified Solar Energy",
                "beckn:longDesc":
                  "High-quality solar energy from verified source with carbon offset certification",
              },
              "beckn:provider": {
                "beckn:id": "terrarex-provider-001",
                "beckn:descriptor": {
                  "@type": "beckn:Descriptor",
                  "schema:name": "Solar Farm 001",
                },
              },
              "beckn:itemAttributes": {
                "@context":
                  "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyResource/v0.2/context.jsonld",
                "@type": "EnergyResource",
                sourceType: "SOLAR",
                deliveryMode: "GRID_INJECTION",
                certificationStatus: "Carbon Offset Certified",
                meterId: "der://meter/100200300",
                availableQuantity: 10.5,
                productionWindow: [
                  {
                    "@type": "beckn:TimePeriod",
                    "schema:startTime": new Date().toISOString(),
                    "schema:endTime": new Date(
                      Date.now() + 60 * 60 * 1000,
                    ).toISOString(), // 1 hour
                  },
                ],
                sourceVerification: {
                  verified: true,
                  verificationDate: "2024-09-01T00:00:00Z",
                  certificates: [
                    "https://example.com/certs/solar-panel-cert.pdf",
                  ],
                },
                productionAsynchronous: true,
              },
            },
          ],
          "beckn:offers": [
            {
              "@context":
                "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
              "@type": "beckn:Offer",
              "beckn:id": offerId,
              "beckn:descriptor": {
                "@type": "beckn:Descriptor",
                "schema:name": "Bulk Solar Energy Offer",
              },
              "beckn:provider": "terrarex-provider-001",
              "beckn:items": [itemId],
              "beckn:price": {
                "@type": "schema:PriceSpecification",
                "schema:price": 1.45,
                "schema:priceCurrency": "INR",
                "schema:unitText": "kWh",
              },
              "beckn:offerAttributes": {
                "@context":
                  "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyTradeOffer/v0.2/context.jsonld",
                "@type": "EnergyTradeOffer",
                pricingModel: "PER_KWH",
                settlementType: "WEEKLY",
                wheelingCharges: {
                  amount: 1.2,
                  currency: "INR",
                  description: "Grid wheeling charge",
                },
                minimumQuantity: 1,
                maximumQuantity: 500,
                validityWindow: {
                  "@type": "beckn:TimePeriod",
                  "schema:startTime": new Date().toISOString(),
                  "schema:endTime": new Date(
                    Date.now() + 60 * 60 * 1000,
                  ).toISOString(), // 1 hour
                },
              },
            },
          ],
        },
      ],
    },
  };

  const response = await axios.post(
    "https://p2p.terrarexenergy.com/api/publish",
    data,
  );
  return response.data;
};

const findItemInCDS = async (itemId: string) => {
  const response = await axios.post(
    "https://p2p.terrarexenergy.com/bap/caller/discover",
    {
      context: createContext("discover", crypto.randomUUID(), {
        bppId: "p2p.terrarexenergy.com",
        bppUri: "https://p2p.terrarexenergy.com/bpp/receiver",
        location: {
          city: {
            code: "BLR",
            name: "Bangalore",
          },
          country: {
            code: "IND",
            name: "India",
          },
        },
      }),
      message: {
        filters: {
          type: "jsonpath",
          expression: `$[?(@.beckn:id == "${itemId}")]`,
        },
      },
    },
  );
  return response.data;
};

const selectItem = async (
  transactionId: string,
  item: any,
  quantity: number,
) => {
  const response = await axios.post(
    "https://p2p.terrarexenergy.com/api/select",
    {
      context: createContext("select", transactionId),
      message: {
        order: {
          "@context":
            "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
          "@type": "beckn:Order",
          "beckn:orderStatus": "CREATED",
          "beckn:seller": item["beckn:providerId"],
          "beckn:buyer": {
            "beckn:id": "buyer-terrarex-001",
            "@context":
              "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld",
            "@type": "beckn:Buyer",
          },
          "beckn:orderItems": [
            {
              "beckn:orderedItem": item["beckn:items"][0]["beckn:id"],
              "beckn:acceptedOffer": item["beckn:offers"][0],
              "beckn:orderItemAttributes": {
                "@context":
                  "https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyCustomer/v0.1/context.jsonld",
                "@type": "EnergyCustomer",
                meterId:
                  item["beckn:items"][0]["beckn:itemAttributes"]["meterId"],
                utilityCustomerId: "UTIL-CUST-77777",
              },
              "beckn:quantity": {
                unitQuantity: quantity,
                unitText: "kWh",
              },
            },
          ],
        },
      },
    },
  );
  return response.data;
};

const initItem = async (transactionId: string, selectResponse: any) => {
  const response = await axios.post("https://p2p.terrarexenergy.com/api/init", {
    context: createContext("init", transactionId),
    message: selectResponse.message,
  });
  return response.data;
};

const confirmItem = async (transactionId: string, initResponse: any) => {
  const response = await axios.post("https://p2p.terrarexenergy.com/api/confirm", {
    context: createContext("confirm", transactionId),
    message: initResponse.message,
  });
  return response.data;
};

const findTransactionInLedger = async (transactionId: string) => {
    const response = await axios.post("https://34.93.166.38.sslip.io/ledger/get", {
      transactionId,
      limit: 100,
      offset: 0,
      sort: "tradeTime",
      sortOrder: "desc",
    });
    return response.data
};

const main = async () => {
  const db = (await MongoClient.connect(MONGO_URI)).db(MONGO_DB);
  console.log("Database is connected...");

  const transactionId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const offerId = crypto.randomUUID();
  console.log("Transaction ID:", transactionId);
  console.log("Item ID:", itemId);
  console.log("Offer ID:", offerId);

  // Publish Catalog & Validate Catalog in database & Validate Catalog in CDS
  const catalog = await (async () => {
    const response = await publishEnergy({ itemId, offerId });

    if (response.success) {
      if (response.onix_forwarded) {
        console.log("Catalog is published successfully");
      } else {
        console.warn("Catalog is not forwarded to ONIX");
      }
    } else {
      console.error(response);
      throw new Error("Catalog couldn't be published");
    }

    {
      // Validate Catalog in database
      const catalog = await db.collection("catalogs").findOne(
        {},
        {
          sort: { _id: -1 },
        },
      );

      if (
        !catalog ||
        catalog["beckn:items"][0]["beckn:id"] !== itemId ||
        catalog["beckn:offers"][0]["beckn:id"] !== offerId
      ) {
        throw new Error("Catalog not found in database");
      }
      console.log("Catalog found in database");
    }

    // Validate Catalog in CDS
    {
      const cdsResponse = await findItemInCDS(itemId);
      const catalog = cdsResponse.message.catalogs[0];
      if (
        !cdsResponse ||
        catalog["beckn:items"][0]["beckn:id"] !== itemId ||
        catalog["beckn:offers"][0]["beckn:id"] !== offerId
      ) {
        throw new Error("Catalog not found in CDS");
      }
      console.log("Catalog found in CDS");

      return catalog;
    }
  })();

  // Select item
  const selectResponse = await (async () => {
    try {
      await selectItem(transactionId, catalog, 30);
      throw new Error("Insufficient quantity is selected");
    } catch (e) {
      if (
        isAxiosError(e) &&
        e.response?.data.error.details.code === "INSUFFICIENT_INVENTORY"
      ) {
        console.log("Insufficient quantity selection failed successfully");
      } else {
        throw e;
      }
    }

    const selectResponse = await selectItem(transactionId, catalog, 5);
    console.log("Item is selected successfully");
    return selectResponse;
  })();

  // Init item
  const initResponse = await (async () => {
    const initResponse = await initItem(transactionId, selectResponse);
    console.log("Order initiated successfully");
    return initResponse;
  })();

  // Check ledger - No entry should be present before confirmation
  {
    const entry = await findTransactionInLedger(transactionId);
    if(entry.count > 0) {
      throw new Error("No ledger entry found");
    }
  }

  const confirmResponse = await (async () => {
    const confirmResponse = await confirmItem(transactionId, initResponse);
    console.log("Order is confirmed successfully");
    return confirmResponse;
  })();
  
  // Check ledger - Entry should be present after confirmation
  const entry = await findTransactionInLedger(transactionId);
  if(entry.count === 0) {
    throw new Error("No ledger entry found");
  }

  console.log("Confirm Response", JSON.stringify(confirmResponse, null, 2));
  console.log("Ledger Entry", JSON.stringify(entry, null, 2));

};

main()
  .catch((e) => {
    if (isAxiosError(e)) {
      console.error(e.response?.data);
    } else {
      console.error(e);
    }
  })
  .finally(() => {
    process.exit(0);
  });
