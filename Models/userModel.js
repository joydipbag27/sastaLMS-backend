import { Schema, model } from "mongoose";
import { MB } from "../utils/bytes.js";

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
      minLength: [3, "Username should be at least 3 characters long"],
      maxLength: 100,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      match: [
        /^[\w.-]+@[a-zA-Z\d.-]+\.[a-zA-Z]{2,}$/,
        "Please enter a valid email",
      ],
    },
    password: {
      type: String,
      trim: true,
      minLength: [4, "Password should be at least 4 characters long"],
    },
    rootDirId: {
      type: Schema.Types.ObjectId,
      required: false,
    },
    role: {
      type: String,
      enum: ["Admin", "Manager", "User", "Owner"],
      default: "User",
    },
    isBlocked: {
      type: Boolean,
      default: false,
      required: true,
    },
    bandwidthUsedBytes: {
      type: Number,
      default: 0,
    },
    bandwidthCycleStart: {
      type: Date,
      default: null,
    },
    planId: {
      type: String,
      default: "spark_free",
    },
  },
  {
    strict: "throw",
  },
);

userSchema.index({ username: 1, email: 1, _id: 1, isBlocked: 1, role: 1 });

const User = model("User", userSchema);
export default User;
