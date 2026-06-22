import { MB, GB, TB } from "../utils/bytes.js";

export const PLANS = [
  {
    planId: "spark_free",
    key: "spark_free",
    name: "Spark Free",
    family: "Spark",
    billingCycle: "monthly",
    price: 0,
    currency: "INR",

    storageBytes: 5 * GB,
    bandwidthMonthlyBytes: 10 * GB,

    maxFileSizeBytes: 150 * MB,
    maxBatchUploadBytes: 500 * MB,
    maxFilesPerBatch: 10,

    trashRecoveryDays: 5,

    tierLevel: 1,
    highlight: false,
    isActive: true,
  },

  {
    planId: "plan_SHwGNskQr7jqjE",
    key: "spark_go_monthly",
    name: "Spark Go",
    family: "Spark",
    billingCycle: "monthly",
    price: 39,
    currency: "INR",

    storageBytes: 50 * GB,
    bandwidthMonthlyBytes: 25 * GB,

    maxFileSizeBytes: 1 * GB,
    maxBatchUploadBytes: 5 * GB,
    maxFilesPerBatch: 25,

    trashRecoveryDays: 15,

    tierLevel: 2,
    highlight: false,
    isActive: true,
  },

  {
    planId: "plan_ShFhbiwTgFef5Q",
    key: "spark_go_yearly",
    name: "Spark Go",
    family: "Spark",
    billingCycle: "yearly",
    price: 399,
    currency: "INR",

    storageBytes: 50 * GB,
    bandwidthMonthlyBytes: 25 * GB,

    maxFileSizeBytes: 1 * GB,
    maxBatchUploadBytes: 5 * GB,
    maxFilesPerBatch: 25,

    trashRecoveryDays: 15,

    tierLevel: 3,
    highlight: false,
    isActive: true,
  },

  {
    planId: "plan_ShFiladnn6PgTD",
    key: "boost_monthly",
    name: "Boost",
    family: "Boost",
    billingCycle: "monthly",
    price: 149,
    currency: "INR",

    storageBytes: 100 * GB,
    bandwidthMonthlyBytes: 70 * GB,

    maxFileSizeBytes: 3 * GB,
    maxBatchUploadBytes: 10 * GB,
    maxFilesPerBatch: 40,

    trashRecoveryDays: 30,

    tierLevel: 4,
    highlight: false,
    isActive: true,
  },

  {
    planId: "plan_ShFjdSQ5Jz7PFC",
    key: "boost_yearly",
    name: "Boost",
    family: "Boost",
    billingCycle: "yearly",
    price: 1499,
    currency: "INR",

    storageBytes: 100 * GB,
    bandwidthMonthlyBytes: 70 * GB,

    maxFileSizeBytes: 3 * GB,
    maxBatchUploadBytes: 10 * GB,
    maxFilesPerBatch: 40,

    trashRecoveryDays: 30,

    tierLevel: 5,
    highlight: false,
    isActive: true,
  },

  {
    planId: "plan_ShFkp2U3bGn4vd",
    key: "pro_monthly",
    name: "Pro",
    family: "Pro",
    billingCycle: "monthly",
    price: 399,
    currency: "INR",

    storageBytes: 500 * GB,
    bandwidthMonthlyBytes: 300 * GB,

    maxFileSizeBytes: 5 * GB,
    maxBatchUploadBytes: 15 * GB,
    maxFilesPerBatch: 50,

    trashRecoveryDays: 45,

    tierLevel: 6,
    highlight: true,
    isActive: true,
  },

  {
    planId: "plan_ShFlt8jAjsOqoP",
    key: "pro_yearly",
    name: "Pro",
    family: "Pro",
    billingCycle: "yearly",
    price: 3999,
    currency: "INR",

    storageBytes: 500 * GB,
    bandwidthMonthlyBytes: 300 * GB,

    maxFileSizeBytes: 5 * GB,
    maxBatchUploadBytes: 15 * GB,
    maxFilesPerBatch: 50,

    trashRecoveryDays: 45,

    tierLevel: 7,
    highlight: true,
    isActive: true,
  },

  {
    planId: "plan_ShFnK3u5XbFNW1",
    key: "apex_monthly",
    name: "Apex",
    family: "Apex",
    billingCycle: "monthly",
    price: 699,
    currency: "INR",

    storageBytes: 1 * TB,
    bandwidthMonthlyBytes: 700 * GB,

    maxFileSizeBytes: 10 * GB,
    maxBatchUploadBytes: 30 * GB,
    maxFilesPerBatch: 75,

    trashRecoveryDays: 60,

    tierLevel: 8,
    highlight: false,
    isActive: true,
  },

  {
    planId: "plan_ShFohe6MLlTrmJ",
    key: "apex_yearly",
    name: "Apex",
    family: "Apex",
    billingCycle: "yearly",
    price: 6999,
    currency: "INR",

    storageBytes: 1 * TB,
    bandwidthMonthlyBytes: 700 * GB,

    maxFileSizeBytes: 10 * GB,
    maxBatchUploadBytes: 30 * GB,
    maxFilesPerBatch: 75,

    trashRecoveryDays: 60,

    tierLevel: 9,
    highlight: false,
    isActive: true,
  },
];
