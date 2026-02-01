
import { MongoClient } from 'mongodb';
import dotenv from "dotenv";
dotenv.config();

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017";

async function checkConnection() {
  console.log('Testing MongoDB Connection...');
  console.log(`URI: ${MONGO_URI.replace(/:([^:@]+)@/, ':****@')}`); // Mask password

  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log('✅ Successfully connected to MongoDB!');
  } catch (error: any) {
    console.error('❌ Connection Failed:', error);
    if (error.message.includes('SSL routines') && error.message.includes('internal error')) {
      console.error('\n⚠️  Possible Cause: Your IP address is likely not whitelisted in MongoDB Atlas.');
      console.error('   Please add your current IP to the Atlas Network Access whitelist.');
    }
  } finally {
    await client.close();
  }
}

checkConnection();
