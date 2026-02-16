import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "p2p_trading";

async function seedDiscoms() {
    const client = new MongoClient(MONGO_URI);

    try {
        await client.connect();
        console.log("Connected to MongoDB for seeding...");
        const db = client.db(DB_NAME);
        const collection = db.collection("discoms");

        const discoms = [
            {
                name: "BSES DELHI",
                link: "https://www.bsesdelhi.com/web/brpl/p-to-p-trading#social"
            },
            {
                name: "PASCHIMANCHAL",
                link: "https://vc.pvvnl.org/"
            },
            {
                name: "TATA POWER-DDL",
                link: "https://generatevc.tatapower-ddl.com/"
            }
        ];

        for (const discom of discoms) {
            let result = await collection.updateOne(
                { name: discom.name },   // check by unique field
                { $setOnInsert: discom },
                { upsert: true }
            );
            console.log(`Seeded ${result} discoms.`);
        }
        console.log("Seeding completed ");

    } catch (error) {
        console.error("Error seeding discoms:", error);
    } finally {
        await client.close();
        console.log("Disconnected from MongoDB.");
    }
}

seedDiscoms();
