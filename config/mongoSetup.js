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
    collMod: "subscriptions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: [
          "razorpaySubscriptionId",
          "userId",
          "planId",
          "planKey",
          "billingCycle",
          "status",
        ],
        properties: {
          razorpaySubscriptionId: { bsonType: "string" },
          userId: { bsonType: "objectId" },
          planId: { bsonType: "string" },
          planKey: { bsonType: "string" },
          billingCycle: { enum: ["monthly", "yearly"] },
          status: {
            enum: [
              "created",
              "active",
              "in_grace",
              "cancelled",
              "expired",
              "upgrading",
            ],
          },
          currentPeriodStart: { bsonType: ["date", "null"] },
          currentPeriodEnd: { bsonType: ["date", "null"] },
          cancelledAt: { bsonType: ["date", "null"] },
          cancelAtPeriodEnd: { bsonType: "bool" },
          gracePeriodEndsAt: { bsonType: ["date", "null"] },
          createdExpiresAt: { bsonType: ["date", "null"] },
          expiredAt: { bsonType: ["date", "null"] },
          deletionWarningSent: { bsonType: "bool" },
          deletionScheduledAt: { bsonType: ["date", "null"] },
          filesDeleted: { bsonType: "bool" },
          filesDeletedAt: { bsonType: ["date", "null"] },
        },
      },
    },
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

  await db.command({
    collMod: "notifications",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["userId", "type", "title", "message"],
        properties: {
          userId: { bsonType: "objectId" },
          type: { bsonType: "string" },
          title: { bsonType: "string" },
          message: { bsonType: "string" },
          metadata: {
            bsonType: "object",
            properties: {
              fileId: { bsonType: "objectId" },
              folderId: { bsonType: "objectId" },
              sharedBy: { bsonType: "objectId" },
              token: { bsonType: "string" },
            },
          },
          count: { bsonType: "int" },
          isRead: { bsonType: "bool" },
        },
      },
    },
  });

  // Indexes for users
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("users").createIndex({ username: 1 });

  // Indexes for subscriptions
  await db
    .collection("subscriptions")
    .createIndex({ expiredAt: 1 }, { expireAfterSeconds: 604800 });
  await db.collection("subscriptions").createIndex({ userId: 1 });
  await db.collection("subscriptions").createIndex(
    { userId: 1 },
    {
      unique: true,
      partialFilterExpression: { status: { $in: ["active", "in_grace"] } },
    },
  );

  // Indexes for otps
  await db.collection("otps").createIndex({ email: 1 }, { unique: true });
  await db
    .collection("otps")
    .createIndex({ email: 1, purpose: 1 }, { unique: true });
  await db
    .collection("otps")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Indexes for notifications
  await db.collection("notifications").createIndex({ userId: 1 });
  await db.collection("notifications").createIndex({ isRead: 1 });
  await db.collection("notifications").createIndex({ userId: 1, isRead: 1 });

  console.log("Database schema and index setup is completed");
} catch (error) {
  console.log("Error setting up the database", error);
} finally {
  await client.close();
}
