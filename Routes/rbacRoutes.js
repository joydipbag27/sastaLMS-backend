import express from "express";
import {
  adminReadPrivilegesAuth,
  adminWritePrivilegesAuth,
} from "../middlewares/authMiddleware.js";
import {
  adminBlock,
  adminDelete,
  adminLogout,
  changeRole,
  getAllUsers,
  getSessionStatus,
} from "../Controllers/rbacController.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.get("/", customRateLimit(1, 5), adminReadPrivilegesAuth, getAllUsers);

router.get(
  "/session/:id",
  customRateLimit(1, 20),
  adminReadPrivilegesAuth,
  getSessionStatus,
);

router.post(
  "/logout",
  customRateLimit(1, 1),
  adminReadPrivilegesAuth,
  adminLogout,
);

router.delete(
  "/delete",
  customRateLimit(1, 1),
  adminWritePrivilegesAuth,
  adminDelete,
);

router.patch(
  "/block",
  customRateLimit(1, 5),
  adminWritePrivilegesAuth,
  adminBlock,
);

router.patch(
  "/role",
  customRateLimit(1, 1),
  adminWritePrivilegesAuth,
  changeRole,
);

export default router;
