import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth.js";
import inviteRouter from "./invite.js";
import downloadRouter from "./download.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(downloadRouter);
router.use(authRouter);
router.use(inviteRouter);

export default router;
