import mongoose from "mongoose";
import { ConnectDB } from "./db.js";

await ConnectDB();
const client = mongoose.connection.getClient();

try {
  const db = mongoose.connection.db;

  await db.command({
    collMod: "users",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["_id", "username", "email", "isBlocked", "planId", "__v"],
        properties: {
          _id: {
            bsonType: "objectId",
          },
          username: {
            bsonType: "string",
            minLength: 3,
            maxLength: 100,
          },
          email: {
            bsonType: "string",
            pattern: "^[\\w.-]+@[a-zA-Z\\d.-]+\\.[a-zA-Z]{2,}$",
          },
          password: {
            bsonType: "string",
            minLength: 4,
          },
          rootDirId: {
            bsonType: "objectId",
          },
          __v: {
            bsonType: "int",
          },
          isBlocked: {
            bsonType: "bool",
          },
          role: {
            bsonType: "string",
            enum: ["Owner", "Admin", "Manager", "User"],
          },
          bandwidthUsedBytes: {
            bsonType: ["long", "int", "double"],
          },
          bandwidthCycleStart: {
            bsonType: ["date", "null"],
          },
          planId: {
            bsonType: "string",
          },
        },
        additionalProperties: false,
      },
    },
    validationAction: "error",
    validationLevel: "strict",
  });

  await db.command({
    collMod: "otps",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["email", "createdAt", "expiresAt", "purpose"],
        properties: {
          email: { bsonType: "string" },
          otp: { bsonType: "string" },
          createdAt: { bsonType: "date" },
          expiresAt: { bsonType: "date" },
          purpose: { enum: ["auth", "security"] },
          newEmail: { bsonType: "string" },
          newEmailOtp: { bsonType: "string" },
        },
      },
    },
  });

  // Indexes for users
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("users").createIndex({ username: 1 });

  // Indexes for otps
  await db.collection("otps").createIndex({ email: 1 }, { unique: true });
  await db
    .collection("otps")
    .createIndex({ email: 1, purpose: 1 }, { unique: true });
  await db
    .collection("otps")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  console.log("Database schema and index setup is completed");
} catch (error) {
  console.log("Error setting up the database", error);
} finally {
  await client.close();
}
