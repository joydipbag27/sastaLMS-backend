import { model, Schema } from "mongoose";

const subscriptionSchema = new Schema(
  {
    razorpaySubscriptionId: {
      type: String,
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    planId: {
      type: String,
      required: true,
    },
    planKey: {
      type: String,
      required: true,
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "yearly"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "created",
        "active",
        "in_grace",
        "cancelled",
        "expired",
        "upgrading",
      ],
      default: "created",
    },
    currentPeriodStart: {
      type: Date,
      default: null,
    },
    currentPeriodEnd: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    gracePeriodEndsAt: {
      type: Date,
      default: null,
    },
    createdExpiresAt: {
      type: Date,
      required: function () {
        return this.status === "created";
      },
    },
    expiredAt: {
      type: Date,
      default: null,
    },
    upgradingTo: {
      type: String,
      default: null,
    },
    scheduledDowngradeTo: {
      type: String,
      default: null,
    },
    deletionWarningSent: {
      type: Boolean,
      default: false,
    },
    deletionScheduledAt: {
      type: Date,
      default: null,
    },
    filesDeleted: {
      type: Boolean,
      default: false,
    },
    filesDeletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    strict: "throw",
  },
);

subscriptionSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["active", "in_grace"] },
    },
  },
);

subscriptionSchema.index(
  { expiredAt: 1 },
  {
    expireAfterSeconds: 60 * 60 * 24 * 7,
  },
);

const Subscription = model("Subscription", subscriptionSchema);
export default Subscription;
